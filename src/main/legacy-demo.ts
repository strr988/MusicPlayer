import { statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { filterPlaybackSession, validatePlaybackSession } from './playback-session'

const demoTitles: ReadonlyMap<string, string> = new Map([
  ['01-tone.mp3', 'Test Tone MP3'],
  ['02-tone.flac', 'Test Tone FLAC'],
])

function missing(path: string): boolean {
  try {
    statSync(path)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

// Called inside the schema migration or the transaction that copies a legacy profile.
export function removeLegacyDemo(db: DatabaseSync): void {
  const folders = db.prepare('SELECT path FROM imported_folders').all().map(row => row.path as string)
    .filter(path => basename(path).toLowerCase() === 'demo audio' &&
      /^Music Player \d+\.\d+\.\d+$/i.test(basename(dirname(path))) && missing(path))
  if (!folders.length) return

  const sources = db.prepare(`SELECT s.id, s.track_id AS trackId, s.provider_id AS path, t.title, t.artist, t.album
    FROM sources s JOIN tracks t ON t.id = s.track_id WHERE s.provider = 'local'`).all() as
    { id: string; trackId: string; path: string; title: string; artist: string | null; album: string | null }[]
  const deleteSource = db.prepare('DELETE FROM sources WHERE id = ?')
  const deleteFolder = db.prepare('DELETE FROM imported_folders WHERE path = ?')
  const orphan = db.prepare('SELECT 1 FROM sources WHERE track_id = ? LIMIT 1')
  const candidates = new Set<string>()

  for (const folder of folders) {
    const contained = sources.filter(source => {
      const entry = relative(folder, source.path)
      return entry && entry !== '..' && !entry.startsWith('..' + sep) && !isAbsolute(entry)
    })
    const demo = contained.filter(source => {
      const name = relative(folder, source.path).toLowerCase()
      return demoTitles.get(name) === source.title && source.artist === 'Fixture Artist' && source.album === 'Fixture Album'
    })
    if (!demo.length) continue
    for (const source of demo) {
      deleteSource.run(source.id)
      candidates.add(source.trackId)
    }
    if (demo.length === contained.length) deleteFolder.run(folder)
  }

  const removed = new Set([...candidates].filter(id => !orphan.get(id)))
  if (!removed.size) return
  const deletes = [
    db.prepare('DELETE FROM playlist_items WHERE track_id = ?'),
    db.prepare('DELETE FROM playback_events WHERE track_id = ?'),
    db.prepare('DELETE FROM track_preferences WHERE track_id = ?'),
    db.prepare('DELETE FROM tracks WHERE id = ?'),
  ]
  for (const id of removed) for (const statement of deletes) statement.run(id)

  const saved = db.prepare('SELECT snapshot FROM playback_session WHERE id = 1').get()
  if (typeof saved?.snapshot !== 'string') return
  let session
  try {
    session = validatePlaybackSession(JSON.parse(saved.snapshot))
  } catch {
    // The library can still be upgraded if a previous session is invalid.
    return
  }
  const filtered = filterPlaybackSession(session, id => !removed.has(id))
  if (filtered.queue.entries.length !== session.queue.entries.length) {
    db.prepare('UPDATE playback_session SET snapshot = ? WHERE id = 1').run(JSON.stringify(filtered))
  }
}
