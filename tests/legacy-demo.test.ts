import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { Library } from '../src/main/library'
import { LibraryStore } from '../src/main/library-store'

it('cleans a legacy demo folder and its references during migration while retaining user tracks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'player-demo-migration-'))
  const database = join(root, 'library.sqlite3')
  const oldRelease = join(root, 'Music Player 0.3.0')
  const demo = join(oldRelease, 'Demo audio')
  const own = join(root, 'Demo audio')
  const missing = join(root, 'Music')
  const fixture = new URL('./fixtures/01-tone.mp3', import.meta.url)
  try {
    for (const folder of [demo, own, missing]) {
      await mkdir(folder, { recursive: true })
      await copyFile(fixture, join(folder, '01-tone.mp3'))
    }
    await copyFile(new URL('./fixtures/02-tone.flac', import.meta.url), join(demo, '02-tone.flac'))
    const library = new Library(database)
    const [mp3, flac] = (await library.importFolder(demo)).tracks
    const ownTrack = (await library.importFolder(own)).tracks.at(-1)!
    const missingTrack = (await library.importFolder(missing)).tracks.at(-1)!
    const playlist = library.createPlaylist('Music')
    await library.addPlaylistTrack(playlist.id, mp3.id)
    await library.addPlaylistTrack(playlist.id, ownTrack.id)
    for (const track of [mp3, ownTrack]) {
      library.setTrackPreference(track.id, true)
      library.recordPlaybackEvent({ sessionId: randomUUID(), trackId: track.id, type: 'started', listenedSeconds: 0 })
    }
    const entries = [mp3, flac, ownTrack, missingTrack].map(track => ({
      id: randomUUID(), trackId: track.id, kind: 'source' as const,
    }))
    library.setPlaybackSession({ position: 1.5, queue: {
      source: { type: 'library' }, entries, current: entries[0].id, history: [entries[1].id],
      pending: entries.slice(2).map(entry => entry.id), shuffle: false, repeat: 'off',
    } })
    library.close()
    await rm(join(demo, '01-tone.mp3'))
    await rm(join(demo, '02-tone.flac'))
    await rm(demo, { recursive: true })
    await rm(join(missing, '01-tone.mp3'))
    await rm(missing, { recursive: true })
    {
      using db = new DatabaseSync(database)
      db.exec('DROP TABLE appearance_settings; PRAGMA user_version = 6')
    }
    const upgraded = new LibraryStore(database)
    try {
      expect(upgraded.getImportedFolders()).toHaveLength(2)
      expect(upgraded.getImportedFolders()).not.toContain(demo)
      expect(upgraded.getTracks().map(track => track.id)).toEqual([ownTrack.id, missingTrack.id])
      expect(upgraded.getPlaylists()).toEqual([{ ...playlist, trackIds: [ownTrack.id] }])
      expect(upgraded.getListeningData().preferences.map(row => row.trackId)).toEqual([ownTrack.id])
      expect(upgraded.getListeningData().events.map(row => row.trackId)).toEqual([ownTrack.id])
      expect(upgraded.getPlaybackSession()).toMatchObject({
        position: 0, queue: { entries: entries.slice(2), current: null, history: [],
          pending: entries.slice(2).map(entry => entry.id) },
      })
    } finally {
      upgraded.close()
    }
    const backup = (await readdir(root)).find(file => /^library\.sqlite3\.v6-.+\.backup$/.test(file))
    expect(backup).toBeDefined()
    using previous = new DatabaseSync(join(root, backup!), { readOnly: true })
    expect(previous.prepare('SELECT count(*) AS count FROM tracks').get()?.count).toBe(4)
    using current = new DatabaseSync(database, { readOnly: true })
    expect(current.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
