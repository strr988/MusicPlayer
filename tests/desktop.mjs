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

async function prepareElectron(t, { withArtwork = false, withCatalog = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'music-player-desktop-'))
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
