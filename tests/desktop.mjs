import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import executable from 'electron'
import { flacWithArtwork, mp3WithArtwork, mp3WithMetadata } from './fixtures/artwork.ts'
import { catalogSize, fixtureMetadata } from './fixtures/interface-catalog.mjs'
import { prepareSession } from '../scripts/pilot-session.mjs'

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
  const run = (phase, timeout = 35_000) => promisify(execFile)(executable, [entry, fixtures, profile, phase], { timeout })
  return { fixtures, profile, run }
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

test('Downloads validates links and reports the missing tool in Electron', { timeout: 40_000 }, async t => {
  const { run } = await prepareElectron(t)
  await run('downloads-offline')
})

test('an abrupt Electron exit after importing a download preserves the Track ID, SQLite and the original tags',
  { timeout: 75_000 }, async t => {
    const { fixtures, profile, run } = await prepareElectron(t)
    const root = join(profile, 'music-downloads')
    const id = randomUUID()
    const audio = await readFile(join(fixtures, '01.mp3'))
    const manifest = {
      metadata: {
        provider: 'archive.org', sourceId: 'fixture/tone.mp3', originalUrl: 'https://archive.org/details/fixture/tone.mp3',
        title: 'Original title', artist: null, album: null, durationSeconds: 5, artworkUrl: null, audioFormats: ['mp3'],
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', downloadFormat: 'mp3', restriction: null,
      },
      edits: { title: 'Library title' },
      size: audio.length, sha1: createHash('sha1').update(audio).digest('hex'),
    }
    for (const name of [id, '.stage-AbC123']) {
      const path = join(root, name)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'audio.mp3'), audio)
      await writeFile(join(path, 'download.json'), JSON.stringify(manifest))
    }
    await assert.rejects(run('downloads-recovery-commit'), error => {
      assert.equal(error.killed, false)
      assert.match(error.stdout, /download import committed/)
      return true
    })
    await run('downloads-restart')
    assert.deepEqual(await readdir(root), [id])
    assert.deepEqual(await readFile(join(root, id, 'audio.mp3')), audio)
    using db = new DatabaseSync(join(profile, 'library.sqlite3'), { readOnly: true })
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(db.prepare('SELECT count(*) AS count FROM external_recordings').get().count, 1)
  })

const archiveLiveOptions = { skip: !process.env.MUSIC_PLAYER_YTDLP_EXE, timeout: 340_000 }

test('Archive.org downloads and plays an authorized original without FFmpeg, then restores the imported Track ID',
  archiveLiveOptions, async t => {
    const { profile, run } = await prepareElectron(t)
    await mkdir(join(profile, 'tools'), { recursive: true })
    await copyFile(process.env.MUSIC_PLAYER_YTDLP_EXE, join(profile, 'tools', 'yt-dlp.exe'))
    await run('downloads-live', 300_000)
    await run('downloads-restart')
  })

test('Archive.org rejects an album and downloads, plays and restores the selected authorized FLAC track',
  archiveLiveOptions, async t => {
    const { profile, run } = await prepareElectron(t)
    await mkdir(join(profile, 'tools'), { recursive: true })
    await copyFile(process.env.MUSIC_PLAYER_YTDLP_EXE, join(profile, 'tools', 'yt-dlp.exe'))
    await run('downloads-live-flac', 300_000)
    await run('downloads-restart')
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
