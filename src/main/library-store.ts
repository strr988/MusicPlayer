import { DatabaseSync } from 'node:sqlite'
import type { Track } from '../shared/contracts'
import type { FileIdentity } from './local-file'

const migrations = [
  `CREATE TABLE tracks (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    duration_seconds REAL CHECK (duration_seconds > 0),
    genres TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('mp3', 'flac'))
  ) STRICT;
  CREATE TABLE sources (
    id TEXT PRIMARY KEY NOT NULL,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    UNIQUE (provider, provider_id)
  ) STRICT;
  CREATE INDEX sources_by_track ON sources(track_id);
  CREATE TABLE local_files (
    source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id) ON UPDATE CASCADE ON DELETE CASCADE,
    dev TEXT NOT NULL,
    ino TEXT NOT NULL,
    birthtime_ns TEXT NOT NULL,
    size TEXT NOT NULL,
    mtime_ns TEXT NOT NULL,
    ctime_ns TEXT NOT NULL
  ) STRICT;
  CREATE TABLE imported_folders (
    path TEXT PRIMARY KEY NOT NULL
  ) STRICT;`,
]

export interface LocalSource {
  id: string
  trackId: string
  path: string
  format: Track['format']
  available: boolean
  identity: FileIdentity
}

interface LocalSourceRow {
  id: string
  track_id: string
  provider_id: string
  format: Track['format']
  available: number
  dev: string
  ino: string
  birthtime_ns: string
  size: string
  mtime_ns: string
  ctime_ns: string
}

export interface ScanEntry {
  track: Track
  source: Omit<LocalSource, 'available'>
  previousSourceId?: string
}

const selectLocalSources = `SELECT s.id, s.track_id, s.provider_id, s.available, t.format,
  f.dev, f.ino, f.birthtime_ns, f.size, f.mtime_ns, f.ctime_ns
  FROM sources s JOIN tracks t ON t.id = s.track_id
  JOIN local_files f ON f.source_id = s.id WHERE s.provider = 'local'`

function toLocalSource(row: LocalSourceRow): LocalSource {
  return {
    id: row.id,
    trackId: row.track_id,
    path: row.provider_id,
    format: row.format,
    available: row.available === 1,
    identity: {
      dev: BigInt(row.dev), ino: BigInt(row.ino), birthtimeNs: BigInt(row.birthtime_ns),
      size: BigInt(row.size), mtimeNs: BigInt(row.mtime_ns), ctimeNs: BigInt(row.ctime_ns),
    },
  }
}

export class LibraryStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 1_000 })
    try {
      this.transaction(() => {
        const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
        if (version < 0 || version > migrations.length) throw new Error(`Unsupported library schema ${version}`)
        for (let index = version; index < migrations.length; index++) {
          this.db.exec(migrations[index])
          this.db.exec(`PRAGMA user_version = ${index + 1}`)
        }
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  getTracks(): Track[] {
    const rows = this.db.prepare(`SELECT id, title, artist, album, duration_seconds AS durationSeconds,
      genres, format FROM tracks ORDER BY rowid`).all() as unknown as (Omit<Track, 'genres'> & { genres: string })[]
    return rows.map((row) => ({ ...row, genres: JSON.parse(row.genres) as string[] }))
  }

  getLocalSources(): LocalSource[] {
    return (this.db.prepare(selectLocalSources).all() as unknown as LocalSourceRow[]).map(toLocalSource)
  }

  getLocalSource(id: string): LocalSource | undefined {
    const row = this.db.prepare(`${selectLocalSources} AND s.id = ?`).get(id) as LocalSourceRow | undefined
    return row && toLocalSource(row)
  }

  getSourceId(trackId: string): string | undefined {
    const row = this.db.prepare(`SELECT id FROM sources WHERE track_id = ? AND provider = 'local'
      ORDER BY available DESC, rowid LIMIT 1`).get(trackId) as { id: string } | undefined
    return row?.id
  }

  setAvailability(status: ReadonlyMap<string, boolean>): void {
    this.transaction(() => this.writeAvailability(status))
  }

  setSourceAvailability(id: string, available: boolean): void {
    this.db.prepare('UPDATE sources SET available = ? WHERE id = ?').run(Number(available), id)
  }

  saveScan(folder: string, entries: ScanEntry[], availability: ReadonlyMap<string, boolean>): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO imported_folders (path) VALUES (?) ON CONFLICT DO NOTHING').run(folder)
      const writeTrack = this.db.prepare(`INSERT INTO tracks (id, title, artist, album, duration_seconds, genres, format)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET title = excluded.title, artist = excluded.artist,
        album = excluded.album, duration_seconds = excluded.duration_seconds,
        genres = excluded.genres, format = excluded.format`)
      const addSource = this.db.prepare(`INSERT INTO sources (id, track_id, provider, provider_id, available)
        VALUES (?, ?, 'local', ?, 1)`)
      const updateSource = this.db.prepare('UPDATE sources SET id = ?, provider_id = ?, available = 1 WHERE id = ?')
      const writeFile = this.db.prepare(`INSERT INTO local_files (source_id, dev, ino, birthtime_ns, size, mtime_ns, ctime_ns)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id) DO UPDATE SET dev = excluded.dev, ino = excluded.ino,
        birthtime_ns = excluded.birthtime_ns, size = excluded.size,
        mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns`)

      for (const { track, source, previousSourceId } of entries) {
        writeTrack.run(track.id, track.title, track.artist, track.album,
          track.durationSeconds, JSON.stringify(track.genres), track.format)
        if (previousSourceId) updateSource.run(source.id, source.path, previousSourceId)
        else addSource.run(source.id, source.trackId, source.path)
        const { dev, ino, birthtimeNs, size, mtimeNs, ctimeNs } = source.identity
        writeFile.run(source.id, String(dev), String(ino), String(birthtimeNs), String(size), String(mtimeNs), String(ctimeNs))
      }
      this.writeAvailability(availability)
    })
  }

  private writeAvailability(status: ReadonlyMap<string, boolean>): void {
    const update = this.db.prepare('UPDATE sources SET available = ? WHERE id = ? AND available <> ?')
    for (const [id, available] of status) update.run(Number(available), id, Number(available))
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
}
