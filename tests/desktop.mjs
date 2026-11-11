import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import executable from 'electron'

test('built Electron app imports and plays MP3 and FLAC through its sandboxed bridge', { timeout: 45_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'music-player-desktop-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }))
  const fixtures = join(directory, 'audio')
  await mkdir(fixtures)
  await copyFile(new URL('./fixtures/01-tone.mp3', import.meta.url), join(fixtures, '01.mp3'))
  await copyFile(new URL('./fixtures/02-tone.flac', import.meta.url), join(fixtures, '02.flac'))
  await writeFile(join(fixtures, 'broken.mp3'), 'broken')

  const entry = fileURLToPath(new URL('./electron-smoke.mjs', import.meta.url))
  try {
    await promisify(execFile)(executable, [entry, fixtures, join(directory, 'profile')], {
      timeout: 35_000,
    })
  } catch (error) {
    throw new Error(error.message, { cause: error })
  }
})
