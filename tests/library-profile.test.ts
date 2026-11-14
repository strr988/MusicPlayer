import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LibraryStore } from '../src/main/library-store'
import { localLibraryFile, resolveLibraryPath, resolveProfileDirectory } from '../src/main/library-profile'

let profile: string
let original: string
let store: LibraryStore | undefined

beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), 'mustplay-profile-'))
  original = join(profile, 'library.sqlite3')
})

afterEach(async () => {
  store?.close()
  store = undefined
  await rm(profile, { recursive: true, force: true })
})

it('reuses the legacy library profile until the renamed profile has a library', async () => {
  const current = join(profile, 'mustplay')
  await mkdir(current)
  expect(resolveProfileDirectory(current, profile)).toBe(current)
  new LibraryStore(original).close()
  expect(resolveProfileDirectory(current, profile)).toBe(profile)
  new LibraryStore(join(current, localLibraryFile)).close()
  expect(resolveProfileDirectory(current, profile)).toBe(current)
})

it('upgrades schema 8 and persists the theme alongside existing appearance preferences', async () => {
  const previous = new LibraryStore(original)
  previous.setWavePulse(175)
  previous.close()
  {
    using db = new DatabaseSync(original)
    db.exec(`DROP TABLE preset_reverb; ALTER TABLE appearance_settings DROP COLUMN disco;
      ALTER TABLE appearance_settings DROP COLUMN interface_scale;
      ALTER TABLE appearance_settings DROP COLUMN theme; DROP TABLE playback_effect; PRAGMA user_version = 8`)
  }
  const upgraded = new LibraryStore(original)
  try {
    expect(upgraded.getTheme()).toBe('dark')
    expect(upgraded.getWavePulse()).toBe(175)
    upgraded.setTheme('light')
  } finally {
    upgraded.close()
  }
  store = new LibraryStore(original)
  expect(store.getTheme()).toBe('light')
  expect((await readdir(profile)).filter(file => /^library\.sqlite3\.v8-.*\.backup$/.test(file))).toHaveLength(1)
})

