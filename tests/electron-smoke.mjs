import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog } from 'electron'
import '../out/main/index.js'

const [folder, profile, phase] = process.argv.slice(2)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

async function eventually(check, label) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(40)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

async function verify() {
  await app.whenReady()
  const player = await eventually(() => BrowserWindow.getAllWindows()[0], 'Electron window')
  const { webContents } = player
  const run = (script, gesture = false) => webContents.executeJavaScript(script, gesture).catch((error) => {
    throw new Error(`Renderer script failed: ${script}`, { cause: error })
  })
  const buttons = '[...document.querySelectorAll("button")]'
  const click = (label) => run(`${buttons}.find(button =>
    (button.getAttribute('aria-label') ?? button.innerText).includes(${JSON.stringify(label)})).click()`, true)
  const waitFor = (script, label) => eventually(() => run(script), label)

  await waitFor('document.querySelector("h1")?.innerText === "Библиотека"', 'library UI')
  assert.equal(webContents.getURL(), 'music-player://app/')
  const { sandbox, contextIsolation, nodeIntegration } = webContents.getLastWebPreferences()
  assert.deepEqual({ sandbox, contextIsolation, nodeIntegration }, { sandbox: true, contextIsolation: true, nodeIntegration: false })
  assert.deepEqual(await run(`({
    process: typeof window.process,
    require: typeof window.require,
    api: Object.keys(window.musicPlayer).sort()
  })`), { process: 'undefined', require: 'undefined', api: ['getListeningData', 'getPlayableSource', 'getTracks', 'getWaveQueue', 'importFolder', 'recordPlaybackEvent', 'setTrackPreference'] })

  const session = webContents.session
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }))

  async function waitForAudio(condition, label) {
    return waitFor(`(() => {
      const audio = document.querySelector('audio')
      return (${condition}) && audio.src
    })()`, label)
  }
  const advancing = '!audio.paused && audio.currentTime > 0.2'
  const stateFile = join(profile, 'smoke-state.json')
  if (phase === 'wave-import') {
    assert.equal(await run(`${buttons}.find(button => button.innerText === 'Моя волна').disabled`), true)
    assert.deepEqual(await run('window.musicPlayer.getWaveQueue()'), [])
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click('Выбрать папку')
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'imported wave catalog')
    const tracks = await run('window.musicPlayer.getTracks()')
    const mp3Id = tracks.find(track => track.format === 'mp3').id
    const flacId = tracks.find(track => track.format === 'flac').id
    const queue = await run('window.musicPlayer.getWaveQueue()')
    assert.deepEqual(new Set(queue), new Set([mp3Id, flacId]))
    await click('Лайк: Test Tone FLAC')
    await waitFor('(async () => (await window.musicPlayer.getListeningData()).preferences.some(p => p.liked))()', 'wave preference saved')
    assert.deepEqual(await run('window.musicPlayer.getWaveQueue()'), [flacId, mp3Id])

    await click('Моя волна')
    const flac = await waitForAudio(`${advancing} && audio.duration === 5`, 'liked FLAC played by wave')
    await waitFor('document.querySelector("footer [role=status]").innerText.includes("Режим")', 'wave mode')
    assert.equal(await run('document.querySelectorAll("audio").length'), 1)
    await click('Пауза')
    await waitForAudio('audio.paused', 'pause in wave')
    const paused = await run('window.musicPlayer.getListeningData()')
    assert.deepEqual(paused.events.map(event => event.type), ['started'])
    await click('Лайк: Test Tone MP3')
    await waitFor(`(async () => (await window.musicPlayer.getListeningData()).preferences
      .some(p => p.trackId === ${JSON.stringify(mp3Id)} && p.liked))()`, 'new like saved in wave mode')
    await click('Следующий трек')
    const mp3 = await waitForAudio(`${advancing} && audio.src !== ${JSON.stringify(flac)}`, 'next wave track after skip')
    const skipped = await run('window.musicPlayer.getListeningData()')
    assert.ok(skipped.events.some(event => event.type === 'skipped' && event.trackId === flacId))
    await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(flac)}`, 'automatic wave transition after completion')
    const feedback = await run('window.musicPlayer.getListeningData()')
    assert.ok(feedback.events.some(event => event.type === 'completed' && event.trackId === mp3Id))
    await writeFile(stateFile, JSON.stringify({ mp3Id, mp3, feedback }))
    return
  }
  if (phase === 'wave-restart') {
    const { mp3Id, mp3, feedback } = JSON.parse(await readFile(stateFile, 'utf8'))
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'restored wave catalog')
    assert.deepEqual(await run('window.musicPlayer.getListeningData()'), feedback)
    assert.deepEqual(await run('window.musicPlayer.getWaveQueue()'), [mp3Id])
    await click('Моя волна')
    await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)}`, 'only available track plays after restart')
    await waitFor('document.querySelector("footer [role=status]").innerText.includes("других доступных")', 'singleton wave stops after playback')
    await rm(join(folder, '01.mp3'))
    await click('Моя волна')
    await waitFor('document.querySelector("footer [role=status]").innerText.includes("нет доступных")', 'wave handles missing files')
    assert.deepEqual(await run('window.musicPlayer.getWaveQueue()'), [])
    await click('Test Tone MP3')
    await waitFor('!document.querySelector("footer [role=status]")', 'manual selection returns to library mode')
    return
  }
  if (phase === 'restart') {
    const { tracks, mp3, feedback } = JSON.parse(await readFile(stateFile, 'utf8'))
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'restored library UI')
    assert.deepEqual(await run('window.musicPlayer.getTracks()'), tracks)
    assert.deepEqual(await run('window.musicPlayer.getListeningData()'), feedback)
    await waitFor(`document.querySelector('button[aria-label="Лайк: Test Tone MP3"]')?.getAttribute("aria-pressed") === "true"`, 'restored like')
    const flacId = tracks.find(({ format }) => format === 'flac').id
    assert.equal(await run(`window.musicPlayer.getPlayableSource(${JSON.stringify(flacId)})`), null)
    await click('Test Tone MP3')
    await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)}`, 'restored MP3 playback')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    const rescan = await run('window.musicPlayer.importFolder()')
    assert.deepEqual(rescan, { status: 'complete', tracks, processed: 1, issues: [{ entry: 'broken.mp3', reason: 'file-unreadable' }] })
    return
  }

  const otherWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      session,
      preload: fileURLToPath(new URL('../out/preload/index.cjs', import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  try {
    await otherWindow.loadURL(webContents.getURL())
    const refusals = await otherWindow.webContents.executeJavaScript(`Promise.all(
      [window.musicPlayer.getTracks(), window.musicPlayer.getWaveQueue()]
        .map(result => result.then(() => 'unexpectedly accepted', error => error.message))
    )`)
    for (const refusal of refusals) assert.match(refusal, /IPC sender denied/)
  } finally {
    otherWindow.destroy()
  }

  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  assert.deepEqual(await run('window.musicPlayer.importFolder()'), { status: 'cancelled' })
  dialog.showOpenDialog = async (_window, options) => {
    assert.ok(options.properties.includes('openDirectory'))
    return { canceled: false, filePaths: [folder] }
  }
  await click('Выбрать папку')
  await waitFor('document.querySelectorAll("tbody tr").length === 2', 'two imported tracks')
  const library = await run('document.querySelector("main").innerText')
  assert.match(library, /Test Tone MP3/)
  assert.match(library, /Test Tone FLAC/)
  assert.match(library, /Fixture Artist/)
  assert.match(library, /Fixture Album/)
  assert.match(library, /Ошибки импорта \(1\)/)
  assert.deepEqual(await run(`(async () => ({
    arbitraryPath: await window.musicPlayer.getPlayableSource('C:/Windows/win.ini'),
    unknownSource: (await fetch('/audio/00000000-0000-0000-0000-000000000000')).status,
    arbitraryAsset: (await fetch('/assets/win.ini')).status
  }))()`), { arbitraryPath: null, unknownSource: 404, arbitraryAsset: 404 })

  const tracks = await run('window.musicPlayer.getTracks()')
  assert.deepEqual((await run('window.musicPlayer.importFolder()')).tracks, tracks)
  const flacId = tracks.find(track => track.format === 'flac').id
  await click('Лайк: Test Tone MP3')
  await waitFor('(async () => (await window.musicPlayer.getListeningData()).preferences.some(p => p.liked))()', 'saved like')
  await click('Лайк: Test Tone FLAC')
  await waitFor('(async () => (await window.musicPlayer.getListeningData()).preferences.filter(p => p.liked).length === 2)()', 'second like')
  await click('Лайк: Test Tone FLAC')
  await waitFor('(async () => (await window.musicPlayer.getListeningData()).preferences.filter(p => p.liked).length === 1)()', 'cancelled like')
  assert.match(await run(`window.musicPlayer.setTrackPreference('bad-id', true).then(() => 'accepted', e => e.message)`), /Invalid preference/)
  await click('Test Tone MP3')
  const mp3 = await waitForAudio(advancing, 'MP3 playback')
  await waitFor('!!document.querySelector(\'button[aria-label="Пауза"]\')', 'pause button')
  await click('Пауза')
  await waitForAudio('audio.paused', 'pause')
  const pausedEvents = (await run('window.musicPlayer.getListeningData()')).events
  assert.deepEqual(pausedEvents.map(e => e.type), ['started'])
  await waitFor('!!document.querySelector(\'button[aria-label="Воспроизвести"]\')', 'resume button')
  await click('Воспроизвести')
  await waitForAudio('!audio.paused', 'resume')

  await click('Следующий трек')
  const flac = await waitForAudio(`${advancing} && audio.src !== ${JSON.stringify(mp3)} && audio.duration === 5`, 'FLAC playback')
  await click('Предыдущий трек')
  await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)}`, 'previous track')
  const manualEvents = (await run('window.musicPlayer.getListeningData()')).events
  assert.deepEqual(manualEvents.map(e => e.type), ['started', 'skipped', 'started', 'skipped', 'started'])
  await run(`(() => {
    const audio = document.querySelector('audio')
    audio.currentTime = audio.duration - 0.1
  })()`)
  await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(flac)}`, 'automatic next track')

  await waitFor('(async () => (await window.musicPlayer.getListeningData()).events.some(e => e.type === "ended"))()', 'seek ending recorded without completion')
  assert.equal((await run('window.musicPlayer.getListeningData()')).events.some(e => e.type === 'completed'), false)
  await click('Предыдущий трек')
  await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)}`, 'full MP3 playback')
  await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(flac)}`, 'natural MP3 ending')
  await waitFor('(async () => (await window.musicPlayer.getListeningData()).events.some(e => e.type === "completed"))()', 'completed listening')
  await click('Предыдущий трек')
  await waitForAudio(`audio.src === ${JSON.stringify(mp3)}`, 'switch away from FLAC')
  await rm(join(folder, '02.flac'))
  assert.equal(await run(`fetch(${JSON.stringify(flac)}).then(response => response.status)`), 404)
  await click('Следующий трек')
  await waitFor('document.querySelector("[role=alert]")?.innerText.includes("Не удалось воспроизвести")', 'missing file error')
  await waitFor('(async () => (await window.musicPlayer.getListeningData()).events.some(e => e.type === "error"))()', 'unavailable file error event')
  const feedback = await run('window.musicPlayer.getListeningData()')
  assert.equal(feedback.events.at(-1).type, 'error')
  assert.equal(feedback.events.at(-1).trackId, flacId)
  for (const sessionId of new Set(feedback.events.map(e => e.sessionId))) {
    const events = feedback.events.filter(e => e.sessionId === sessionId)
    assert.ok(events.filter(e => e.type === 'started').length <= 1)
    assert.ok(events.filter(e => e.type !== 'started').length <= 1)
  }
  await writeFile(stateFile, JSON.stringify({ tracks, mp3, feedback }))
}

void verify().then(() => app.quit(), (error) => {
  console.error(error)
  app.exit(1)
})
