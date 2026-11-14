import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const { name, productName, version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const archive = fileURLToPath(new URL(`../release/${name}-${version}-win-x64.zip`, import.meta.url))
const harness = fileURLToPath(new URL('./electron-smoke.mjs', import.meta.url))

async function verifyExe(directory, cwd, profile, folder, phase, expectedVersion = version) {
  // The test uses a one-shot inspector on loopback. The ZIP needs no test entrypoint.
  const expectedName = expectedVersion === version ? productName : 'Music Player'
  const executable = join(directory, `${expectedName}.exe`)
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
        assert.equal(app.getName(), ${JSON.stringify(expectedName)})
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
    assert.doesNotMatch(log, /(?:mustplay|Music Player) failed to start|Uncaught Exception|FATAL:/i)
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
  const root = await mkdtemp(join(temp, 'mustplay-release-'))
  t.after(async () => {
    const actual = await realpath(root)
    assert.equal(dirname(actual), temp)
    assert.ok(basename(actual).startsWith('mustplay-release-'))
    await rm(actual, { recursive: true, force: true, maxRetries: 5 })
  })
  const launch = join(root, 'Распаковка ZIP')
  const folder = join(root, 'Аудио')
  const profile = join(root, 'Новый профиль')
  await mkdir(launch)
  await mkdir(folder)
  await assert.rejects(access(profile), { code: 'ENOENT' })
  unpack(archive, launch)
  const app = join(launch, `${productName} ${version}`)
  await assert.rejects(access(join(app, 'Demo audio')), { code: 'ENOENT' })
  const mp3 = join(folder, '01.mp3')
  const flac = join(folder, '02.flac')
  const demoMp3 = new URL('./fixtures/01-tone.mp3', import.meta.url)
  const demoFlac = new URL('./fixtures/02-tone.flac', import.meta.url)
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

test('unpacked Windows ZIP refreshes saved folders without a dialog', { timeout: 90_000 }, async t => {
  const { root, folder, profile, app } = await prepareRelease(t)
  await verifyExe(app, root, profile, folder, 'library-rescan')
  await verifyExe(app, root, profile, folder, 'library-rescan-restart')
})

test('unpacked Windows ZIP removes previously imported demo tracks and the stale folder', { timeout: 90_000 }, async t => {
  const { root, folder, profile, app } = await prepareRelease(t)
  await verifyExe(app, root, profile, folder, 'library-rescan')
  const database = join(profile, 'library.sqlite3')
  const demo = join(root, 'Music Player 0.3.0', 'Demo audio')
  {
    using db = new DatabaseSync(database)
    db.prepare('INSERT INTO imported_folders VALUES (?)').run(demo)
    const track = randomUUID()
    const source = randomUUID()
    db.prepare("INSERT INTO tracks VALUES (?, 'Test Tone MP3', 'Fixture Artist', 'Fixture Album', 4, '[]', 'mp3')").run(track)
    db.prepare("INSERT INTO sources VALUES (?, ?, 'local', ?, 0)").run(source, track, join(demo, '01-tone.mp3'))
    db.prepare("INSERT INTO local_files VALUES (?, '1', '2', '3', '4', '5', '6')").run(source)
    db.exec('DROP TABLE preset_reverb; DROP TABLE playback_effect; DROP TABLE appearance_settings; PRAGMA user_version = 6')
  }
  // The rescan harness checks that only the previously imported user track is present at launch.
  await verifyExe(app, root, profile, folder, 'library-rescan-restart')
  using db = new DatabaseSync(database, { readOnly: true })
  assert.equal(db.prepare('SELECT 1 FROM imported_folders WHERE path = ?').get(demo), undefined)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11)
})

test('unpacked Windows ZIP restores the advanced playback session silently', { timeout: 90_000 }, async (t) => {
  const { root, folder, profile, app, flac } = await prepareRelease(t)
  await verifyExe(app, root, profile, folder, 'queue-import')
  await rm(flac)
  await verifyExe(app, root, profile, folder, 'queue-restart')
})

test('unpacked Windows ZIP opens an experimental schema 7 profile and restores local playback', { timeout: 90_000 }, async t => {
  const { root, folder, profile, app, flac } = await prepareRelease(t)
  await verifyExe(app, root, profile, folder, 'queue-import')
  const original = join(profile, 'library.sqlite3')
  {
    using db = new DatabaseSync(original)
    db.exec(`DROP TABLE preset_reverb; DROP TABLE playback_effect; DROP TABLE appearance_settings; DROP TABLE mini_player; DROP TABLE global_shortcuts;
      CREATE TABLE stream_tracks (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE stream_settings (id INTEGER PRIMARY KEY) STRICT;
      PRAGMA user_version = 7`)
  }
  const before = await readFile(original)
  await rm(flac)
  await verifyExe(app, root, profile, folder, 'queue-restart')
  assert.deepEqual(await readFile(original), before)
  using recovered = new DatabaseSync(join(profile, 'library-player-experience.sqlite3'), { readOnly: true })
  assert.equal(recovered.prepare('PRAGMA user_version').get().user_version, 11)
  assert.equal(recovered.prepare('SELECT count(*) AS count FROM tracks').get().count, 2)
  assert.equal(recovered.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'stream_%'").get(), undefined)
})

test('unpacked Windows ZIP runs the player experience and restores its settings', { timeout: 90_000 }, async (t) => {
  const { root, folder, profile, app } = await prepareRelease(t)
  await copyFile(new URL('./fixtures/01-tone.lrc', import.meta.url), join(folder, '01.lrc'))
  await copyFile(new URL('./fixtures/02-tone.txt', import.meta.url), join(folder, '02.txt'))
  await verifyExe(app, root, profile, folder, 'experience')
  await verifyExe(app, root, profile, folder, 'experience-restart')
})

test('unpacked Windows ZIP restores interface scale and the audio effect', { timeout: 90_000 }, async t => {
  const { root, folder, profile, app } = await prepareRelease(t)
  await verifyExe(app, root, profile, folder, 'scale-effects')
  await verifyExe(app, root, profile, folder, 'scale-effects-restart')
})

const previousThemeArchive = process.env.MUSTPLAY_060_ZIP
test('upgrades the original 0.6.0 profile and preserves its queue in schema 11', { skip: !previousThemeArchive, timeout: 90_000 }, async t => {
  const { root, folder, profile, app, flac } = await prepareRelease(t)
  unpack(previousThemeArchive, root)
  await verifyExe(join(root, 'Music Player 0.6.0'), root, profile, folder, 'queue-import', '0.6.0')
  const database = join(profile, 'library.sqlite3')
  await rm(flac)
  await verifyExe(app, root, profile, folder, 'queue-restart')
  using current = new DatabaseSync(database, { readOnly: true })
  assert.equal(current.prepare('PRAGMA user_version').get().user_version, 11)
  assert.equal(current.prepare('SELECT theme FROM appearance_settings').get().theme, 'dark')
  const backups = (await readdir(profile)).filter(file => /^library\.sqlite3\.v8-.+\.backup$/.test(file))
  assert.equal(backups.length, 1)
})

const playerBaselineArchive = process.env.MUSTPLAY_050_ZIP
test('upgrades the 0.5.0 profile to schema 11 and backs up its queue', { skip: !playerBaselineArchive, timeout: 90_000 }, async t => {
  const { root, folder, profile, app, flac } = await prepareRelease(t)
  unpack(playerBaselineArchive, root)
  await verifyExe(join(root, 'Music Player 0.5.0'), root, profile, folder, 'queue-import', '0.5.0')
  const database = join(profile, 'library.sqlite3')
  function snapshot(file, version) {
    using db = new DatabaseSync(file, { readOnly: true })
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, version)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    return db.prepare('SELECT snapshot FROM playback_session').get()
  }
  const before = snapshot(database, 5)
  await rm(flac)
  await verifyExe(app, root, profile, folder, 'queue-restart')
  snapshot(database, 11)
  const backups = (await readdir(profile)).filter(name => /^library\.sqlite3\.v5-.+\.backup$/.test(name))
  assert.equal(backups.length, 1)
  assert.deepEqual(snapshot(join(profile, backups[0]), 5), before)
})

const legacyArchive = process.env.MUSTPLAY_011_ZIP
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
  const after = snapshot(11)
  // Playback in the migrated application appends events to the existing history.
  after[5] = after[5].slice(0, before[5].length)
  assert.deepEqual(after, before)
})

