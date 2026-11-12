import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { playerOrigin, playlistNameLimit } from '../shared/contracts'
import type { Track, LibraryTrack, ListeningData, ListeningDataReader, PlaybackEventInput, PlaybackSession, Playlist, TrackPreference, VolumePreference, WaveMode } from '../shared/contracts'
import type { FileIdentity } from './local-file'
import { validatePlaybackSession } from './playback-session'
import type { MetadataEdits, SourceMetadata } from '../shared/music-sources'

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
  `CREATE TABLE track_preferences (
    track_id TEXT PRIMARY KEY NOT NULL REFERENCES tracks(id),
    liked INTEGER NOT NULL CHECK (liked IN (0, 1)), updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE playback_events (
    session_id TEXT NOT NULL, track_id TEXT NOT NULL REFERENCES tracks(id),
    type TEXT NOT NULL CHECK (type IN ('started', 'completed', 'skipped', 'ended', 'error')),
    listened_seconds REAL NOT NULL CHECK (listened_seconds >= 0), timestamp TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX one_start_per_session ON playback_events(session_id) WHERE type = 'started';
  CREATE UNIQUE INDEX one_terminal_per_session ON playback_events(session_id) WHERE type <> 'started';`,
  `CREATE TABLE playback_volume (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    level REAL NOT NULL CHECK (level BETWEEN 0 AND 1),
    muted INTEGER NOT NULL CHECK (muted IN (0, 1))
  ) STRICT;
  INSERT INTO playback_volume VALUES (1, 1, 0);`,
  `CREATE TABLE playlists (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${playlistNameLimit})
  ) STRICT;
  CREATE TABLE playlist_items (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (playlist_id, track_id),
    UNIQUE (playlist_id, position)
  ) STRICT;
  CREATE TABLE wave_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL CHECK (mode IN ('familiar', 'balance', 'discovery'))
  ) STRICT;
  INSERT INTO wave_settings VALUES (1, 'balance');`,
  `CREATE TABLE playback_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot TEXT NOT NULL
  ) STRICT;`,
  `CREATE TABLE external_recordings (
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    track_id TEXT NOT NULL UNIQUE REFERENCES tracks(id),
    metadata TEXT NOT NULL,
    edits TEXT NOT NULL,
    cover BLOB,
    PRIMARY KEY (provider, provider_id)
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

export class LibraryStore implements ListeningDataReader {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 1_000 })
    try {
      const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version < 0 || version > migrations.length) throw new Error(`Unsupported library schema ${version}`)
      if (version > 0 && version < migrations.length && path !== ':memory:') {
        const backupPath = `${path}.v${version}-${randomUUID()}.backup`
        this.db.prepare('VACUUM INTO ?').run(backupPath)
        using backup = new DatabaseSync(backupPath, { readOnly: true })
        if (backup.prepare('PRAGMA user_version').get()?.user_version !== version ||
            backup.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') {
          throw new Error('Library backup verification failed')
        }
      }
      this.transaction(() => {
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

  getPlaybackSession(): PlaybackSession | null {
    const row = this.db.prepare('SELECT snapshot FROM playback_session WHERE id = 1').get()
    return row ? validatePlaybackSession(JSON.parse(row.snapshot as string)) : null
  }

  setPlaybackSession(session: PlaybackSession): void {
    this.db.prepare(`INSERT INTO playback_session VALUES (1, ?)
      ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot`).run(JSON.stringify(session))
  }

  getListeningData(): ListeningData {
    const preferences = this.db.prepare(`SELECT track_id AS trackId, liked, updated_at AS updatedAt
      FROM track_preferences ORDER BY track_id`).all() as unknown as (Omit<TrackPreference, 'liked'> & { liked: number })[]
    return {
      preferences: preferences.map(row => ({ ...row, liked: row.liked === 1 })),
      events: this.db.prepare(`SELECT session_id AS sessionId, track_id AS trackId, type,
        listened_seconds AS listenedSeconds, timestamp FROM playback_events ORDER BY rowid`).all() as unknown as ListeningData['events'],
    }
  }

  setTrackPreference(trackId: string, liked: boolean): TrackPreference {
    const updatedAt = new Date().toISOString()
    this.db.prepare(`INSERT INTO track_preferences VALUES (?, ?, ?)
      ON CONFLICT(track_id) DO UPDATE SET liked = excluded.liked, updated_at = excluded.updated_at`)
      .run(trackId, Number(liked), updatedAt)
    return { trackId, liked, updatedAt }
  }

  recordPlaybackEvent(event: PlaybackEventInput): void {
    this.transaction(() => {
      const rows = this.db.prepare(`SELECT track_id, type FROM playback_events
        WHERE session_id = ?`).all(event.sessionId) as { track_id: string; type: string }[]
      if (rows.some(row => row.track_id !== event.trackId)) throw new Error('Session track mismatch')
      if (rows.some(row => row.type === event.type)) return
      if (rows.some(row => row.type !== 'started')) throw new Error('Session already finished')
      if (event.type !== 'started' && event.type !== 'error' && rows.length === 0) throw new Error('Session not started')
      if (event.type === 'started' && event.listenedSeconds !== 0) throw new Error('Invalid start duration')
      this.db.prepare('INSERT INTO playback_events VALUES (?, ?, ?, ?, ?)')
        .run(event.sessionId, event.trackId, event.type, event.listenedSeconds, new Date().toISOString())
    })
  }

  getVolume(): VolumePreference {
    const { level, muted } = this.db.prepare('SELECT level, muted FROM playback_volume WHERE id = 1')
      .get() as { level: number; muted: number }
    return { level, muted: muted === 1 }
  }

  setVolume({ level, muted }: VolumePreference): void {
    this.db.prepare('UPDATE playback_volume SET level = ?, muted = ? WHERE id = 1').run(level, Number(muted))
  }

  getWaveMode(): WaveMode {
    const { mode } = this.db.prepare('SELECT mode FROM wave_settings WHERE id = 1').get() as { mode: WaveMode }
    return mode
  }

  setWaveMode(mode: WaveMode): void {
    this.db.prepare('UPDATE wave_settings SET mode = ? WHERE id = 1').run(mode)
  }

  getPlaylists(): Playlist[] {
    const rows = this.db.prepare(`SELECT p.id, p.name, i.track_id AS trackId
      FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id = p.id
      ORDER BY p.rowid, i.position`).all() as { id: string; name: string; trackId: string | null }[]
    const playlists = new Map<string, Playlist>()
    for (const { id, name, trackId } of rows) {
      let playlist = playlists.get(id)
      if (!playlist) {
        playlist = { id, name, trackIds: [] }
        playlists.set(id, playlist)
      }
      if (trackId !== null) playlist.trackIds.push(trackId)
    }
    return [...playlists.values()]
  }

  createPlaylist(name: string): Playlist {
    const id = randomUUID()
    this.db.prepare('INSERT INTO playlists (id, name) VALUES (?, ?)').run(id, name)
    return { id, name, trackIds: [] }
  }

  renamePlaylist(id: string, name: string): void {
    const result = this.db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, id)
    if (!result.changes) throw new Error('Playlist not found')
  }

  deletePlaylist(id: string): void {
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
  }

  addPlaylistTrack(id: string, trackId: string): Playlist {
    this.db.prepare(`INSERT INTO playlist_items (playlist_id, track_id, position)
      SELECT ?, ?, COALESCE(MAX(position) + 1, 0) FROM playlist_items WHERE playlist_id = ?
      ON CONFLICT (playlist_id, track_id) DO NOTHING`).run(id, trackId, id)
    return this.getPlaylist(id)
  }

  removePlaylistTrack(id: string, trackId: string): Playlist {
    this.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND track_id = ?').run(id, trackId)
    return this.getPlaylist(id)
  }

  movePlaylistTrack(id: string, trackId: string, offset: -1 | 1): Playlist {
    return this.transaction(() => {
      const playlist = this.getPlaylist(id)
      const index = playlist.trackIds.indexOf(trackId)
      if (index < 0) throw new Error('Playlist track not found')
      const neighbor = playlist.trackIds[index + offset]
      if (!neighbor) return playlist
      const position = this.db.prepare('SELECT position FROM playlist_items WHERE playlist_id = ? AND track_id = ?')
      const from = position.get(id, trackId)!.position as number
      const to = position.get(id, neighbor)!.position as number
      const move = this.db.prepare('UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND track_id = ?')
      const { spare } = this.db.prepare('SELECT MAX(position) + 1 AS spare FROM playlist_items WHERE playlist_id = ?')
        .get(id) as { spare: number }
      // Use a free position to preserve the unique constraint during the swap.
      move.run(spare, id, trackId)
      move.run(from, id, neighbor)
      move.run(to, id, trackId)
      return this.getPlaylist(id)
    })
  }

  private getPlaylist(id: string): Playlist {
    const playlist = this.db.prepare('SELECT name FROM playlists WHERE id = ?').get(id) as { name: string } | undefined
    if (!playlist) throw new Error('Playlist not found')
    const rows = this.db.prepare('SELECT track_id FROM playlist_items WHERE playlist_id = ? ORDER BY position')
      .all(id) as { track_id: string }[]
    return { id, name: playlist.name, trackIds: rows.map(row => row.track_id) }
  }

  getTracks(): LibraryTrack[] {
    const rows = this.db.prepare(`SELECT t.id, title, artist, album, duration_seconds AS durationSeconds,
      genres, format, EXISTS (SELECT 1 FROM sources WHERE track_id = t.id AND provider = 'local' AND available = 1) AS available,
      (SELECT id FROM sources WHERE track_id = t.id AND provider = 'local'
        ORDER BY available DESC, rowid LIMIT 1) AS sourceId FROM tracks t ORDER BY t.rowid`)
      .all() as unknown as (Omit<Track, 'genres'> & { genres: string; sourceId: string | null; available: number })[]
    return rows.map(({ sourceId, genres, available, ...row }) => ({
      ...row, genres: JSON.parse(genres) as string[],
      artworkUrl: sourceId ? `${playerOrigin}/artwork/${sourceId}` : null,
      available: available === 1,
    }))
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

  getExternalTrackId(provider: string, sourceId: string): string | undefined {
    const row = this.db.prepare('SELECT track_id FROM external_recordings WHERE provider = ? AND provider_id = ?')
      .get(provider, sourceId) as { track_id: string } | undefined
    return row?.track_id
  }

  getDownloadCover(trackId: string): Uint8Array | null | undefined {
    const row = this.db.prepare('SELECT cover FROM external_recordings WHERE track_id = ?')
      .get(trackId) as { cover: Uint8Array | null } | undefined
    return row?.cover
  }

  isExternalRecording(trackId: string): boolean {
    return this.db.prepare('SELECT 1 FROM external_recordings WHERE track_id = ?').get(trackId) !== undefined
  }

  saveExternalRecording(entry: ScanEntry, metadata: SourceMetadata, edits: MetadataEdits, cover: Uint8Array | null): string {
    return this.transaction(() => {
      const existing = this.getExternalTrackId(metadata.provider, metadata.sourceId)
      if (existing) return existing
      this.writeEntries([entry])
      this.db.prepare('INSERT INTO external_recordings VALUES (?, ?, ?, ?, ?, ?)')
        .run(metadata.provider, metadata.sourceId, entry.track.id, JSON.stringify(metadata), JSON.stringify(edits), cover)
      return entry.track.id
    })
  }

  saveScan(folder: string, entries: ScanEntry[], availability: ReadonlyMap<string, boolean>): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO imported_folders (path) VALUES (?) ON CONFLICT DO NOTHING').run(folder)
      this.writeEntries(entries)
      this.writeAvailability(availability)
    })
  }

  private writeEntries(entries: ScanEntry[]): void {
    const writeTrack = this.db.prepare(`INSERT INTO tracks (id, title, artist, album, duration_seconds, genres, format)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET title = excluded.title, artist = excluded.artist,
      album = excluded.album, duration_seconds = excluded.duration_seconds,
      genres = excluded.genres, format = excluded.format
      WHERE NOT EXISTS (SELECT 1 FROM external_recordings WHERE track_id = excluded.id)`)
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
