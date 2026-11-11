import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const archive = fileURLToPath(new URL(`../release/MusicPlayer-${version}-win-x64.zip`, import.meta.url))
const harness = fileURLToPath(new URL('./electron-smoke.mjs', import.meta.url))

async function verifyExe(directory, cwd, profile, folder, phase) {
  // The test uses a one-shot inspector on loopback. The ZIP needs no test entrypoint.
  const executable = join(directory, 'Music Player.exe')
  const env = { ...process.env }
  for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) {
    delete env[name]
  }
  const child = spawn(executable, ['--inspect=127.0.0.1:0', `--user-data-dir=${profile}`, '--enable-logging=stderr'], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  let socket
  const closed = once(child, 'close')
  const timeout = AbortSignal.timeout(35_000)
  const timedOut = new Promise((_, reject) => {
    timeout.addEventListener('abort', () => reject(timeout.reason), { once: true })
  })
  child.stdout.resume()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { log += chunk })
  try {
    const address = await Promise.race([
      new Promise(resolve => {
        child.stderr.on('data', () => {
          const url = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1]
          if (url) resolve(url)
        })
      }),
      closed.then(() => { throw new Error('Packaged app exited before opening the inspector') }),
      timedOut,
    ])
    socket = new WebSocket(address)
    await once(socket, 'open', { signal: timeout })
    const response = once(socket, 'message', { signal: timeout })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(async () => {
        const require = process.getBuiltinModule('node:module').createRequire(process.execPath)
        const assert = require('node:assert/strict')
        const { setTimeout: delay } = require('node:timers/promises')
        const deadline = Date.now() + 8000
        let electron
        while (!electron) {
          try {
            electron = require('electron')
          } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND' || Date.now() >= deadline) throw error
            await delay(40)
          }
        }
        const { app, BrowserWindow } = electron
        await app.whenReady()
        const { join } = require('node:path')
        assert.equal(app.isPackaged, true)
        assert.equal(app.getName(), 'Music Player')
        assert.equal(app.getVersion(), ${JSON.stringify(version)})
        assert.equal(app.getPath('userData'), ${JSON.stringify(profile)})
        const preload = join(app.getAppPath(), 'out', 'preload', 'index.cjs')
        const { verify } = require(${JSON.stringify(harness)})
        await verify(${[folder, profile, phase].map(JSON.stringify).join(',')}, preload)
        setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 50)
        return 'verified'
      })()`,
      awaitPromise: true, returnByValue: true,
    } }))
    const [message] = await response
    const result = JSON.parse(message.data)
    assert.equal(result.result?.result?.value, 'verified',
      result.result?.exceptionDetails?.exception?.description ?? JSON.stringify(result))
    socket.close()
    const [code, signal] = await Promise.race([closed, timedOut])
    assert.equal(signal, null)
    assert.equal(code, 0)
    assert.doesNotMatch(log, /Music Player failed to start|Uncaught Exception|FATAL:/i)
  } catch (error) {
    throw new Error(`${phase} failed\n${log}`, { cause: error })
  } finally {
    socket?.close()
    if (child.exitCode === null) child.kill()
    await closed
  }
}

test('Windows ZIP launches from two locations and restores offline wave playback', { timeout: 90_000 }, async (t) => {
  const temp = await realpath(tmpdir())
  const root = await mkdtemp(join(temp, 'music-player-release-'))
  t.after(async () => {
    const actual = await realpath(root)
    assert.equal(dirname(actual), temp)
    assert.ok(basename(actual).startsWith('music-player-release-'))
    await rm(actual, { recursive: true, force: true, maxRetries: 5 })
  })
  const launch = join(root, 'Распаковка ZIP')
  const folder = join(root, 'Аудио')
  const profile = join(root, 'Новый профиль')
  await mkdir(launch)
  await mkdir(folder)
  await assert.rejects(access(profile), { code: 'ENOENT' })
  execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archive, '-C', launch])
  const app = join(launch, `Music Player ${version}`)
  const demo = join(app, 'Demo audio')
  const mp3 = join(folder, '01.mp3')
  const flac = join(folder, '02.flac')
  const demoMp3 = join(demo, '01-tone.mp3')
  const demoFlac = join(demo, '02-tone.flac')
  await copyFile(demoMp3, mp3)
  await copyFile(demoFlac, flac)
  await verifyExe(app, root, profile, folder, 'wave-import')
  assert.ok((await stat(join(profile, 'library.sqlite3'))).size > 0)
  await assert.rejects(access(join(app, 'library.sqlite3')), { code: 'ENOENT' })
  assert.deepEqual(await readFile(mp3), await readFile(demoMp3))
  assert.deepEqual(await readFile(flac), await readFile(demoFlac))
  await rm(flac)
  const moved = join(root, 'Перенесённый плеер')
  await rename(app, moved)
  await verifyExe(moved, launch, profile, folder, 'wave-restart')
})
