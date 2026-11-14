import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { audioFormats, builtInCursors, defaultInterfaceScale, defaultSoundSettings, defaultWavePulse, interfaceScales, maxWavePulse, playerOrigin, playlistNameLimit, soundEffects } from '../shared/contracts'
import type { CursorPreset, CursorSettings, LyricsMode, Track, LibraryTrack, ListeningData, ListeningDataReader, PlaybackEventInput, PlaybackSession, Playlist, TrackPreference, VolumePreference, WaveMode } from '../shared/contracts'
import type { FileIdentity } from './local-file'
import { validatePlaybackSession } from './playback-session'
import { removeLegacyDemo } from './legacy-demo'
import type { InterfaceScale, ShortcutAction, SoundEffect, SoundSettings, Theme } from '../shared/contracts'

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
  `CREATE TABLE mini_player (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1))
  ) STRICT;
  INSERT INTO mini_player VALUES (1, 0);
  CREATE TABLE global_shortcuts (
    action TEXT PRIMARY KEY NOT NULL CHECK (action IN ('toggle', 'next', 'previous', 'volumeUp', 'volumeDown', 'mute')),
    accelerator TEXT NOT NULL UNIQUE
  ) STRICT;`,
  removeLegacyDemo,
  `CREATE TABLE appearance_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    wave_pulse INTEGER NOT NULL CHECK (wave_pulse BETWEEN 0 AND ${maxWavePulse})
  ) STRICT;
  INSERT INTO appearance_settings VALUES (1, ${defaultWavePulse});`,
  `ALTER TABLE appearance_settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark'
    CHECK (theme IN ('dark', 'light'));`,
  `ALTER TABLE appearance_settings ADD COLUMN interface_scale INTEGER NOT NULL DEFAULT ${defaultInterfaceScale}
    CHECK (interface_scale IN (${interfaceScales.join(', ')}));
  CREATE TABLE playback_effect (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    effect TEXT NOT NULL CHECK (effect IN (${soundEffects.map(effect => `'${effect}'`).join(', ')}))
  ) STRICT;
  INSERT INTO playback_effect VALUES (1, 'original');`,
  `ALTER TABLE appearance_settings ADD COLUMN disco INTEGER NOT NULL DEFAULT 0 CHECK (disco IN (0, 1));
  CREATE TABLE preset_reverb (
    effect TEXT PRIMARY KEY CHECK (effect IN (${soundEffects.map(effect => `'${effect}'`).join(', ')})),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
  ) STRICT;`,
  migrateAudioFormats,
]

function migrateAudioFormats(db: DatabaseSync): void {
  db.exec(`CREATE TABLE tracks_new (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    duration_seconds REAL CHECK (duration_seconds > 0),
    genres TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN (${audioFormats.map(format => `'${format}'`).join(', ')}))
  ) STRICT;
  INSERT INTO tracks_new SELECT * FROM tracks ORDER BY rowid;
  DROP TABLE tracks;
  ALTER TABLE tracks_new RENAME TO tracks;
  ALTER TABLE sources ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1));
  CREATE TABLE cursor_presets (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    arrow BLOB NOT NULL,
    arrow_x INTEGER NOT NULL,
    arrow_y INTEGER NOT NULL,
    pointer BLOB NOT NULL,
    pointer_x INTEGER NOT NULL,
    pointer_y INTEGER NOT NULL
  ) STRICT;
  ALTER TABLE appearance_settings ADD COLUMN cursor_preset TEXT NOT NULL DEFAULT 'mustplay';
  ALTER TABLE appearance_settings ADD COLUMN lyrics_mode TEXT NOT NULL DEFAULT 'read' CHECK (lyrics_mode IN ('read', 'sync'));`)
}

export type CursorImage = { png: Uint8Array<ArrayBuffer>; x: number; y: number }
const cursorLabels = { mustplay: 'mustplay', contrast: 'Контрастный', system: 'Системный (без кастомного)' }

export interface LocalSource {
  id: string
  trackId: string
  path: string
  format: Track['format']
  available: boolean
  excluded: boolean
  identity: FileIdentity
}

interface LocalSourceRow {
  id: string
  track_id: string
  provider_id: string
  format: Track['format']
  available: number
  excluded: number
  dev: string
  ino: string
  birthtime_ns: string
  size: string
  mtime_ns: string
  ctime_ns: string
}

export interface ScanEntry {
  track: Track
  source: Omit<LocalSource, 'available' | 'excluded'>
  previousSourceId?: string
}

