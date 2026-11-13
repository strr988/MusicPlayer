import { mkdtempSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import type { PlaybackSession } from '../shared/contracts'
import { LibraryStore } from './library-store'
import { filterPlaybackSession, validatePlaybackSession } from './playback-session'
import { removeLegacyDemo } from './legacy-demo'

export const localLibraryFile = 'library-player-experience.sqlite3'

function exists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) !== undefined
}

function isExperimentalLibrary(path: string): boolean {
  using db = new DatabaseSync(path, { readOnly: true })
  const { user_version: version } = db.prepare('PRAGMA user_version').get()!
  if (version !== 6 && version !== 7) return false
  const tables = db.prepare('PRAGMA main.table_list').all()
    .filter(row => row.type === 'table' && row.strict === 1)
  const names = new Set(tables.map(row => row.name))
  return names.has('playback_session') && !names.has('mini_player') && !names.has('global_shortcuts') &&
    (names.has('external_recordings') || (names.has('stream_tracks') && names.has('stream_settings')))
}

function localSession(raw: string, trackIds: ReadonlySet<string>): PlaybackSession | null {
  try {
    const parsed = JSON.parse(raw)
    const queue = parsed.queue
    if (queue.source?.type !== 'library' && queue.source?.type !== 'wave' && queue.source?.type !== 'playlist') {
      queue.source = { type: 'library' }
    }
    return filterPlaybackSession(validatePlaybackSession(parsed), id => trackIds.has(id))
  } catch {
    // A malformed session should not prevent recovery of the local library.
    return null
  }
}

function importLocalLibrary(source: string, target: string): void {
  new LibraryStore(target).close()
  using db = new DatabaseSync(target, { timeout: 1_000 })
  db.exec('PRAGMA trusted_schema = OFF')
  const uri = pathToFileURL(source)
  uri.searchParams.set('mode', 'ro')
  db.prepare('ATTACH DATABASE ? AS previous').run(uri.href)
  db.exec(`BEGIN;
    CREATE TEMP VIEW local_sources AS
      SELECT s.id, s.track_id, s.provider, s.provider_id, s.available FROM previous.sources s
      JOIN previous.local_files f ON f.source_id = s.id WHERE s.provider = 'local';
    INSERT INTO main.tracks (id, title, artist, album, duration_seconds, genres, format)
      SELECT t.id, t.title, t.artist, t.album, t.duration_seconds, t.genres, t.format
      FROM previous.tracks t WHERE t.format IN ('mp3', 'flac')
      AND EXISTS (SELECT 1 FROM local_sources s WHERE s.track_id = t.id) ORDER BY t.rowid;
    INSERT INTO main.sources (id, track_id, provider, provider_id, available)
      SELECT s.id, s.track_id, s.provider, s.provider_id, s.available FROM previous.sources s
      JOIN local_sources l ON l.id = s.id JOIN main.tracks t ON t.id = s.track_id ORDER BY s.rowid;
    INSERT INTO main.local_files (source_id, dev, ino, birthtime_ns, size, mtime_ns, ctime_ns)
      SELECT f.source_id, f.dev, f.ino, f.birthtime_ns, f.size, f.mtime_ns, f.ctime_ns
      FROM previous.local_files f JOIN main.sources s ON s.id = f.source_id;
    INSERT INTO main.imported_folders (path) SELECT path FROM previous.imported_folders;
    INSERT INTO main.playlists (id, name) SELECT id, name FROM previous.playlists ORDER BY rowid;
    INSERT INTO main.playlist_items (playlist_id, track_id, position)
      SELECT p.playlist_id, p.track_id, p.position FROM previous.playlist_items p JOIN main.tracks t ON t.id = p.track_id;
    INSERT INTO main.track_preferences (track_id, liked, updated_at)
      SELECT p.track_id, p.liked, p.updated_at FROM previous.track_preferences p JOIN main.tracks t ON t.id = p.track_id;
    INSERT INTO main.playback_events (session_id, track_id, type, listened_seconds, timestamp)
      SELECT e.session_id, e.track_id, e.type, e.listened_seconds, e.timestamp
      FROM previous.playback_events e JOIN main.tracks t ON t.id = e.track_id ORDER BY e.rowid;
    INSERT OR REPLACE INTO main.playback_volume (id, level, muted) SELECT id, level, muted FROM previous.playback_volume;
    INSERT OR REPLACE INTO main.wave_settings (id, mode) SELECT id, mode FROM previous.wave_settings;`)
  const saved = db.prepare('SELECT snapshot FROM previous.playback_session WHERE id = 1').get()
  if (typeof saved?.snapshot === 'string') {
    const trackIds = new Set(db.prepare('SELECT id FROM main.tracks').all().map(row => row.id as string))
    const session = localSession(saved.snapshot, trackIds)
    if (session) db.prepare('INSERT INTO main.playback_session VALUES (1, ?)').run(JSON.stringify(session))
  }
  removeLegacyDemo(db)
  if (db.prepare('PRAGMA main.quick_check').get()?.quick_check !== 'ok' ||
      db.prepare('PRAGMA main.foreign_key_check').get()) throw new Error('Imported library verification failed')
  db.exec('COMMIT')
}

export function resolveLibraryPath(profile: string): string {
  const original = join(profile, 'library.sqlite3')
  const local = join(profile, localLibraryFile)
  if (exists(local)) return local
  if (!exists(original) || !isExperimentalLibrary(original)) return original

  const staging = mkdtempSync(join(profile, '.player-experience-'))
  const temporary = join(staging, 'library.sqlite3')
  try {
    importLocalLibrary(original, temporary)
    renameSync(temporary, local)
  } finally {
    if (exists(temporary)) unlinkSync(temporary)
    rmdirSync(staging)
  }
  return local
}
