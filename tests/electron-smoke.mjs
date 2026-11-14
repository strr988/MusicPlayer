import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog } from 'electron'
import { verifyInterface } from './interface-smoke.mjs'
import { verifyPlayerExperience } from './player-experience-smoke.mjs'

async function eventually(check, label) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(40)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

export async function verify(folder, profile, phase, preload = fileURLToPath(new URL('../out/preload/index.cjs', import.meta.url))) {
  await app.whenReady()
  const player = await eventually(() => BrowserWindow.getAllWindows()[0], 'Electron window')
  const { webContents } = player
  const v8 = !app.isPackaged || app.getVersion() === '0.8.0'
  const mustplay = v8 || app.getVersion() === '0.7.0'
  const rendererApi = mustplay ? 'window.mustplay' : 'window.musicPlayer'
  const origin = mustplay ? 'mustplay://app' : 'music-player://app'
  const run = (script, gesture = false) => webContents.executeJavaScript(
    script.replaceAll('window.mustplay', rendererApi).replaceAll('mustplay://app', origin), gesture,
  ).catch((error) => {
    throw new Error(`Renderer script failed: ${script}`, { cause: error })
  })
  const buttons = '[...document.querySelectorAll("button")]'
  const click = (label) => run(`(() => {
    const label = ${JSON.stringify(label)}
    const candidates = ${buttons}.filter(button => button.getClientRects().length && !button.closest('[inert]'))
    const name = button => (button.getAttribute('aria-label') ?? button.innerText).trim()
    const target = candidates.find(button => name(button) === label) ??
      candidates.find(button => name(button).includes(label))
    if (!target || target.disabled) throw new Error('Button unavailable: ' + label)
    target.click()
  })()`, true)
  const waitFor = async (script, label) => {
    try {
      return await eventually(() => run(script), label)
    } catch (error) {
      const snapshot = await run(`(() => {
        const audio = document.querySelector('audio')
        return { player: document.querySelector('footer')?.innerText, width: innerWidth,
          audio: audio && { src: audio.src, paused: audio.paused, time: audio.currentTime,
            muted: audio.muted, error: audio.error?.message },
          rows: [...document.querySelectorAll('tbody tr')].slice(0, 6).map(row => row.innerText),
          images: [...document.images].slice(0, 6).map(image => ({ src: image.src, width: image.naturalWidth, complete: image.complete }))
        }
      })()`)
      throw new Error(`${error.message}\n${JSON.stringify(snapshot)}`, { cause: error })
    }
  }
  const setInput = (selector, value) => run(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const search = value => setInput('input[type=search]', value)
  const choose = (label, value) => run(`(() => {
    const select = document.querySelector(${JSON.stringify(`select[aria-label="${label}"]`)})
    select.value = ${JSON.stringify(value)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)

  const importLabel = v8 ? 'Добавить папку' : 'Выбрать папку'
  await waitFor('document.querySelector("h1")?.innerText === "Библиотека"', 'library UI')
  await waitFor(`${buttons}.some(button => button.getClientRects().length &&
    button.innerText.includes(${JSON.stringify(importLabel)}) && !button.disabled)`, 'library initialized')
  const modern = !app.isPackaged || !['0.1.1', '0.2.0', '0.3.0'].includes(app.getVersion())
  const playerExperience = mustplay || app.getVersion() === '0.6.0'
  const explainable = playerExperience || app.getVersion() === '0.5.0'
  const openWave = async () => {
    if (modern) await click('Моя волна')
  }
  const waveStart = modern ? 'document.querySelector(".wave-start .primary")'
    : `${buttons}.find(button => button.innerText === 'Моя волна')`
  const startWave = async () => {
    await openWave()
    await run(`(${waveStart}).click()`, true)
  }
  const waveSelector = 'select[aria-label="Режим «Моей волны»"]'
  const modeControl = mode => modern
    ? `document.querySelector('input[name="wave-mode"][value="${mode}"]')`
    : `document.querySelector('${waveSelector}')`
  const chooseWaveMode = async mode => {
    await openWave()
    if (modern) await run(`${modeControl(mode)}.click()`)
    else await choose('Режим «Моей волны»', mode)
  }
  const checkWaveMode = mode => waitFor(modern
    ? `(${modeControl(mode)}).checked && !document.querySelector('.wave-modes[aria-busy="true"]')`
    : `(${modeControl(mode)}).value === '${mode}' && !(${modeControl(mode)}).disabled`, `${mode} setting acknowledged`)
  const queueToggle = 'button[aria-controls="playback-queue"]'
  const openQueue = async () => {
    if (modern) await run(`document.querySelector('${queueToggle}').click()`)
  }
  const closeQueue = async () => {
    if (modern) await click('Закрыть очередь')
  }
  assert.equal(webContents.getURL(), `${origin}/`)
  const { sandbox, contextIsolation, nodeIntegration } = webContents.getLastWebPreferences()
  assert.deepEqual({ sandbox, contextIsolation, nodeIntegration }, { sandbox: true, contextIsolation: true, nodeIntegration: false })
  const oldApi = [
    'getListeningData', 'getPlayableSource', 'getTracks', 'getVolume', 'getWaveQueue',
    'importFolder', 'recordPlaybackEvent', 'setTrackPreference', 'setVolume',
  ]
  const playlistApi = oldApi.concat([
    'addPlaylistTrack', 'createPlaylist', 'deletePlaylist', 'getPlaylists', 'getWaveMode',
    'movePlaylistTrack', 'removePlaylistTrack', 'renamePlaylist', 'setWaveMode',
  ]).sort()
  const expectedApi = phase === 'legacy-import' ? oldApi :
    app.getVersion() === '0.2.0' && app.isPackaged ? playlistApi :
      playlistApi.concat(['getPlaybackSession', 'setPlaybackSession'], explainable ? ['getWaveRecommendations'] : [],
        playerExperience ? ['getLyrics', 'openMiniPlayer', 'publishMiniState', 'onMiniVisibility',
          'onPlaybackCommand', 'getShortcuts', 'setShortcut', 'setShortcutCapture', 'rescanLibrary',
          'getWavePulse', 'setWavePulse'] : [],
        mustplay ? ['getInterfaceScale', 'setInterfaceScale', 'getSoundEffect', 'setSoundEffect', 'setTheme',
          'setReverb', 'getDiscoMode', 'setDiscoMode', 'publishDiscoBeat'] : [],
        v8 ? ['getMusicFolders', 'removeMusicFolder', 'getCursorSettings', 'setCursorPreset', 'importCursorPreset',
          'onShowFullPlayer', 'exitMiniFullscreen', 'getLyricsMode', 'setLyricsMode'] : []).sort()
  assert.deepEqual(await run(`({
    process: typeof window.process,
    require: typeof window.require,
    api: Object.keys(${rendererApi}).sort()
  })`), { process: 'undefined', require: 'undefined', api: expectedApi })

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
  const finishTrack = () => run(`(() => {
    const audio = document.querySelector('audio')
    audio.currentTime = audio.duration - 0.06
  })()`)
  const sessionState = () => run('window.mustplay.getPlaybackSession()')
  const pendingRows = () => run(`[...document.querySelectorAll('[data-queue-entry]')].map(row => ({
    id: row.dataset.queueEntry, title: row.firstElementChild.getAttribute('title')
  }))`)
  const setRepeat = async value => {
    if (!v8) return choose('Режим повтора', value)
    for (let step = 0; step < 3; step++) {
      if (await run(`document.querySelector('footer .repeat-control').dataset.repeat`) === value) return
      await click('Режим повтора')
    }
    assert.fail('Repeat cycle did not reach ' + value)
  }

  if (phase === 'local-flac-in-m4a') {
    const path = process.env.MUSTPLAY_TEST_M4A_PATH
    assert.equal(folder, path)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dirname(path)] })
    await click(importLabel)
    const title = 'Smells Like Teen Spirit'
    await waitFor(`[...document.querySelectorAll('.track-button')].some(button =>
      button.getAttribute('aria-label').includes(${JSON.stringify(title)}) && !button.disabled)`, 'original M4A imported')
    const tracks = await run('window.mustplay.getTracks()')
    const track = tracks.find(item => item.format === 'm4a' && item.title.includes(title))
    assert.ok(track?.available)
    await click('Без звука')
    await click(track.title)
    await waitForAudio(advancing + ' && audio.duration > 250', 'original FLAC-in-M4A decodes')
    await run('document.querySelector("audio").currentTime = 150')
    await waitForAudio('!audio.paused && audio.currentTime > 150.2', 'original FLAC-in-M4A seeks and decodes')
    return
  }

  if (phase === 'audio-formats') {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click(importLabel)
    await waitFor('document.querySelectorAll("tbody tr").length === 9 && !document.querySelector(".track-button").disabled', 'supported formats in library')
    const result = await run('window.mustplay.importFolder()')
    assert.equal(result.status, 'complete')
    assert.deepEqual(result.issues, [
      { entry: 'broken.mp3', reason: 'file-unreadable' },
      { entry: 'lossless-apple.m4a', reason: 'codec-unsupported' },
    ])
    await click('Без звука')
    const tracks = result.tracks
    const mimes = {
      aac: 'audio/aac', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
    }
    const extraTracks = tracks.filter(track => Object.hasOwn(mimes, track.format))
    assert.equal(extraTracks.filter(track => track.format === 'm4a').length, 2)
    for (const track of extraTracks) {
      assert.ok(track.available, 'Imported ' + track.title)
      const mime = mimes[track.format]
      const { url } = await run('window.mustplay.getPlayableSource(' + JSON.stringify(track.id) + ')')
      const result = await run('fetch(' + JSON.stringify(url) +
        ', {headers:{range:"bytes=0-31"}}).then(async res => [res.status,res.headers.get("content-type"),(await res.arrayBuffer()).byteLength])')
      assert.deepEqual(result, [206, mime, 32])
      await click(track.title)
      await waitForAudio(advancing + ' && audio.src === ' + JSON.stringify(url), 'decode ' + track.title)
    }
    return
  }

  if (phase === 'folder-exclusion') {
    const nested = join(folder, 'Nested')
    await mkdir(nested)
    await rename(join(folder, '02.flac'), join(nested, '02.flac'))
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click(importLabel)
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'parent and child audio imported')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nested] })
    await click(importLabel)
    await click('Музыкальные папки')
    await waitFor('document.querySelectorAll(".music-folders:popover-open li").length === 2', 'both music folders are listed')
    await click('Музыкальные папки')
    await click('Test Tone MP3')
    const source = await waitForAudio(advancing, 'playing audio from parent folder')
    const folders = await run('window.mustplay.getMusicFolders()')
    const mp3Track = (await run('window.mustplay.getTracks()')).find(track => track.format === 'mp3')
    await assert.rejects(run('window.mustplay.removeMusicFolder("C:/Music")'), /Renderer script failed/)
    await click('Музыкальные папки')
    await click('Исключить папку ' + folders[0].label)
    await waitFor('document.querySelectorAll("tbody tr").length === 1 && !document.querySelector("audio").hasAttribute("src")', 'removal stops excluded playback and retains overlapping folder')
    await click('Музыкальные папки')
    assert.equal((await sessionState()).queue.current, null)
    assert.equal(await run('window.mustplay.getPlayableSource(' + JSON.stringify(mp3Track.id) + ')'), null)
    assert.equal(await run('fetch(' + JSON.stringify(source) + ').then(res => res.status)'), 404)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click(importLabel)
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'removed folder can be imported again')
    const restored = (await run('window.mustplay.getTracks()')).find(track => track.format === 'mp3')
    assert.equal(restored.id, mp3Track.id)
    assert.notEqual((await run('window.mustplay.getPlayableSource(' + JSON.stringify(restored.id) + ')')).url, source)
    return
  }

  if (phase === 'library-rescan') {
    const empty = join(folder, 'Позже')
    await mkdir(empty)
    await click('Обновить')
    await waitFor('document.querySelector("main").innerText.includes("Сначала выберите папку")', 'empty profile suggests importing')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [empty] })
    await click(importLabel)
    await waitFor('document.querySelector("main").innerText.includes("В папке нет")', 'empty folder registered')
    const mp3 = join(folder, '01.mp3')
    await copyFile(mp3, join(empty, 'later.mp3'))
    let dialogs = 0
    dialog.showOpenDialog = async () => { dialogs++; return { canceled: true, filePaths: [] } }
    await click('Обновить')
    await waitFor('document.querySelectorAll("tbody tr").length === 1', 'rescan discovers file in previously empty folder')
    assert.equal(dialogs, 0)
    return
  }

  if (phase === 'library-rescan-restart') {
    const empty = join(folder, 'Позже')
    const other = join(folder, 'Другая папка')
    await mkdir(other)
    await copyFile(join(folder, '02.flac'), join(other, '02.flac'))
    await waitFor('document.querySelectorAll("tbody tr").length === 1', 'original folder survives restart')
    const [original] = await run('window.mustplay.getTracks()')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [other] })
    await click(importLabel)
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'second folder imported')
    await rename(empty, join(folder, 'Перемещённая папка'))
    await copyFile(join(folder, '01.mp3'), join(other, 'new.mp3'))
    let dialogs = 0
    dialog.showOpenDialog = async () => { dialogs++; return { canceled: true, filePaths: [] } }
    await click('Обновить')
    await waitFor('document.querySelectorAll("tbody tr").length === 2 && !!document.querySelector(".import-result summary")',
      'rescan discovers new track and hides missing file')
    const tracks = await run('window.mustplay.getTracks()')
    assert.equal(tracks.find(track => track.id === original.id)?.available, false)
    await run('document.querySelector(".import-result summary").click()')
    assert.match(await run('document.querySelector(".import-result").innerText'), /Позже — папка недоступна/)
    await click('Обновить')
    await waitFor('!document.querySelector(".library-folder-actions .secondary").disabled', 'repeat rescan completes')
    assert.deepEqual(await run('window.mustplay.getTracks()'), tracks)
    assert.equal(dialogs, 0)
    return
  }

  if (phase === 'experience' || phase === 'experience-restart') {
    await verifyPlayerExperience({
      player, folder, run, click, waitFor, waitForAudio, choose, finishTrack, sessionState, setRepeat, importLabel, v8,
      restart: phase === 'experience-restart',
    })
    return
  }

  if (phase === 'scale-effects' || phase === 'scale-effects-restart') {
    await click('Настройки')
    const selector = label => `document.querySelector(${JSON.stringify(`select[aria-label="${label}"]`)})`
    const ready = label => `${selector(label)} && !${selector(label)}.disabled`
    const scale = 'Масштаб интерфейса'
    const effect = 'Звуковой эффект'
    await waitFor(ready(scale), 'interface scale loaded')
    assert.equal(await run('document.querySelector(".window-title strong").textContent'), 'mustplay')
    const openSound = () => click('Звуковые эффекты')
    const wet = 'document.querySelector(".sound-menu:popover-open [role=switch]")'
    const checkWet = (enabled) => waitFor(`${wet} && !${wet}.disabled && ${wet}.checked === ${enabled}`, 'reverb state for current preset')
    if (phase === 'scale-effects-restart') {
      assert.equal(await run(`${selector(scale)}.value`), '125')
      await openSound()
      await waitFor(ready(effect), 'sound effect loaded')
      assert.equal(await run(`${selector(effect)}.value`), 'slowed')
      await checkWet(true)
      assert.equal(await run('window.mustplay.getDiscoMode()'), true)
      assert.equal(webContents.getZoomFactor(), 1.25)
      assert.equal(await run('document.querySelector("audio").playbackRate'), 0.8)
      await run('window.mustplay.openMiniPlayer()')
      const mini = BrowserWindow.getAllWindows().find(window => window !== player)
      assert.ok(mini)
      const miniRun = code => mini.webContents.executeJavaScript(code, true)
      await miniRun('document.querySelector(".sound-button").click()')
      await eventually(() => miniRun(`${wet}?.checked && !${wet}?.disabled`), 'mini shows current reverb')
      await miniRun(`${wet}.click()`)
      await eventually(() => miniRun(`${wet} && !${wet}.disabled && !${wet}.checked`), 'mini disables reverb')
      assert.equal(await run('window.mustplay.getSoundEffect().then(sound => sound.reverb.slowed)'), false)
      assert.equal(mini.webContents.getZoomFactor(), 1.25)
      const [miniWidth, miniHeight] = mini.getContentSize()
      assert.ok(miniWidth >= 487 && miniHeight >= 249)
      assert.equal(await mini.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('.mini-player')
        return panel.scrollWidth <= panel.clientWidth && panel.scrollHeight <= panel.clientHeight
      })()`), true)
      mini.close()
      return
    }

    assert.equal(await run('window.mustplay.setInterfaceScale(300).then(() => false, () => true)'), true)
    assert.equal(await run('window.mustplay.setSoundEffect("unknown").then(() => false, () => true)'), true)
    assert.equal(await run('window.mustplay.setReverb("original", 1).then(() => false, () => true)'), true)
    const width = await run('innerWidth')
    await choose(scale, '150')
    await waitFor(`${ready(scale)} && ${selector(scale)}.value === '150' && innerWidth < ${width}`, 'zoom changes available UI width')
    assert.ok(Math.abs(webContents.getZoomFactor() - 1.5) < 0.005)
    player.setSize(620, 520)
    await waitFor('innerWidth < 420', 'minimum window with 150% zoom')
    assert.equal(await run(`['nav', 'footer', 'main'].every(selector => {
      const element = document.querySelector(selector)
      return element.scrollWidth <= element.clientWidth
    })`), true)
    await choose(scale, '125')
    await waitFor(`${ready(scale)} && ${selector(scale)}.value === '125'`, '125% saved')
    player.setSize(1100, 760)

    await run('document.querySelector(".disco-setting input").click()')
    await waitFor('!!document.querySelector(".shell > .disco-layer")', 'disco enabled')
    await click('Библиотека')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click(importLabel)
    await waitFor('document.querySelectorAll("tbody tr").length === 2 && !document.querySelector(".track-button").disabled', 'effect catalog')
    await click('Test Tone MP3')
    await waitForAudio(advancing, 'original starts')
    await openSound()
    await waitFor(ready(effect), 'sound effect loaded')
    await choose(effect, 'speed-up')
    await waitForAudio('!audio.paused && audio.playbackRate === 1.25 && !audio.preservesPitch', 'speed up changes rate and pitch live')
    await checkWet(false)
    await run(`${wet}.click()`)
    await checkWet(true)
    await click('Следующий трек')
    await waitForAudio('!audio.paused && audio.duration === 5 && audio.playbackRate === 1.25', 'effect remains after changing from MP3 to FLAC')
    await choose(effect, 'original')
    await waitForAudio('!audio.paused && audio.playbackRate === 1 && audio.preservesPitch', 'original restores speed and pitch')
    await checkWet(false)
    await run(`${wet}.click()`)
    await checkWet(true)
    await choose(effect, 'speed-up')
    await checkWet(true)
    await choose(effect, 'slowed')
    await waitForAudio('!audio.paused && audio.playbackRate === 0.8 && !audio.preservesPitch', 'slowed changes rate and pitch live')
    await checkWet(false)
    await run(`${wet}.click()`)
    await checkWet(true)
    return
  }

  if (phase === 'interface') {
    await verifyInterface({ player, run, click, waitFor, waitForAudio, folder, pendingRows, importLabel, v8 })
    return
  }

  if (phase === 'verify-v4') {
    const { playlist } = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.deepEqual(await run('window.mustplay.getPlaylists()'), [playlist])
    assert.equal(await run('window.mustplay.getWaveMode()'), 'discovery')
    assert.equal(await run('document.querySelector("audio").paused'), true)
    return
  }

  if (phase === 'wave-queue') {
    // Capture the callbacks submitted to Chromium while keeping real API registration.
    await run(`(() => {
      const media = navigator.mediaSession
      const register = media.setActionHandler.bind(media)
      window.testMediaActions = Object.create(null)
      media.setActionHandler = (action, handler) => {
        register(action, handler)
        window.testMediaActions[action] = handler
      }
    })()`)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click(importLabel)
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'Wave queue catalog')
    await openWave()
    await waitFor(`!(${waveStart}).disabled`, 'Wave ready')
    await click('Библиотека')
    await click('Shuffle')
    await setRepeat('all')
    await click('Лайк: Test Tone FLAC')
    await waitFor('(async () => (await window.mustplay.getListeningData()).preferences.some(p => p.liked))()', 'Wave like persisted')
    const beforeCalculation = await run('window.mustplay.getListeningData()')
    const trace = await run('window.mustplay.getWaveRecommendations()')
    assert.equal(trace.decisions.length, 2)
    assert.equal(trace.decisions[0].factors.likedTrack, 6)
    assert.deepEqual(await run('window.mustplay.getListeningData()'), beforeCalculation)
    await startWave()
    const flac = await waitForAudio(`${advancing} && audio.duration === 5`, 'Wave plays liked FLAC')
    await waitFor('document.querySelector(".wave-status[role=status]")?.innerText.includes("Сейчас играет")', 'Wave shows the active track')
    await waitFor('!!document.querySelector(".wave-explanation summary")', 'automatic recommendation has an explanation')
    await run('document.querySelector(".wave-explanation summary").click()')
    assert.match(await run('document.querySelector(".wave-explanation").innerText'), /отметили этот трек лайком/)
    await run('document.querySelector(".wave-diagnostics summary").click()')
    assert.match(await run('document.querySelector(".wave-diagnostics").innerText'), /Итоговый балл/)
    await click('Библиотека')
    await waitFor('navigator.mediaSession.metadata?.title === "Test Tone FLAC" && navigator.mediaSession.playbackState === "playing"', 'Windows media metadata')
    await click('Добавить в очередь: Test Tone FLAC')
    await click('Воспроизвести следующим: Test Tone MP3')
    await openQueue()
    const manual = await pendingRows()
    assert.deepEqual(manual.map(row => row.title), ['Test Tone MP3', 'Test Tone FLAC'])
    assert.equal(await run(`document.querySelector('button[aria-label="Shuffle"]').disabled`), true)

    const keyboardSpace = selector => run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(
      new KeyboardEvent('keydown', {code: 'Space', bubbles: true, cancelable: true}))`)
    await keyboardSpace('input[type=search]')
    assert.equal(await run('document.querySelector("audio").paused'), false)
    await keyboardSpace('body')
    await waitForAudio('audio.paused', 'Space outside text fields pauses playback')
    const media = async action => {
      const key = JSON.stringify(action)
      await waitFor(`typeof window.testMediaActions?.[${key}] === 'function'`, `registered Media Session ${action}`)
      assert.equal(await run(`(() => {
        try { window.testMediaActions[${key}]({action: ${key}}); return 'ok' }
        catch (error) { return String(error) }
      })()`, true), 'ok')
    }
    await media('play')
    await waitForAudio('!audio.paused', 'Media Session play resumes')
    await media('pause')
    await waitForAudio('audio.paused', 'Media Session pause works')
    await chooseWaveMode('discovery')
    await waitFor('(async () => (await window.mustplay.getWaveMode()) === "discovery")()', 'mode changed during manual queue')
    assert.deepEqual(await pendingRows(), manual)
    await media('nexttrack')
    await waitForAudio(`${advancing} && audio.src !== '${flac}'`, 'Media Session next plays priority item')
    assert.equal((await sessionState()).queue.current, manual[0].id)
    assert.equal(await run('!!document.querySelector(".wave-explanation")'), false)
    await finishTrack()
    await waitForAudio(`${advancing} && audio.src === '${flac}'`, 'manual tail plays after priority item')
    assert.equal((await sessionState()).queue.current, manual[1].id)
    await finishTrack()
    await waitForAudio(`${advancing} && audio.src !== '${flac}'`, 'radio continues after manual entries with Repeat All selected')
    const { queue } = await sessionState()
    assert.equal(queue.entries.find(entry => entry.id === queue.current).kind, 'recommendation')
    assert.deepEqual(queue.pending, [])
    await waitFor('document.querySelector(".queue-current").innerText.includes("Test Tone MP3")', 'open queue reflects recommendation')
    const feedback = await run('window.mustplay.getListeningData()')
    assert.deepEqual(feedback.events.map(event => event.type),
      ['started', 'skipped', 'started', 'ended', 'started', 'ended', 'started'])
    return
  }

  if (phase === 'queue-import') {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click(importLabel)
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'queue catalog')
    await waitFor('!document.querySelector(".track-button").disabled', 'session loaded')
    const [mp3Track, flacTrack] = await run('window.mustplay.getTracks()')
    assert.equal(mp3Track.format, 'mp3')
    const mp3 = await run(`window.mustplay.getPlayableSource('${mp3Track.id}').then(source => source.url)`)
    const flac = await run(`window.mustplay.getPlayableSource('${flacTrack.id}').then(source => source.url)`)
    await click('Test Tone MP3')
    await waitForAudio(`${advancing} && audio.src === '${mp3}'`, 'queue starts on selected library track')
    await click('Добавить в очередь: Test Tone FLAC')
    await click('Воспроизвести следующим: Test Tone MP3')
    await openQueue()
    const initial = await pendingRows()
    assert.deepEqual(initial.map(row => row.title), ['Test Tone MP3', 'Test Tone FLAC', 'Test Tone FLAC'])
    assert.equal(new Set(initial.map(row => row.id)).size, 3)
    await click('Shuffle')
    assert.equal(await run(`${buttons}.find(button =>
      (button.getAttribute('aria-label') ?? button.innerText) === 'Shuffle').getAttribute('aria-pressed')`), 'true')
    await click('Shuffle')
    assert.deepEqual(await pendingRows(), initial)
    await click('Ниже в очереди: Test Tone MP3')
    assert.deepEqual(await pendingRows(), [initial[1], initial[0], initial[2]])
    await click('Убрать из очереди: Test Tone FLAC')
    assert.deepEqual(await pendingRows(), [initial[0], initial[2]])
    assert.equal(await run('document.querySelector("audio").paused'), false)
    player.setSize(620, 520)
    await waitFor('innerWidth <= 620', 'compact queue window')
    assert.equal(await run(`['main', 'footer', '.queue-panel'].every(selector => {
      const element = document.querySelector(selector)
      return element.scrollWidth <= element.clientWidth
    })`), true)

    await setRepeat('one')
    await click('Играть из очереди: Test Tone FLAC')
    await waitForAudio(`${advancing} && audio.src === '${flac}'`, 'jump overrides Repeat One')
    const beforeRepeat = await sessionState()
    const eventsBeforeRepeat = (await run('window.mustplay.getListeningData()')).events
    await finishTrack()
    await waitFor(`(async () => (await window.mustplay.getListeningData()).events.length >= ${eventsBeforeRepeat.length + 2})()`, 'Repeat One creates a new listening session')
    await waitForAudio(`!audio.paused && audio.src === '${flac}' && audio.currentTime < 1.5`, 'Repeat One restarts same entry')
    const afterRepeat = await sessionState()
    assert.equal(afterRepeat.queue.current, beforeRepeat.queue.current)
    assert.deepEqual(afterRepeat.queue.pending, beforeRepeat.queue.pending)
    const repeated = (await run('window.mustplay.getListeningData()')).events.slice(eventsBeforeRepeat.length)
    assert.deepEqual(repeated.map(event => event.type), ['ended', 'started'])
    assert.notEqual(repeated[0].sessionId, repeated[1].sessionId)
    await click('Следующий трек')
    await waitForAudio(`${advancing} && audio.src === '${mp3}'`, 'manual Next overrides Repeat One')
    await setRepeat('off')
    await finishTrack()
    await waitForAudio('audio.ended && audio.paused', 'Repeat Off stops at the end')
    await setRepeat('all')
    await click('Воспроизвести')
    await waitForAudio(`${advancing} && audio.src === '${mp3}'`, 'resume current item at end')
    await finishTrack()
    await waitForAudio(`document.querySelector(".queue-list li") && ${advancing} && audio.currentTime < 1.5`, 'Repeat All starts a new cycle')
    assert.equal((await sessionState()).queue.history.length, 0)
    await click('Очистить ожидающие')
    assert.deepEqual((await sessionState()).queue.pending, [])
    await closeQueue()
    await click('Shuffle')
    await click('Добавить в очередь: Test Tone FLAC')
    await click('Пауза')
    await setInput('input[aria-label="Позиция воспроизведения"]', '1.20')
    await waitFor('(async () => Math.abs((await window.mustplay.getPlaybackSession()).position - 1.2) < 0.02)()', 'paused seek checkpointed')
    await writeFile(stateFile, JSON.stringify({ saved: await sessionState(), mp3 }))
    return
  }

  if (phase === 'queue-restart') {
    const { saved, mp3: previousUrl } = JSON.parse(await readFile(stateFile, 'utf8'))
    const mp3 = new URL(new URL(previousUrl).pathname, origin).href
    await waitFor('document.querySelector(".now-playing").innerText.includes("Test Tone MP3")', 'restored current item')
    assert.deepEqual(await sessionState(), saved)
    assert.equal(await run('document.querySelector("audio").paused && !document.querySelector("audio").hasAttribute("src")'), true)
    assert.equal(await run('document.querySelector(".timeline input").valueAsNumber'), 1.2)
    await click('Очередь (1)')
    await waitFor('document.querySelector(".queue-list").innerText.includes("Файл недоступен")', 'restored missing pending source is marked')
    await click('Воспроизвести')
    await waitForAudio(`!audio.paused && audio.currentTime >= 1.2 && audio.src === '${mp3}'`, 'user resumes at saved position')
    await waitFor('!document.querySelector(\'button[aria-label="Следующий трек"]\').disabled', 'Next is ready after restoration')
    await click('Следующий трек')
    await waitFor('(async () => (await window.mustplay.getListeningData()).events.some(event => event.type === "error"))()', 'missing track records an error')
    await waitForAudio(`${advancing} && audio.src === '${mp3}'`, 'Repeat All skips missing source in restored queue')
    return
  }
  if (phase === 'wave-import' || phase === 'legacy-import') {
    await openWave()
    assert.equal(await run(`(${waveStart}).disabled`), true)
    if (modern) await click('Открыть библиотеку')
    assert.deepEqual(await run('window.mustplay.getWaveQueue()'), [])
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click(importLabel)
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'imported wave catalog')
    await waitFor('!document.querySelector("tbody img") && document.querySelectorAll("tbody .artwork").length === 2', 'fallback artwork')
    await waitFor('!document.querySelector(\'input[aria-label="Громкость"]\').disabled', 'volume preference loaded')
    await setInput('input[aria-label="Громкость"]', '37')
    await waitFor('document.querySelector("audio").volume === 0.37', 'slider sets audio volume')
    await click('Без звука')
    await waitFor('document.querySelector("audio").muted', 'mute')
    await click('Без звука')
    await waitFor('!document.querySelector("audio").muted && document.querySelector("audio").volume === 0.37', 'unmute restores level')
    const tracks = await run('window.mustplay.getTracks()')
    const mp3Id = tracks.find(track => track.format === 'mp3').id
    const flacId = tracks.find(track => track.format === 'flac').id
    const queue = await run('window.mustplay.getWaveQueue()')
    assert.deepEqual(new Set(queue), new Set([mp3Id, flacId]))
    await click('Лайк: Test Tone FLAC')
    await waitFor('(async () => (await window.mustplay.getListeningData()).preferences.some(p => p.liked))()', 'wave preference saved')
    assert.deepEqual(await run('window.mustplay.getWaveQueue()'), [flacId, mp3Id])

    await startWave()
    const flac = await waitForAudio(`${advancing} && audio.duration === 5 && audio.volume === 0.37`, 'liked FLAC played by wave at saved volume')
    await waitFor('document.querySelector("footer [role=status]").innerText.includes("Режим")', 'wave mode')
    assert.equal(await run('document.querySelectorAll("audio").length'), 1)
    await click('Пауза')
    await waitForAudio('audio.paused', 'pause in wave')
    if (explainable) {
      await run('document.querySelector(".wave-explanation summary").click()')
      assert.match(await run('document.querySelector(".wave-explanation").innerText'), /отметили этот трек лайком/)
    }
    const paused = await run('window.mustplay.getListeningData()')
    assert.deepEqual(paused.events.map(event => event.type), ['started'])
    if (modern) await click('Библиотека')
    await click('Лайк: Test Tone MP3')
    await waitFor(`(async () => (await window.mustplay.getListeningData()).preferences
      .some(p => p.trackId === ${JSON.stringify(mp3Id)} && p.liked))()`, 'new like saved in wave mode')
    await click('Следующий трек')
    const mp3 = await waitForAudio(`${advancing} && audio.src !== ${JSON.stringify(flac)} && audio.volume === 0.37`, 'next wave track keeps volume')
    const skipped = await run('window.mustplay.getListeningData()')
    assert.ok(skipped.events.some(event => event.type === 'skipped' && event.trackId === flacId))
    await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(flac)}`, 'automatic wave transition after completion')
    const feedback = await run('window.mustplay.getListeningData()')
    assert.ok(feedback.events.some(event => event.type === 'completed' && event.trackId === mp3Id))
    await click('Без звука')
    await waitFor('(async () => (await window.mustplay.getVolume()).muted)()', 'mute preference saved')
    await writeFile(stateFile, JSON.stringify({ tracks, mp3Id, mp3, feedback }))
    return
  }
  if (phase === 'verify-upgrade') {
    const { tracks, feedback } = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.deepEqual(await run('window.mustplay.getTracks()'), tracks.map(track => ({
      ...track,
      available: true,
      artworkUrl: track.artworkUrl && new URL(new URL(track.artworkUrl).pathname, origin).href,
    })))
    assert.deepEqual(await run('window.mustplay.getListeningData()'), feedback)
    assert.deepEqual(await run('window.mustplay.getVolume()'), { level: 0.37, muted: true })
    assert.equal(await run('window.mustplay.getWaveMode()'), 'balance')
    assert.deepEqual(await run('window.mustplay.getPlaylists()'), [])
    await waitFor('document.querySelector("audio").muted && document.querySelector("audio").volume === 0.37', 'migrated volume in player')
    await openWave()
    await waitFor(`!(${waveStart}).disabled`, 'migrated Wave controls ready')
    await startWave()
    await waitForAudio(`${advancing} && audio.muted`, 'migrated library plays in Balance')
    return
  }
  if (phase === 'wave-restart') {
    const { mp3Id, mp3: previousUrl, feedback } = JSON.parse(await readFile(stateFile, 'utf8'))
    const mp3 = new URL(new URL(previousUrl).pathname, origin).href
    await waitFor('document.querySelectorAll("tbody tr").length === ' + (v8 ? 1 : 2), 'restored wave catalog')
    await waitFor('document.querySelector("audio").muted && document.querySelector("audio").volume === 0.37', 'volume and mute restored on restart')
    assert.deepEqual(await run('window.mustplay.getListeningData()'), feedback)
    assert.deepEqual(await run('window.mustplay.getWaveQueue()'), [mp3Id])
    if (explainable) {
      await openWave()
      await waitFor('!!document.querySelector(".wave-explanation-unavailable")', 'restored Wave entry has no diagnostic trace')
    }
    player.minimize()
    await eventually(() => player.isMinimized(), 'minimized Windows player')
    await startWave()
    await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)} && audio.muted`, 'only available track plays muted while minimized')
    player.restore()
    if (explainable) {
      await run('document.querySelector(".wave-explanation summary").click()')
      assert.match(await run('document.querySelector(".wave-explanation").innerText'), /один кандидат/)
    }
    await click('Без звука')
    await waitForAudio('!audio.muted && audio.volume === 0.37', 'unmute after restart restores prior level')
    await waitFor('document.querySelector("footer [role=status]").innerText.includes("других доступных")', 'singleton wave stops after playback')
    await rm(join(folder, '01.mp3'))
    await startWave()
    await waitFor('document.querySelector("footer [role=status]").innerText.includes("нет доступных")', 'wave handles missing files')
    assert.deepEqual(await run('window.mustplay.getWaveQueue()'), [])
    if (modern) await click('Библиотека')
    if (v8) {
      await waitFor('document.querySelector("main .empty-state h2")?.innerText === "Нет доступных треков"', 'library hides files lost during playback')
    } else {
      await click('Test Tone MP3')
      await waitFor('!document.querySelector("footer [role=status]")', 'manual selection returns to library mode')
    }
    return
  }
  if (phase === 'restart') {
    const { tracks, mp3, feedback } = JSON.parse(await readFile(stateFile, 'utf8'))
    await waitFor('document.querySelectorAll("tbody tr").length === ' + (v8 ? 1 : 2), 'restored library UI')
    const available = tracks.map(track => ({ ...track, available: track.format !== 'flac' }))
    assert.deepEqual(await run('window.mustplay.getTracks()'), available)
    assert.deepEqual(await run('window.mustplay.getListeningData()'), feedback)
    await waitFor(`document.querySelector('button[aria-label="Лайк: Test Tone MP3"]')?.getAttribute("aria-pressed") === "true"`, 'restored like')
    const flacId = tracks.find(({ format }) => format === 'flac').id
    assert.equal(await run(`window.mustplay.getPlayableSource(${JSON.stringify(flacId)})`), null)
    await click('Test Tone MP3')
    await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)}`, 'restored MP3 playback')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    const rescan = await run('window.mustplay.importFolder()')
    assert.deepEqual(rescan, { status: 'complete', tracks: available, processed: 1, issues: [{ entry: 'broken.mp3', reason: 'file-unreadable' }] })
    return
  }
  if (phase === 'playlist-import') {
    await openWave()
    await checkWaveMode('balance')
    if (modern) await click('Библиотека')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click(importLabel)
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'catalog for playlists')
    const tracks = await run('window.mustplay.getTracks()')
    const mp3Id = tracks.find(track => track.format === 'mp3').id
    const flacId = tracks.find(track => track.format === 'flac').id
    for (const mode of ['familiar', 'balance', 'discovery']) {
      await chooseWaveMode(mode)
      await checkWaveMode(mode)
      assert.equal(await run('window.mustplay.getWaveMode()'), mode)
      assert.deepEqual(new Set(await run('window.mustplay.getWaveQueue()')), new Set([mp3Id, flacId]))
    }
    await click('Плейлисты')
    await waitFor('document.querySelector("#playlist-heading").offsetWidth > 0', 'playlists section')
    await click('Создать плейлист')
    await setInput('input[aria-label="Название плейлиста"]', '  В дороге  ')
    await click('Сохранить')
    await waitFor('document.querySelector(\'select[aria-label="Выбрать плейлист"] option\')?.text === "В дороге"', 'playlist created')
    await click('Переименовать')
    await setInput('input[aria-label="Название плейлиста"]', 'Два тона')
    await click('Сохранить')
    await waitFor('document.querySelector(\'select[aria-label="Выбрать плейлист"] option\').text === "Два тона"', 'playlist renamed')
    for (const [index, id] of [mp3Id, flacId].entries()) {
      await choose('Трек для добавления', id)
      await click('Добавить')
      await waitFor(`document.querySelectorAll('.playlist-track').length === ${index + 1}`, 'track added from library')
    }
    const [playlist] = await run('window.mustplay.getPlaylists()')
    const duplicate = await run(`window.mustplay.addPlaylistTrack('${playlist.id}', '${mp3Id}')`)
    assert.deepEqual(duplicate.trackIds, [mp3Id, flacId])
    await click('Выше: Test Tone FLAC')
    await waitFor('document.querySelector(".playlist-track").innerText.includes("FLAC")', 'playlist reordered')
    const newOrder = await run('window.mustplay.getPlaylists()')
    assert.deepEqual(newOrder, [{ ...playlist, trackIds: [flacId, mp3Id] }])
    player.setSize(620, 520)
    await waitFor('innerWidth <= 620', 'compact playlist window')
    assert.equal(await run(`[document.querySelector('main'), document.querySelector('footer')].every(
      element => element.scrollWidth <= element.clientWidth)`), true)

    await click('Воспроизвести плейлист')
    const flac = await waitForAudio(`${advancing} && audio.duration === 5`, 'playlist starts at FLAC after reorder')
    await click('Следующий трек')
    const mp3 = await waitForAudio(`${advancing} && audio.src !== '${flac}'`, 'playlist next plays MP3')
    await click('Предыдущий трек')
    await waitForAudio(`${advancing} && audio.src === '${flac}'`, 'playlist previous plays FLAC')
    await waitForAudio(`${advancing} && audio.src === '${mp3}'`, 'playlist advances at natural end')
    assert.equal(await run('document.querySelectorAll("audio").length'), 1)
    if (app.getVersion() !== '0.2.0') {
      await run(`document.querySelector('.playlist-track button[aria-label="Воспроизвести следующим: Test Tone FLAC"]').click()`)
      await openQueue()
      await waitFor('document.querySelectorAll(".queue-list li").length === 1', 'track queued from playlist')
      assert.deepEqual(await run('window.mustplay.getPlaylists()'), newOrder)
      await click('Очистить ожидающие')
      await closeQueue()
    }
    await rm(join(folder, '02.flac'))
    await click('Воспроизвести плейлист')
    await waitFor('document.querySelector(".playlist-track").innerText.includes("Файл недоступен")', 'playlist notices lost source while open')
    await waitForAudio(`${advancing} && audio.src === '${mp3}'`, 'playlist skips lost FLAC')
    assert.equal(await run('document.querySelector(\'button[aria-label="Предыдущий трек"]\').disabled'), true)
    await writeFile(stateFile, JSON.stringify({ playlist: newOrder[0], mp3, flacId }))
    return
  }
  if (phase === 'playlist-restart') {
    const { playlist, mp3, flacId } = JSON.parse(await readFile(stateFile, 'utf8'))
    await openWave()
    await checkWaveMode('discovery')
    await waitFor('!document.querySelector(\'nav button[aria-label="Плейлисты"]\').disabled', 'restored library')
    await click('Плейлисты')
    await waitFor('document.querySelector(".playlist-track")?.innerText.includes("Файл недоступен")', 'restored unavailable first track')
    assert.deepEqual(await run('window.mustplay.getPlaylists()'), [playlist])
    await click('Воспроизвести плейлист')
    await waitForAudio(`${advancing} && audio.src === '${mp3}'`, 'restored playlist playback')
    await click('Убрать из плейлиста: Test Tone MP3')
    await waitFor('document.querySelectorAll(".playlist-track").length === 1', 'track removed from playlist')
    assert.deepEqual(await run('window.mustplay.getPlaylists()'), [{ ...playlist, trackIds: [flacId] }])
    assert.equal(await run(`${buttons}.find(button => button.innerText === 'Воспроизвести плейлист').disabled`), true)
    await click('Удалить плейлист')
    await click('Отмена')
    assert.equal((await run('window.mustplay.getPlaylists()')).length, 1)
    await click('Удалить плейлист')
    await click('Подтвердить удаление')
    await waitFor('!document.querySelector(\'select[aria-label="Выбрать плейлист"]\')', 'playlist removed after confirmation')
    assert.deepEqual(await run('window.mustplay.getPlaylists()'), [])
    assert.equal((await run('window.mustplay.getTracks()')).length, 2)
    return
  }

  const otherWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      session,
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  try {
    await otherWindow.loadURL(webContents.getURL())
    const refusals = await otherWindow.webContents.executeJavaScript(`Promise.all(
      [window.mustplay.getTracks(), window.mustplay.getWaveQueue(),
        window.mustplay.getWaveRecommendations(),
        window.mustplay.getVolume(), window.mustplay.setVolume(0, true),
        window.mustplay.getPlaylists(), window.mustplay.createPlaylist('test'),
        window.mustplay.getWaveMode(), window.mustplay.setWaveMode('discovery'),
        window.mustplay.getPlaybackSession(), window.mustplay.setPlaybackSession({}),
        window.mustplay.getLyrics("file:///secret"), window.mustplay.openMiniPlayer(),
        window.mustplay.getShortcuts(), window.mustplay.setShortcut("mute", null),
        window.mustplay.publishMiniState({}), window.mustplay.rescanLibrary(), window.mustplay.setShortcutCapture(true),
        window.mustplay.getWavePulse(), window.mustplay.setWavePulse(0), window.mustplay.setTheme('light'),
        window.mustplay.getInterfaceScale(), window.mustplay.setInterfaceScale(125),
        window.mustplay.getSoundEffect(), window.mustplay.setSoundEffect('slowed'), window.mustplay.setReverb('slowed', true),
        window.mustplay.getDiscoMode(), window.mustplay.setDiscoMode(true), window.mustplay.publishDiscoBeat(1),
        ...(['getMusicFolders', 'removeMusicFolder', 'getCursorSettings', 'setCursorPreset', 'importCursorPreset',
          'exitMiniFullscreen', 'getLyricsMode', 'setLyricsMode'].filter(key => key in window.mustplay).map(key => window.mustplay[key]()))]
        .map(result => result.then(() => 'unexpectedly accepted', error => error.message))
    )`)
    for (const refusal of refusals) assert.match(refusal, /IPC sender denied/)
  } finally {
    otherWindow.destroy()
  }

  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  assert.deepEqual(await run('window.mustplay.importFolder()'), { status: 'cancelled' })
  dialog.showOpenDialog = async (_window, options) => {
    assert.ok(options.properties.includes('openDirectory'))
    return { canceled: false, filePaths: [folder] }
  }
  await click(importLabel)
  await waitFor('document.querySelectorAll("tbody tr").length === 2', 'two imported tracks')
  const library = await run('document.querySelector("main").innerText')
  assert.match(library, /Test Tone MP3/)
  assert.match(library, /Test Tone FLAC/)
  assert.match(library, /Fixture Artist/)
  assert.match(library, /Fixture Album/)
  assert.match(library, /Результат сканирования · ошибок: 1/)
  await run('document.querySelector(".import-result summary").click()')
  assert.match(await run('document.querySelector(".import-result").innerText'), /broken\.mp3 — файл не прочитан/)
  assert.deepEqual(await run(`(async () => ({
    arbitraryPath: await window.mustplay.getPlayableSource('C:/Windows/win.ini'),
    unknownSource: (await fetch('/audio/00000000-0000-0000-0000-000000000000')).status,
    arbitraryAsset: (await fetch('/assets/win.ini')).status
  }))()`), { arbitraryPath: null, unknownSource: 404, arbitraryAsset: 404 })

  const tracks = await run('window.mustplay.getTracks()')
  assert.deepEqual((await run('window.mustplay.importFolder()')).tracks, tracks)
  assert.ok(tracks.every(track => !('path' in track) && /^mustplay:\/\/app\/artwork\/[0-9a-f-]{36}$/.test(track.artworkUrl)))
  const flacArtwork = tracks.find(track => track.format === 'flac').artworkUrl
  const mp3Artwork = tracks.find(track => track.format === 'mp3').artworkUrl
  assert.deepEqual(await run(`(async () => {
    const image = await fetch(${JSON.stringify(mp3Artwork)}, { method: 'HEAD' })
    return {
      mime: image.headers.get('content-type'), nosniff: image.headers.get('x-content-type-options'),
      query: (await fetch(${JSON.stringify(mp3Artwork + '?file=win.ini')})).status,
      path: (await fetch('/artwork/C:/Windows/win.ini')).status,
      unknown: (await fetch('/artwork/00000000-0000-0000-0000-000000000000')).status,
      post: (await fetch(${JSON.stringify(mp3Artwork)}, { method: 'POST' })).status
    }
  })()`), { mime: 'image/jpeg', nosniff: 'nosniff', query: 404, path: 404, unknown: 404, post: 405 })
  await waitFor(`document.querySelectorAll('tbody img').length === 2 &&
    [...document.querySelectorAll('tbody img')].every(image => image.naturalWidth === 12)`, 'both embedded covers decoded')
  for (const input of ['NaN, true', '1.01, false', '0.5, "true"']) {
    assert.match(await run(`window.mustplay.setVolume(${input}).then(() => 'accepted', e => e.message)`), /Invalid volume/)
  }
  for (const operation of [
    'createPlaylist("   ")', 'createPlaylist("a".repeat(101))', 'deletePlaylist("C:/Windows/win.ini")',
    'movePlaylistTrack("bad", "bad", 2)', 'setWaveMode("unknown")', 'setPlaybackSession({queue: {}, position: -1})',
  ]) {
    assert.match(await run(`window.mustplay.${operation}.then(() => 'accepted', e => e.message)`), /Invalid/)
  }
  player.setSize(620, 520)
  await waitFor('innerWidth <= 620', 'compact Windows window')
  assert.equal(await run(`[document.querySelector('main'), document.querySelector('footer')].every(
    element => element.scrollWidth <= element.clientWidth)`), true)

  await search('нет такого трека')
  await waitFor('document.querySelector("main .empty-state h2")?.innerText === "Треки не найдены"', 'empty search result')
  await click('Очистить поиск')
  await search('FIXTURE ALBUM')
  await waitFor('document.querySelectorAll("tbody tr").length === 2', 'album search')
  await run(`(() => {
    const sort = document.querySelector('.sort-control select')
    sort.value = 'durationSeconds'
    sort.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await click('Сортировать по убыванию')
  await waitFor('document.querySelector("tbody tr")?.innerText.includes("Test Tone FLAC")', 'duration sort on matching tracks')
  assert.deepEqual(await run('window.mustplay.getTracks()'), tracks)
  await search('тЕСТОВЫЙ')
  await waitFor('document.querySelectorAll("tbody tr").length === 1 && document.querySelector("tbody").innerText.includes("Test Tone MP3")', 'Cyrillic artist search')
  const flacId = tracks.find(track => track.format === 'flac').id
  await click('Лайк: Test Tone MP3')
  await waitFor('(async () => (await window.mustplay.getListeningData()).preferences.some(p => p.liked))()', 'saved like')
  await search('Test Tone')
  await waitFor('document.querySelectorAll("tbody tr").length === 2', 'title search')
  await click('Лайк: Test Tone FLAC')
  await waitFor('(async () => (await window.mustplay.getListeningData()).preferences.filter(p => p.liked).length === 2)()', 'second like')
  await click('Лайк: Test Tone FLAC')
  await waitFor('(async () => (await window.mustplay.getListeningData()).preferences.filter(p => p.liked).length === 1)()', 'cancelled like')
  assert.match(await run(`window.mustplay.setTrackPreference('bad-id', true).then(() => 'accepted', e => e.message)`), /Invalid preference/)
  await search('MP3')
  await waitFor('document.querySelectorAll("tbody tr").length === 1', 'filtered selection')
  await click('Test Tone MP3')
  const mp3 = await waitForAudio(advancing, 'MP3 playback')
  await waitFor('document.querySelector("footer .artwork img")?.naturalWidth === 12', 'now-playing artwork decoded')
  await waitFor('!!document.querySelector(\'button[aria-label="Пауза"]\')', 'pause button')
  await click('Пауза')
  await waitForAudio('audio.paused', 'pause')
  const pausedEvents = (await run('window.mustplay.getListeningData()')).events
  assert.deepEqual(pausedEvents.map(e => e.type), ['started'])
  await waitFor('!!document.querySelector(\'button[aria-label="Воспроизвести"]\')', 'resume button')
  await click('Воспроизвести')
  await waitForAudio('!audio.paused', 'resume')

  await click('Следующий трек')
  const flac = await waitForAudio(`${advancing} && audio.src !== ${JSON.stringify(mp3)} && audio.duration === 5`, 'next uses import order despite filter and sort')
  await click('Предыдущий трек')
  await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)}`, 'previous track')
  const manualEvents = (await run('window.mustplay.getListeningData()')).events
  assert.deepEqual(manualEvents.map(e => e.type), ['started', 'skipped', 'started', 'skipped', 'started'])
  await run(`(() => {
    const audio = document.querySelector('audio')
    audio.currentTime = audio.duration - 0.1
  })()`)
  await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(flac)}`, 'automatic next track')

  await waitFor('(async () => (await window.mustplay.getListeningData()).events.some(e => e.type === "ended"))()', 'seek ending recorded without completion')
  assert.equal((await run('window.mustplay.getListeningData()')).events.some(e => e.type === 'completed'), false)
  await click('Предыдущий трек')
  await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)}`, 'full MP3 playback')
  await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(flac)}`, 'natural MP3 ending')
  await waitFor('(async () => (await window.mustplay.getListeningData()).events.some(e => e.type === "completed"))()', 'completed listening')
  await click('Предыдущий трек')
  await waitForAudio(`audio.src === ${JSON.stringify(mp3)}`, 'switch away from FLAC')
  await rm(join(folder, '02.flac'))
  assert.equal(await run(`fetch(${JSON.stringify(flac)}).then(response => response.status)`), 404)
  assert.equal(await run(`fetch(${JSON.stringify(flacArtwork)}).then(response => response.status)`), 404)
  await click('Следующий трек')
  await waitFor('document.querySelector("[role=alert]")?.innerText.includes("Не удалось воспроизвести")', 'missing file error')
  await waitFor('(async () => (await window.mustplay.getListeningData()).events.some(e => e.type === "error"))()', 'unavailable file error event')
  const feedback = await run('window.mustplay.getListeningData()')
  assert.equal(feedback.events.at(-1).type, 'error')
  assert.equal(feedback.events.at(-1).trackId, flacId)
  for (const sessionId of new Set(feedback.events.map(e => e.sessionId))) {
    const events = feedback.events.filter(e => e.sessionId === sessionId)
    assert.ok(events.filter(e => e.type === 'started').length <= 1)
    assert.ok(events.filter(e => e.type !== 'started').length <= 1)
  }
  await writeFile(stateFile, JSON.stringify({ tracks, mp3, feedback }))
}