const selectLocalSources = `SELECT s.id, s.track_id, s.provider_id, s.available, s.excluded, t.format,
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
    excluded: row.excluded === 1,
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
      const audioMigration = migrations.indexOf(migrateAudioFormats)
      const upgrade = (from: number, to: number) => this.transaction(() => {
        for (let index = from; index < to; index++) {
          const migration = migrations[index]
          if (typeof migration === 'string') this.db.exec(migration)
          else migration(this.db)
          this.db.exec(`PRAGMA user_version = ${index + 1}`)
        }
        if (from === audioMigration && this.db.prepare('PRAGMA foreign_key_check').get()) {
          throw new Error('Invalid library references')
        }
      })
      if (version < audioMigration) upgrade(version, audioMigration)
      if (version <= audioMigration) {
        // Rebuild the parent table without cascading deletes. Earlier migrations still enforce foreign keys.
        this.db.exec('PRAGMA foreign_keys = OFF')
        upgrade(audioMigration, audioMigration + 1)
        this.db.exec('PRAGMA foreign_keys = ON')
      }
      if (migrations.length > audioMigration + 1) upgrade(Math.max(version, audioMigration + 1), migrations.length)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  getLyricsMode(): LyricsMode {
    return this.db.prepare('SELECT lyrics_mode FROM appearance_settings WHERE id = 1').get()?.lyrics_mode === 'sync' ? 'sync' : 'read'
  }

  setLyricsMode(mode: LyricsMode): void {
    this.db.prepare('UPDATE appearance_settings SET lyrics_mode = ? WHERE id = 1').run(mode)
  }

  getCursorSettings(): CursorSettings {
    const custom = this.db.prepare('SELECT id, label, arrow_x, arrow_y, pointer_x, pointer_y FROM cursor_presets ORDER BY rowid').all()
      .map(row => ({ id: row.id as string, label: row.label as string,
        arrow: { x: row.arrow_x as number, y: row.arrow_y as number },
        pointer: { x: row.pointer_x as number, y: row.pointer_y as number } }))
    const presets: CursorPreset[] = [...builtInCursors.map(id => ({ id, label: cursorLabels[id] })), ...custom]
    const selected = this.db.prepare('SELECT cursor_preset FROM appearance_settings WHERE id = 1').get()?.cursor_preset
    return { selected: presets.find(preset => preset.id === selected) ?? presets[0], presets }
  }

  setCursorPreset(id: string): void {
    if (!builtInCursors.some(value => value === id) && !this.db.prepare('SELECT 1 FROM cursor_presets WHERE id = ?').get(id)) {
      throw new Error('Unknown cursor preset')
    }
    this.db.prepare('UPDATE appearance_settings SET cursor_preset = ? WHERE id = 1').run(id)
  }

  importCursorPreset(id: string, label: string, arrow: CursorImage, pointer: CursorImage): void {
    this.transaction(() => {
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM cursor_presets').get()?.count as number
      if (count >= 32) throw new Error('Cursor preset limit reached')
      this.db.prepare('INSERT INTO cursor_presets VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, label, arrow.png, arrow.x, arrow.y, pointer.png, pointer.x, pointer.y)
      this.setCursorPreset(id)
    })
  }

  readCursorImage(id: string, kind: 'arrow' | 'pointer'): Uint8Array<ArrayBuffer> | undefined {
    const row = this.db.prepare(`SELECT ${kind} AS png FROM cursor_presets WHERE id = ?`).get(id)
    return row?.png as Uint8Array<ArrayBuffer> | undefined
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

  getMiniPinned(): boolean {
    return this.db.prepare('SELECT pinned FROM mini_player WHERE id = 1').get()?.pinned === 1
  }

  getWavePulse(): number {
    return this.db.prepare('SELECT wave_pulse FROM appearance_settings WHERE id = 1').get()!.wave_pulse as number
  }

  setWavePulse(intensity: number): void {
    this.db.prepare('UPDATE appearance_settings SET wave_pulse = ? WHERE id = 1').run(intensity)
  }

  getTheme(): Theme {
    return this.db.prepare('SELECT theme FROM appearance_settings WHERE id = 1').get()!.theme as Theme
  }

  setTheme(theme: Theme): void {
    this.db.prepare('UPDATE appearance_settings SET theme = ? WHERE id = 1').run(theme)
  }

  getInterfaceScale(): InterfaceScale {
    return this.db.prepare('SELECT interface_scale FROM appearance_settings WHERE id = 1').get()!.interface_scale as InterfaceScale
  }

  setInterfaceScale(scale: InterfaceScale): void {
    this.db.prepare('UPDATE appearance_settings SET interface_scale = ? WHERE id = 1').run(scale)
  }

  getSoundEffect(): SoundSettings {
    const { effect } = this.db.prepare('SELECT effect FROM playback_effect WHERE id = 1').get()!
    const reverb = { ...defaultSoundSettings.reverb }
    for (const row of this.db.prepare('SELECT effect, enabled FROM preset_reverb').all()) {
      reverb[row.effect as SoundEffect] = row.enabled === 1
    }
    return { effect: effect as SoundEffect, reverb }
  }

  setSoundEffect(effect: SoundEffect): void {
    this.db.prepare('UPDATE playback_effect SET effect = ? WHERE id = 1').run(effect)
  }

  setReverb(effect: SoundEffect, enabled: boolean): void {
    this.db.prepare('INSERT INTO preset_reverb VALUES (?, ?) ON CONFLICT(effect) DO UPDATE SET enabled = excluded.enabled')
      .run(effect, Number(enabled))
  }

  getDiscoMode(): boolean {
    return this.db.prepare('SELECT disco FROM appearance_settings WHERE id = 1').get()?.disco === 1
  }

  setDiscoMode(enabled: boolean): void {
    this.db.prepare('UPDATE appearance_settings SET disco = ? WHERE id = 1').run(Number(enabled))
  }

  setMiniPinned(pinned: boolean): void {
    this.db.prepare('UPDATE mini_player SET pinned = ? WHERE id = 1').run(Number(pinned))
  }

  getShortcuts(): Partial<Record<ShortcutAction, string>> {
    const rows = this.db.prepare('SELECT action, accelerator FROM global_shortcuts').all()
    return Object.fromEntries(rows.map(row => [row.action, row.accelerator]))
  }

  setShortcut(action: ShortcutAction, accelerator: string | null): void {
    if (accelerator === null) this.db.prepare('DELETE FROM global_shortcuts WHERE action = ?').run(action)
    else this.db.prepare(`INSERT INTO global_shortcuts VALUES (?, ?)
      ON CONFLICT (action) DO UPDATE SET accelerator = excluded.accelerator`).run(action, accelerator)
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
      genres, format, EXISTS (SELECT 1 FROM sources WHERE track_id = t.id AND provider = 'local' AND excluded = 0 AND available = 1) AS available,
      (SELECT id FROM sources WHERE track_id = t.id AND provider = 'local' AND excluded = 0
        ORDER BY available DESC, rowid LIMIT 1) AS sourceId FROM tracks t WHERE EXISTS (SELECT 1 FROM sources s
        WHERE s.track_id = t.id AND s.provider = 'local' AND s.excluded = 0) ORDER BY t.rowid`)
      .all() as unknown as (Omit<Track, 'genres'> & { genres: string; sourceId: string | null; available: number })[]
    return rows.map(({ sourceId, genres, available, ...row }) => ({
      ...row, genres: JSON.parse(genres) as string[],
      artworkUrl: sourceId ? `${playerOrigin}/artwork/${sourceId}` : null,
      available: available === 1,
    }))
  }

  getExcludedTrackIds(): ReadonlySet<string> {
    return new Set(this.db.prepare(`SELECT DISTINCT track_id FROM sources s WHERE excluded = 1
      AND NOT EXISTS (SELECT 1 FROM sources active WHERE active.track_id = s.track_id AND active.excluded = 0)`)
      .all().map(row => row.track_id as string))
  }

  getLocalSources(includeExcluded = false): LocalSource[] {
    return (this.db.prepare(selectLocalSources + (includeExcluded ? '' : ' AND s.excluded = 0')).all() as unknown as LocalSourceRow[]).map(toLocalSource)
  }

  getImportedFolders(): string[] {
    return this.db.prepare('SELECT path FROM imported_folders ORDER BY rowid').all().map(row => row.path as string)
  }

  removeImportedFolder(path: string, exclude: string[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM imported_folders WHERE path = ?').run(path)
      const update = this.db.prepare('UPDATE sources SET excluded = 1, available = 0 WHERE id = ?')
      for (const id of exclude) update.run(id)
    })
  }

  getLocalSource(id: string): LocalSource | undefined {
    const row = this.db.prepare(`${selectLocalSources} AND s.id = ? AND s.excluded = 0`).get(id) as LocalSourceRow | undefined
    return row && toLocalSource(row)
  }

  getSourceId(trackId: string): string | undefined {
    const row = this.db.prepare(`SELECT id FROM sources WHERE track_id = ? AND provider = 'local' AND excluded = 0
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
      const updateSource = this.db.prepare('UPDATE sources SET id = ?, provider_id = ?, available = 1, excluded = 0 WHERE id = ?')
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