it('upgrades a 0.7.0 profile and persists its zoom and sound effect beside the theme', () => {
  const previous = new LibraryStore(original)
  previous.setTheme('light')
  previous.close()
  {
    using db = new DatabaseSync(original)
    db.exec(`DROP TABLE preset_reverb; ALTER TABLE appearance_settings DROP COLUMN disco;
      ALTER TABLE appearance_settings DROP COLUMN interface_scale; DROP TABLE playback_effect; PRAGMA user_version = 9`)
  }
  const upgraded = new LibraryStore(original)
  try {
    expect(upgraded.getTheme()).toBe('light')
    expect(upgraded.getInterfaceScale()).toBe(100)
    expect(upgraded.getSoundEffect()).toEqual({ effect: 'original', reverb: { original: false, 'speed-up': false, slowed: false } })
    upgraded.setInterfaceScale(125)
    upgraded.setSoundEffect('slowed')
    upgraded.setReverb('slowed', true)
    upgraded.setReverb('original', true)
    upgraded.setDiscoMode(true)
  } finally {
    upgraded.close()
  }
  store = new LibraryStore(original)
  expect(store.getInterfaceScale()).toBe(125)
  expect(store.getSoundEffect()).toEqual({ effect: 'slowed', reverb: { original: true, 'speed-up': false, slowed: true } })
  expect(store.getDiscoMode()).toBe(true)
})
it.each([6, 7])('copies only local library data from an experimental schema %i', async version => {
  new LibraryStore(original).close()
  const localTrack = randomUUID()
  const otherTrack = randomUUID()
  const sourceId = randomUUID()
  const playlistId = randomUUID()
  const sessionId = randomUUID()
  const localEntry = randomUUID()
  const otherEntry = randomUUID()
  const experiment = {
    position: 2.5,
    queue: { source: { type: 'stream' }, shuffle: true, repeat: 'one', current: otherEntry,
      entries: [{ id: localEntry, trackId: localTrack, kind: 'manual' }, { id: otherEntry, trackId: otherTrack, kind: 'source' }],
      pending: [localEntry], history: [] },
    externalTracks: [{ id: otherTrack, title: 'Example' }],
  }
  {
    using db = new DatabaseSync(original)
    db.exec(`DROP TABLE preset_reverb; DROP TABLE playback_effect; DROP TABLE appearance_settings; DROP TABLE mini_player; DROP TABLE global_shortcuts;
      CREATE TABLE stream_tracks (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE stream_settings (id INTEGER PRIMARY KEY) STRICT;
      PRAGMA user_version = ${version}`)
    const addTrack = db.prepare("INSERT INTO tracks VALUES (?, ?, NULL, NULL, 5, '[]', 'mp3')")
    addTrack.run(localTrack, 'Local track')
    addTrack.run(otherTrack, 'External track')
    db.prepare("INSERT INTO sources VALUES (?, ?, 'local', 'audio.mp3', 1)").run(sourceId, localTrack)
    db.prepare("INSERT INTO local_files VALUES (?, '1', '2', '3', '4', '5', '6')").run(sourceId)
    db.prepare("INSERT INTO sources VALUES (?, ?, 'external', 'external-id', 1)").run(randomUUID(), otherTrack)
    db.prepare("INSERT INTO playlists VALUES (?, 'Mix')").run(playlistId)
    const addItem = db.prepare('INSERT INTO playlist_items VALUES (?, ?, ?)')
    addItem.run(playlistId, otherTrack, 0)
    addItem.run(playlistId, localTrack, 1)
    db.prepare("INSERT INTO track_preferences VALUES (?, 1, '2026-01-01')").run(localTrack)
    db.prepare("INSERT INTO playback_events VALUES (?, ?, 'started', 0, '2026-01-01')").run(sessionId, localTrack)
    db.prepare('UPDATE playback_volume SET level = 0.42, muted = 1').run()
    db.prepare("UPDATE wave_settings SET mode = 'familiar'").run()
    db.prepare('INSERT INTO playback_session VALUES (1, ?)').run(JSON.stringify(experiment))
  }
  const before = await readFile(original)
  const recovered = resolveLibraryPath(profile)
  expect(recovered).toBe(join(profile, localLibraryFile))
  store = new LibraryStore(recovered)
  expect(store.getTracks().map(track => track.id)).toEqual([localTrack])
  expect(store.getPlaylists()).toEqual([{ id: playlistId, name: 'Mix', trackIds: [localTrack] }])
  expect(store.getListeningData().preferences[0]).toMatchObject({ trackId: localTrack, liked: true })
  expect(store.getListeningData().events[0]).toMatchObject({ trackId: localTrack, sessionId })
  expect(store.getVolume()).toEqual({ level: 0.42, muted: true })
  expect(store.getWaveMode()).toBe('familiar')
  expect(store.getPlaybackSession()).toEqual({
    position: 0, queue: { source: { type: 'library' }, shuffle: true, repeat: 'one', current: null,
      entries: [experiment.queue.entries[0]], pending: [localEntry], history: [] },
  })
  store.setMiniPinned(true)
  expect(resolveLibraryPath(profile)).toBe(recovered)
  expect(new Set(await readdir(profile))).toEqual(new Set(['library.sqlite3', localLibraryFile]))
  expect(await readFile(original)).toEqual(before)
  using db = new DatabaseSync(recovered, { readOnly: true })
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'stream_%'").all()).toEqual([])
})

it('keeps regular profiles on their existing database and rejects unknown schemas', () => {
  expect(resolveLibraryPath(profile)).toBe(original)
  new LibraryStore(original).close()
  expect(resolveLibraryPath(profile)).toBe(original)
  {
    using db = new DatabaseSync(original)
    db.exec('PRAGMA user_version = 99')
  }
  expect(() => new LibraryStore(resolveLibraryPath(profile))).toThrow('Unsupported library schema 99')
})

it('can retry when an incomplete legacy schema causes copying to fail', async () => {
  await mkdir(join(profile, 'sentinel'))
  {
    using db = new DatabaseSync(original)
    db.exec(`CREATE TABLE playback_session (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE external_recordings (id INTEGER PRIMARY KEY) STRICT;
      PRAGMA user_version = 7`)
  }
  expect(() => resolveLibraryPath(profile)).toThrow()
  expect(new Set(await readdir(profile))).toEqual(new Set(['library.sqlite3', 'sentinel']))
})
