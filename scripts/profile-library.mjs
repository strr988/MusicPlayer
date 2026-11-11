// Run with: node scripts/profile-library.mjs
// Each sample runs in a separate Electron process with a temporary profile.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { tmpdir, cpus, totalmem, release } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { mp3WithArtwork } from '../tests/fixtures/artwork.ts'
import { channels } from '../src/shared/contracts.ts'

const temp = realpathSync(tmpdir())

async function collect() {
  const { default: executable } = await import('electron')
  const repetitions = Number(process.env.MUSIC_PLAYER_PROFILE_REPEATS ?? 3)
  const sizes = (process.env.MUSIC_PLAYER_PROFILE_SIZES ?? '1000,5000,10000').split(',').map(Number)
  const samples = []
  let machine
  for (const size of sizes) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const root = mkdtempSync(join(temp, 'music-player-profile-'))
      try {
        await promisify(execFile)(executable, [fileURLToPath(import.meta.url), root, String(size), String(repetition)], { timeout: 60_000 })
        const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))
        machine = result.machine
        samples.push(result.sample)
        console.log(`${size} tracks, sample ${repetition}: ${Math.round(result.sample.firstMs)} ms initial display`)
      } finally {
        const actual = realpathSync(root)
        assert.equal(dirname(actual), temp)
        assert.ok(basename(actual).startsWith('music-player-profile-'))
        rmSync(actual, { recursive: true, force: true, maxRetries: 5 })
      }
    }
  }
  const json = JSON.stringify({ machine, samples }, null, 2)
  if (process.env.MUSIC_PLAYER_PROFILE_OUTPUT) writeFileSync(process.env.MUSIC_PLAYER_PROFILE_OUTPUT, json + '\n')
  else console.log(json)
}

function syntheticCatalog(size, realTrack) {
  return [realTrack, ...Array.from({ length: size - 1 }, (_, index) => ({
    ...realTrack,
    id: '10000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
    title: (index % 3 ? 'Night sessions' : 'Северный свет над заливом') + ' ' + ((index * 7919) % size) +
      (index % 8 === 0 ? ' — расширенная студийная запись из архива независимого радио' : ''),
    artist: index % 7 === 0 ? null : (index % 2 ? 'Ensemble ' : 'Группа ') + (index % 35),
    album: index % 9 === 0 ? null : 'Архивные записи и концертные сессии — том ' + (index % 151),
    durationSeconds: index % 11 ? 180 + index % 340 : null,
    format: index % 3 ? 'mp3' : 'flac',
    artworkUrl: index % 4 ? null : realTrack.artworkUrl,
  }))]
}

function installCounters() {
  const counts = window.__commits = { root: 0, library: 0, queue: 0, timeline: 0, libraryUpdates: 0 }
  const seen = new Map()
  // React DevTools hook. Component types are identified by their direct host children
  // because production minification can rename component functions.
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberRoot(_id, root) {
      counts.root++
      for (let fiber = root.current; fiber;) {
        if ((fiber.flags & 1) !== 0 && typeof fiber.type === 'function' && seen.get(fiber.type) !== fiber) {
          const first = fiber.child
          const props = first?.memoizedProps
          if (props?.className?.includes('timeline flex')) { counts.timeline++; seen.set(fiber.type, fiber) }
          if (props?.id === 'playback-queue') { counts.queue++; seen.set(fiber.type, fiber) }
          if (fiber.memoizedProps?.likedIds instanceof Set) {
            counts.library++
            seen.set(fiber.type, fiber)
            if (fiber.alternate) counts.libraryUpdates++
          }
        }
        if (fiber.child && fiber.type !== 'tbody' && fiber.type !== 'ol') { fiber = fiber.child; continue }
        while (fiber && !fiber.sibling) fiber = fiber.return
        fiber = fiber?.sibling
      }
    },
  }
}

