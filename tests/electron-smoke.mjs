import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog } from 'electron'
import '../out/main/index.js'

const [folder, profile] = process.argv.slice(2)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

async function eventually(check, label) {
  const deadline = Date.now() + 5_000
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
  })`), { process: 'undefined', require: 'undefined', api: ['getPlayableSource', 'getTracks', 'importFolder'] })

  const session = webContents.session
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }))
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
    const refusal = await otherWindow.webContents.executeJavaScript(`(async () => {
      try {
        await window.musicPlayer.getTracks()
        return 'unexpectedly accepted'
      } catch (error) {
        return error.message
      }
    })()`)
    assert.match(refusal, /IPC sender denied/)
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

  async function waitForAudio(condition, label) {
    return waitFor(`(() => {
      const audio = document.querySelector('audio')
      return (${condition}) && audio.src
    })()`, label)
  }
  const advancing = '!audio.paused && audio.currentTime > 0.2'
  await click('Test Tone MP3')
  const mp3 = await waitForAudio(advancing, 'MP3 playback')
  await waitFor('!!document.querySelector(\'button[aria-label="Пауза"]\')', 'pause button')
  await click('Пауза')
  await waitForAudio('audio.paused', 'pause')
  await waitFor('!!document.querySelector(\'button[aria-label="Воспроизвести"]\')', 'resume button')
  await click('Воспроизвести')
  await waitForAudio('!audio.paused', 'resume')

  await click('Следующий трек')
  const flac = await waitForAudio(`${advancing} && audio.src !== ${JSON.stringify(mp3)} && audio.duration === 5`, 'FLAC playback')
  await click('Предыдущий трек')
  await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)}`, 'previous track')
  await run(`(() => {
    const audio = document.querySelector('audio')
    audio.currentTime = audio.duration - 0.1
  })()`)
  await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(flac)}`, 'automatic next track')

  await click('Предыдущий трек')
  await waitForAudio(`audio.src === ${JSON.stringify(mp3)}`, 'switch away from FLAC')
  await rm(join(folder, '02.flac'))
  assert.equal(await run(`fetch(${JSON.stringify(flac)}).then(response => response.status)`), 404)
  await click('Следующий трек')
  await waitFor('document.querySelector("[role=alert]")?.innerText.includes("Не удалось воспроизвести")', 'missing file error')
}

void verify().then(() => app.exit(0), (error) => {
  console.error(error)
  app.exit(1)
})