const previousArchive = process.env.MUSTPLAY_020_ZIP
test('migrates a 0.2.0 profile and restores the verified pre-migration backup in the original EXE', { skip: !previousArchive, timeout: 120_000 }, async (t) => {
  const { root, folder, profile, app } = await prepareRelease(t)
  unpack(previousArchive, root)
  const previous = join(root, 'Music Player 0.2.0')
  await verifyExe(previous, root, profile, folder, 'playlist-import', '0.2.0')

  function snapshot(file, schema) {
    using db = new DatabaseSync(file, { readOnly: true })
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, schema)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    const tables = db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name NOT IN ('playback_session', 'mini_player', 'global_shortcuts', 'appearance_settings', 'playback_effect', 'preset_reverb') ORDER BY name`).all()
    return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
  }
  const database = join(profile, 'library.sqlite3')
  const before = snapshot(database, 4)
  await verifyExe(app, root, profile, folder, 'verify-v4')
  assert.deepEqual(snapshot(database, 11), before)
  const backups = (await readdir(profile)).filter(name => /^library\.sqlite3\.v4-.+\.backup$/.test(name))
  assert.equal(backups.length, 1)
  assert.deepEqual(snapshot(join(profile, backups[0]), 4), before)
  const restored = join(root, 'Restored v4')
  await mkdir(restored)
  await copyFile(join(profile, backups[0]), join(restored, 'library.sqlite3'))
  await copyFile(join(profile, 'smoke-state.json'), join(restored, 'smoke-state.json'))
  await verifyExe(previous, root, restored, folder, 'verify-v4', '0.2.0')
})

const queueArchive = process.env.MUSTPLAY_030_ZIP
test('restores the playback session written by the original 0.3.0 Windows ZIP', { skip: !queueArchive, timeout: 90_000 }, async (t) => {
  const { root, folder, profile, app, flac } = await prepareRelease(t)
  unpack(queueArchive, root)
  await verifyExe(join(root, 'Music Player 0.3.0'), root, profile, folder, 'queue-import', '0.3.0')
  await rm(flac)
  await verifyExe(app, root, profile, folder, 'queue-restart')
})

const interfaceArchive = process.env.MUSTPLAY_040_ZIP
test('opens a 0.4.0 profile and restores its session on SQLite schema 11', { skip: !interfaceArchive, timeout: 90_000 }, async (t) => {
  const { root, folder, profile, app, flac } = await prepareRelease(t)
  unpack(interfaceArchive, root)
  await verifyExe(join(root, 'Music Player 0.4.0'), root, profile, folder, 'queue-import', '0.4.0')
  const database = join(profile, 'library.sqlite3')
  function checkSchema(schema) {
    using db = new DatabaseSync(database, { readOnly: true })
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, schema)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    return db.prepare('SELECT * FROM tracks ORDER BY rowid').all()
  }
  const tracks = checkSchema(5)
  await rm(flac)
  await verifyExe(app, root, profile, folder, 'queue-restart')
  assert.deepEqual(checkSchema(11), tracks)
})

const explainableBaselineArchive = process.env.MUSTPLAY_041_ZIP
test('restores 0.4.1 feedback and playback with explanations for fresh Wave entries', { skip: !explainableBaselineArchive, timeout: 90_000 }, async (t) => {
  const { root, folder, profile, app, flac } = await prepareRelease(t)
  unpack(explainableBaselineArchive, root)
  await verifyExe(join(root, 'Music Player 0.4.1'), root, profile, folder, 'wave-import', '0.4.1')
  await rm(flac)
  await verifyExe(app, root, profile, folder, 'wave-restart')
})