async function profile({ app, BrowserWindow, dialog, ipcMain }, root, size, repetition) {
  app.setPath('userData', root)
  const fixture = name => readFileSync(new URL('../tests/fixtures/' + name, import.meta.url))
  const folder = join(root, 'audio')
  mkdirSync(folder)
  writeFileSync(join(folder, 'tone.mp3'), mp3WithArtwork(fixture('01-tone.mp3'), fixture('cover.jpg')))
  await import(process.env.MUSIC_PLAYER_PROFILE_BUILD ?
    pathToFileURL(join(process.env.MUSIC_PLAYER_PROFILE_BUILD, 'main', 'index.js')).href : '../out/main/index.js')
  await app.whenReady()
  while (!BrowserWindow.getAllWindows().length) await delay(20)
  const player = BrowserWindow.getAllWindows()[0]
  player.setContentSize(1280, 800)
  const wc = player.webContents
  const run = script => wc.executeJavaScript(script, true)
  async function waitFor(condition) {
    const deadline = performance.now() + 10_000
    while (!await run(condition).catch(() => false)) {
      if (performance.now() > deadline) throw new Error('Timed out: ' + condition)
      await delay(25)
    }
  }
  await waitFor('!!document.querySelector(".play-button")')
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  const [realTrack] = (await run('window.musicPlayer.importFolder()')).tracks
  assert.ok(realTrack.artworkUrl)
  wc.debugger.attach()
  await wc.debugger.sendCommand('Page.enable')
  await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `(${installCounters})()` })
  const catalog = syntheticCatalog(size, realTrack)
  ipcMain.removeHandler(channels.getTracks)
  ipcMain.handle(channels.getTracks, () => catalog)
  ipcMain.removeHandler(channels.setPlaybackSession)
  ipcMain.handle(channels.setPlaybackSession, () => undefined)

  const paint = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  const timed = action => run(`(async () => {
    const start = performance.now();
    ${action};
    await ${paint};
    return performance.now() - start;
  })()`)
  const search = value => `
    const input = document.querySelector('input[type=search]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles: true}));
  `
  const machine = { cpu: cpus()[0].model, threads: cpus().length, ramBytes: totalmem(),
    os: release(), arch: process.arch, versions: process.versions }
  const start = performance.now()
  await player.loadURL(wc.getURL())
  await waitFor('!!document.querySelector("tbody .track-button:enabled")')
  await run(paint)
  const firstMs = performance.now() - start
  assert.ok(await run('window.__commits?.root > 0'), 'React commit counter was not installed')
  const searchMs = await timed(search('северный'))
  assert.match(await run('document.querySelector(".track-name").textContent'), /Северный/)
  await timed(search(''))
  const sortMs = await timed(`
    const sort = document.querySelector('[aria-label="Сортировка"]');
    sort.value = 'title';
    sort.dispatchEvent(new Event('change', {bubbles: true}));
  `)
  assert.equal(await run('document.querySelector("th").getAttribute("aria-sort")'), 'ascending')
  const scroll = await run(`(async () => {
    const main = document.querySelector('main');
    const target = document.querySelector('tbody tr:nth-child(98)').getBoundingClientRect().top;
    const distance = Math.min(target, main.scrollHeight - main.clientHeight);
    const intervals = [];
    let previous = performance.now();
    for (let frame = 1; frame <= 32; frame++) {
      main.scrollTop = distance * (frame / 32);
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      intervals.push(now - previous);
      previous = now;
    }
    main.scrollTop = 0;
    return { over33ms: intervals.filter(ms => ms > 33.4).length, maxMs: Math.max(...intervals) };
  })()`)
  await run(`document.querySelector('.volume button[aria-pressed="false"]')?.click()`)
  await run(`document.querySelector('audio').loop = true; document.querySelector('.play-button').click()`)
  await waitFor('document.querySelector("audio").currentTime > 0.15')
  const queueMs = await timed('document.querySelector(".queue-toggle").click()')
  assert.equal(await run('document.querySelector(".queue-panel").hidden'), false)
  const queueRows = await run('document.querySelectorAll(".queue-list li").length')
  const queueActionMs = await timed(`document.querySelector('.queue-list li:nth-child(80) button[aria-label^="Убрать из очереди"]').click()`)
  const libraryRows = await run('document.querySelectorAll("tbody .track-button").length')
  const commits = await run('({...window.__commits})')
  const steady = await run(`(async () => {
    const before = {...window.__commits};
    const audio = document.querySelector('audio');
    let events = 0;
    const onTime = () => events++;
    audio.addEventListener('timeupdate', onTime);
    const start = audio.currentTime;
    await new Promise(resolve => setTimeout(resolve, 1400));
    audio.removeEventListener('timeupdate', onTime);
    return { events, advanced: (audio.currentTime - start + audio.duration) % audio.duration,
      commits: Object.fromEntries(Object.keys(before).map(key => [key, window.__commits[key] - before[key]])) };
  })()`)
  const memory = app.getAppMetrics().filter(({ pid }) => pid === process.pid || pid === wc.getOSProcessId())
    .map(({ type, memory }) => ({ type, workingSetKiB: memory.workingSetSize, privateKiB: memory.privateBytes }))
  const sample = { size, repetition, firstMs, searchMs, sortMs, scroll, queueMs, queueActionMs,
    libraryRows, queueRows, commits, steady, memory }
  assert.ok(steady.events > 0 && steady.advanced > 0.5, 'Audio did not advance during the steady-state sample')
  await run('document.querySelector("audio").pause()')
  writeFileSync(join(root, 'result.json'), JSON.stringify({ machine, sample }))
}

if (process.versions.electron) {
  const electron = await import('electron')
  const [root, size, repetition] = process.argv.slice(2)
  profile(electron, root, Number(size), Number(repetition)).then(() => electron.app.quit(), error => {
    console.error(error)
    electron.app.exit(1)
  })
} else {
  await collect()
}
