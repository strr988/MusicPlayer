import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { LibraryStore } from '../src/main/library-store'
import { validatePlaybackEvent, validatePreference } from '../src/main/feedback-validation'

let store: LibraryStore | undefined
let directory: string | undefined
afterEach(async () => {
  store?.close(); store = undefined
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('migrates an existing v1 library, retaining IDs, likes, cancellation and history after restart', async () => {
  directory = await mkdtemp(join(tmpdir(), 'music-feedback-'))
  const path = join(directory, 'library.sqlite3')
  const trackId = randomUUID()
  const sourceId = randomUUID()
  {
    using db = new DatabaseSync(path)
    db.exec(await readFile(new URL('./fixtures/library-v1.sql', import.meta.url), 'utf8'))
    db.exec('PRAGMA user_version = 1')
    db.prepare("INSERT INTO tracks VALUES (?, 'Tone', NULL, NULL, 10, '[]', 'mp3')").run(trackId)
    db.prepare("INSERT INTO sources VALUES (?, ?, 'local', 'test-path', 1)").run(sourceId, trackId)
  }
  store = new LibraryStore(path)
  expect(store.getTracks()[0].id).toBe(trackId)
  expect(store.getSourceId(trackId)).toBe(sourceId)
  expect(store.getListeningData()).toEqual({ preferences: [], events: [] })
  store.setTrackPreference(trackId, true)
  const started = { trackId, sessionId: randomUUID(), type: 'started' as const, listenedSeconds: 0 }
  store.recordPlaybackEvent(started); store.recordPlaybackEvent(started)
  store.recordPlaybackEvent({ ...started, type: 'skipped', listenedSeconds: 2 })
  store.close(); store = new LibraryStore(path)
  expect(store.getListeningData().preferences[0]).toMatchObject({ trackId, liked: true })
  expect(store.getListeningData().events.map(e => e.type)).toEqual(['started', 'skipped'])
  expect(() => store!.recordPlaybackEvent({ ...started, type: 'completed', listenedSeconds: 10 })).toThrow(/finished/)
  store.setTrackPreference(trackId, false)
  store.close(); store = new LibraryStore(path)
  expect(store.getListeningData().preferences).toEqual([expect.objectContaining({ trackId, liked: false })])
  expect(() => store!.setTrackPreference(randomUUID(), true)).toThrow()
  expect(() => store!.recordPlaybackEvent({ ...started, trackId: randomUUID() })).toThrow(/mismatch/)
  using db = new DatabaseSync(path)
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('rejects malformed IPC preferences and playback events', () => {
  const valid = { trackId: randomUUID(), sessionId: randomUUID(), type: 'started', listenedSeconds: 0 }
  expect(() => validatePlaybackEvent(valid)).not.toThrow()
  for (const input of [null, {}, { ...valid, trackId: '../file' }, { ...valid, listenedSeconds: NaN },
    { ...valid, listenedSeconds: -1 }, { ...valid, type: 'pause' }, { ...valid, extra: true }]) {
    expect(() => validatePlaybackEvent(input)).toThrow()
  }
  expect(() => validatePreference(valid.trackId, true)).not.toThrow()
  expect(() => validatePreference(valid.trackId, 'true')).toThrow()
  expect(() => validatePreference('/file', false)).toThrow()
})
