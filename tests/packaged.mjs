import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const archive = fileURLToPath(new URL(`../release/MusicPlayer-${version}-win-x64.zip`, import.meta.url))
const harness = fileURLToPath(new URL('./electron-smoke.mjs', import.meta.url))

async function verifyExe(directory, cwd, profile, folder, phase, expectedVersion = version) {
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
    let requestId = 0
    async function evaluate(expression) {
      const response = once(socket, 'message', { signal: timeout })
      socket.send(JSON.stringify({ id: ++requestId, method: 'Runtime.evaluate', params: {
        expression, awaitPromise: true, returnByValue: true,
      } }))
      const [message] = await response
      return JSON.parse(message.data)
    }
    // The inspector can connect during Node bootstrap. Wait for the app's event loop
    // to run a timer before invoking require() in its main process.
    const ready = 'typeof setTimeout === "function" && new Promise(resolve => setTimeout(resolve, 0, true))'
    while ((await evaluate(ready)).result?.result?.value !== true) await delay(40, undefined, { signal: timeout })
    const result = await evaluate(`(async () => {
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
        assert.equal(app.getVersion(), ${JSON.stringify(expectedVersion)})
        assert.equal(app.getPath('userData'), ${JSON.stringify(profile)})
        const preload = join(app.getAppPath(), 'out', 'preload', 'index.cjs')
        const { verify } = require(${JSON.stringify(harness)})
        await verify(${[folder, profile, phase].map(JSON.stringify).join(',')}, preload)
        setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 50)
        return 'verified'
      })()`)
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

async function prepareRelease(t) {
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
  unpack(archive, launch)
  const app = join(launch, `Music Player ${version}`)
  const demo = join(app, 'Demo audio')
  const mp3 = join(folder, '01.mp3')
  const flac = join(folder, '02.flac')
  const demoMp3 = join(demo, '01-tone.mp3')
  const demoFlac = join(demo, '02-tone.flac')
  await copyFile(demoMp3, mp3)
  await copyFile(demoFlac, flac)
  return { root, launch, folder, profile, app, mp3, flac, demoMp3, demoFlac }
}

function unpack(zip, directory) {
  execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', zip, '-C', directory])
}

test('Windows ZIP launches from two locations and restores offline wave playback', { timeout: 90_000 }, async (t) => {
  const { root, launch, folder, profile, app, mp3, flac, demoMp3, demoFlac } = await prepareRelease(t)
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

test('unpacked Windows ZIP persists playlists and the Wave mode', { timeout: 90_000 }, async (t) => {
  const { root, folder, profile, app, mp3, demoMp3 } = await prepareRelease(t)
  await verifyExe(app, root, profile, folder, 'playlist-import')
  await verifyExe(app, root, profile, folder, 'playlist-restart')
  assert.deepEqual(await readFile(mp3), await readFile(demoMp3))
})

test('unpacked Windows ZIP restores the advanced playback session silently', { timeout: 90_000 }, async (t) => {
  const { root, folder, profile, app, flac } = await prepareRelease(t)
  await verifyExe(app, root, profile, folder, 'queue-import')
  await rm(flac)
  await verifyExe(app, root, profile, folder, 'queue-restart')
})

const legacyArchive = process.env.MUSIC_PLAYER_011_ZIP
test('upgrades a profile created by the original 0.1.1 Windows ZIP', { skip: !legacyArchive, timeout: 90_000 }, async (t) => {
  const { root, folder, profile, app } = await prepareRelease(t)
  unpack(legacyArchive, root)
  await verifyExe(join(root, 'Music Player 0.1.1'), root, profile, folder, 'legacy-import', '0.1.1')

  const preservedTables = ['tracks', 'sources', 'local_files', 'imported_folders', 'track_preferences', 'playback_events', 'playback_volume']
  function snapshot(expectedSchema) {
    using db = new DatabaseSync(join(profile, 'library.sqlite3'), { readOnly: true })
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, expectedSchema)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    return preservedTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  }
  const before = snapshot(3)
  await verifyExe(app, root, profile, folder, 'verify-upgrade')
  const after = snapshot(5)
  // Playback in the migrated application appends events to the existing history.
  after[5] = after[5].slice(0, before[5].length)
  assert.deepEqual(after, before)
})

const previousArchive = process.env.MUSIC_PLAYER_020_ZIP
test('migrates a 0.2.0 profile and restores the verified pre-migration backup in the original EXE', { skip: !previousArchive, timeout: 120_000 }, async (t) => {
  const { root, folder, profile, app } = await prepareRelease(t)
  unpack(previousArchive, root)
  const previous = join(root, 'Music Player 0.2.0')
  await verifyExe(previous, root, profile, folder, 'playlist-import', '0.2.0')

  function snapshot(file, schema) {
    using db = new DatabaseSync(file, { readOnly: true })
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, schema)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name <> 'playback_session' ORDER BY name").all()
    return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
  }
  const database = join(profile, 'library.sqlite3')
  const before = snapshot(database, 4)
  await verifyExe(app, root, profile, folder, 'verify-v4')
  assert.deepEqual(snapshot(database, 5), before)
  const backups = (await readdir(profile)).filter(name => /^library\.sqlite3\.v4-.+\.backup$/.test(name))
  assert.equal(backups.length, 1)
  assert.deepEqual(snapshot(join(profile, backups[0]), 4), before)
  const restored = join(root, 'Restored v4')
  await mkdir(restored)
  await copyFile(join(profile, backups[0]), join(restored, 'library.sqlite3'))
  await copyFile(join(profile, 'smoke-state.json'), join(restored, 'smoke-state.json'))
  await verifyExe(previous, root, restored, folder, 'verify-v4', '0.2.0')
})
