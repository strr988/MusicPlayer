import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import executable from 'electron'
import { flacWithArtwork, mp3WithArtwork, mp3WithMetadata } from './fixtures/artwork.ts'
import { catalogSize, fixtureMetadata } from './fixtures/interface-catalog.mjs'
import { prepareSession } from '../scripts/pilot-session.mjs'

async function prepareElectron(t, { withArtwork = false, withCatalog = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mustplay-desktop-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }))
  const fixtures = join(directory, 'audio')
  await mkdir(fixtures)
  const read = name => readFile(new URL('./fixtures/' + name, import.meta.url))
  if (withCatalog) {
    const tone = await read('01-tone.mp3')
    const jpeg = { image: await read('cover.jpg'), mime: 'image/jpeg' }
    const png = { image: await read('cover.png'), mime: 'image/png' }
    for (let index = 0; index < catalogSize; index++) {
      const cover = index % 4 === 1 ? jpeg : index % 4 === 2 ? png : undefined
      const name = String(index).padStart(2, '0') + '.mp3'
      await writeFile(join(fixtures, name), mp3WithMetadata(tone, fixtureMetadata(index), cover))
    }
  } else {
    await copyFile(new URL('./fixtures/01-tone.mp3', import.meta.url), join(fixtures, '01.mp3'))
    await copyFile(new URL('./fixtures/02-tone.flac', import.meta.url), join(fixtures, '02.flac'))
    await writeFile(join(fixtures, 'broken.mp3'), 'broken')
    if (withArtwork) {
      await writeFile(join(fixtures, '01.mp3'), mp3WithArtwork(await read('01-tone.mp3'), await read('cover.jpg')))
      await writeFile(join(fixtures, '02.flac'), flacWithArtwork(await read('02-tone.flac'), await read('cover.png')))
    }
  }

  const entry = fileURLToPath(new URL('./run-electron-smoke.mjs', import.meta.url))
  const profile = join(directory, 'profile')
  const run = (phase) => promisify(execFile)(executable, [entry, fixtures, profile, phase], { timeout: 35_000 })
  return { fixtures, run }
}

test('built Electron app imports, plays and restores its library across restarts', { timeout: 75_000 }, async (t) => {
  const { fixtures, run } = await prepareElectron(t, { withArtwork: true })
  const originalMp3 = await readFile(join(fixtures, '01.mp3'))
  await run('import')
  await run('restart')
  assert.deepEqual(await readFile(join(fixtures, '01.mp3')), originalMp3)
})

test('built app decodes AAC, M4A, PCM WAV, Vorbis, Opus and WebM via the local protocol', { timeout: 40_000 }, async t => {
  const { fixtures, run } = await prepareElectron(t)
  for (const name of ['aac', 'm4a', 'wav', 'ogg', 'opus', 'webm', 'alac.m4a']) {
    const target = name === 'alac.m4a' ? 'lossless-apple.m4a' : 'extra.' + name
    await copyFile(new URL('./fixtures/formats/tone.' + name, import.meta.url), join(fixtures, target))
  }
  await run('audio-formats')
})

test('excluding a music folder revokes its playback while preserving overlapping folders', { timeout: 40_000 }, async t => {
  const { run } = await prepareElectron(t)
  await run('folder-exclusion')
})

test('library refresh rescans saved folders without opening a dialog', { timeout: 75_000 }, async t => {
  const { run } = await prepareElectron(t)
  await run('library-rescan')
  await run('library-rescan-restart')
})

test('personal wave plays offline, reacts to feedback and survives a restart with missing files', { timeout: 75_000 }, async (t) => {
  const { fixtures, run } = await prepareElectron(t)
  await run('wave-import')
  await rm(join(fixtures, '02.flac'))
  await run('wave-restart')
})

test('playlists and Wave mode work in Electron and persist across restarts', { timeout: 75_000 }, async (t) => {
  const { fixtures, run } = await prepareElectron(t)
  const mp3 = join(fixtures, '01.mp3')
  const original = await readFile(mp3)
  await run('playlist-import')
  await run('playlist-restart')
  assert.deepEqual(await readFile(mp3), original)
})

test('queue edits, repeat transitions and paused session restoration work in Electron', { timeout: 75_000 }, async (t) => {
  const { fixtures, run } = await prepareElectron(t)
  await run('queue-import')
  await rm(join(fixtures, '02.flac'))
  await run('queue-restart')
})

test('Wave honors manual queue priorities, feedback and Media Session actions', { timeout: 40_000 }, async (t) => {
  const { run } = await prepareElectron(t)
  await run('wave-queue')
})

test('interface preserves playback and keyboard focus at four desktop sizes', { timeout: 40_000 }, async (t) => {
  const { run } = await prepareElectron(t, { withCatalog: true })
  await run('interface')
})

test('lyrics, mini playback, global registrations and sleep timer work in Electron', { timeout: 75_000 }, async (t) => {
  const { fixtures, run } = await prepareElectron(t, { withArtwork: true })
  await copyFile(new URL('./fixtures/01-tone.lrc', import.meta.url), join(fixtures, '01.lrc'))
  await copyFile(new URL('./fixtures/02-tone.txt', import.meta.url), join(fixtures, '02.txt'))
  const { stdout } = await run('experience')
  t.diagnostic(stdout.trim())
  await run('experience-restart')
})

test('offline blind pilot plays local audio and exports only explicitly submitted answers', { timeout: 40_000 }, async t => {
  const { fixtures } = await prepareElectron(t)
  const manifestPath = join(fixtures, 'audio-map.json')
  await writeFile(manifestPath, JSON.stringify({ track: '01.mp3' }))
  const output = join(fixtures, 'session')
  await prepareSession({
    snapshot: {
      now: Date.UTC(2026, 10, 11), seed: 42, candidates: [{ id: 'track', artist: null, genres: [], available: true }],
      listening: { events: [], preferences: [] },
    },
    manifestPath, output, slot: 3, count: 1, excerptSeconds: 30,
  })
  const entry = fileURLToPath(new URL('./pilot-smoke.mjs', import.meta.url))
  await promisify(execFile)(executable, [
    entry, join(output, 'participant', 'listen.html'), join(fixtures, 'ratings.json'), join(fixtures, 'profile'),
  ], { timeout: 35_000 })
})

test('interface scale and audio effects apply live and restore across restarts', { timeout: 75_000 }, async t => {
  const { run } = await prepareElectron(t)
  await run('scale-effects')
  await run('scale-effects-restart')
})
