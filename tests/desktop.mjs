import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import executable from 'electron'

async function prepareElectron(t) {
  const directory = await mkdtemp(join(tmpdir(), 'music-player-desktop-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }))
  const fixtures = join(directory, 'audio')
  await mkdir(fixtures)
  await copyFile(new URL('./fixtures/01-tone.mp3', import.meta.url), join(fixtures, '01.mp3'))
  await copyFile(new URL('./fixtures/02-tone.flac', import.meta.url), join(fixtures, '02.flac'))
  await writeFile(join(fixtures, 'broken.mp3'), 'broken')

  const entry = fileURLToPath(new URL('./electron-smoke.mjs', import.meta.url))
  const profile = join(directory, 'profile')
  const run = (phase) => promisify(execFile)(executable, [entry, fixtures, profile, phase], { timeout: 35_000 })
  return { fixtures, run }
}

test('built Electron app imports, plays and restores its library across restarts', { timeout: 75_000 }, async (t) => {
  const { fixtures, run } = await prepareElectron(t)
  await run('import')
  await run('restart')
  assert.deepEqual(await readFile(join(fixtures, '01.mp3')), await readFile(new URL('./fixtures/01-tone.mp3', import.meta.url)))
})

test('personal wave plays offline, reacts to feedback and survives a restart with missing files', { timeout: 75_000 }, async (t) => {
  const { fixtures, run } = await prepareElectron(t)
  await run('wave-import')
  await rm(join(fixtures, '02.flac'))
  await run('wave-restart')
})
