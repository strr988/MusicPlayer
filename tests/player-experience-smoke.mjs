import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog, globalShortcut } from 'electron'

export async function verifyPlayerExperience({ player, folder, run, click, waitFor, waitForAudio, finishTrack, sessionState, setRepeat, importLabel, v8, restart }) {
  if (!restart) {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click(importLabel)
  }
  await waitFor('document.querySelectorAll("tbody tr").length === 2 && !document.querySelector(".track-button").disabled', 'player experience catalog')
  await click('Настройки')
  const pulse = 'document.querySelector(\'input[aria-label="Сила пульсации"]\')'
  await waitFor(`${pulse} && !${pulse}.disabled`, 'pulse settings loaded')
  const getMini = () => BrowserWindow.getAllWindows().find(window => window !== player)
  async function openMini() {
    await run('window.mustplay.openMiniPlayer()')
    const mini = getMini()
    assert.ok(mini)
    assert.equal(player.isVisible(), false)
    return mini
  }
  const colorScheme = 'getComputedStyle(document.documentElement).colorScheme'
  if (restart) {
    if (v8) {
      await waitFor('document.documentElement.dataset.cursor === "custom"', 'imported cursor survives restart')
      await click('Текст песни')
      await waitFor('document.querySelector("#song-lyrics")?.getAttribute("aria-label") === "Текстомузыка"', 'lyrics mode survives restart')
      await click('Настройки')
      await waitFor(`${pulse} && !${pulse}.disabled`, 'pulse settings restored')
    }
    assert.equal(globalShortcut.isRegistered('Ctrl+Shift+F11'), true)
    assert.equal(await run(`${pulse}.valueAsNumber`), 275)
    const mini = await openMini()
    assert.equal(await run(colorScheme), 'light')
    assert.equal(await mini.webContents.executeJavaScript(colorScheme), 'light')
    assert.equal(mini.isAlwaysOnTop(), true)
    assert.equal(await run('document.querySelector("audio").paused'), true)
    mini.close()
    return
  }
  if (v8) {
    const cursor = 'document.querySelector(`select.settings-input:has(option[value=system])`)'
    await waitFor(cursor + ' && !' + cursor + '.disabled', 'cursor settings loaded')
    const selectCursor = id => run(cursor + '.value = ' + JSON.stringify(id) + '; ' + cursor + '.dispatchEvent(new Event("change", {bubbles:true}))')
    for (const id of ['system', 'contrast']) {
      await selectCursor(id)
      await waitFor('document.documentElement.dataset.cursor === ' + JSON.stringify(id), 'cursor preset ' + id)
      const css = await run('getComputedStyle(document.body).cursor')
      if (id === 'system') assert.equal(css, 'auto')
      else assert.match(css, /cursor-contrast-arrow/)
    }
    const png = await readFile(new URL('../src/renderer/assets/cursor-arrow.png', import.meta.url))
    const preset = join(folder, 'cursor.json')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [preset] })
    const value = { version: 1, name: 'Test Cursor', arrow: { png: png.toString('base64'), x: 4, y: 3 } }
    await writeFile(preset, JSON.stringify({ ...value, arrow: { ...value.arrow, x: 100 } }))
    await assert.rejects(run('window.mustplay.importCursorPreset()'), /Renderer script failed/)
    await writeFile(preset, JSON.stringify(value))
    await click('Импортировать пресет курсора')
    await waitFor('document.documentElement.dataset.cursor === "custom"', 'imported cursor applied')
    const { selected } = await run('window.mustplay.getCursorSettings()')
    assert.equal(selected.label, 'Test Cursor')
    assert.match(await run('getComputedStyle(document.body).cursor'), /\/cursor\/.*\/arrow/)
    assert.equal(await run('fetch(' + JSON.stringify('mustplay://app/cursor/' + selected.id + '/arrow') + ').then(res => res.headers.get("content-type"))'), 'image/png')
  }
  assert.equal(await run(colorScheme), 'dark')
  assert.equal(await run('document.querySelector(".window-title img").decode().then(() => true)'), true)
  await assert.rejects(run('window.mustplay.setTheme("sepia")'), /Renderer script failed/)
  await run(`(() => {
    const start = document.startViewTransition.bind(document)
    document.startViewTransition = update => {
      const transition = start(update)
      window.themeTransition = transition.finished
      return transition
    }
  })()`)
  for (const [label, theme] of [['светлую', 'light'], ['тёмную', 'dark'], ['светлую', 'light']]) {
    await click(`Включить ${label} тему`)
    assert.equal(await run(`window.themeTransition.then(() => ${colorScheme})`), theme)
  }
  assert.equal(await run(`${pulse}.valueAsNumber`), 100)
  assert.equal(await run('window.mustplay.setWavePulse(301).then(() => false, () => true)'), true)
  await run(`(() => {
    const input = ${pulse}
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '275')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitFor('(async () => (await window.mustplay.getWavePulse()) === 275)()', 'slider saves pulse intensity')
  assert.equal(await run('document.querySelector(".wave-art").style.getPropertyValue("--wave-intensity")'), '2.75')

  const bindings = { toggle: 'Ctrl+Shift+F11', previous: 'Ctrl+Alt+F7', next: 'Ctrl+Alt+F8',
    volumeUp: 'Ctrl+Alt+F9', volumeDown: 'Ctrl+Alt+F10', mute: 'Ctrl+Alt+F11' }
  const callbacks = new Map()
  const register = globalShortcut.register
  globalShortcut.register = (key, callback) => {
    if (!register.call(globalShortcut, key, callback)) return false
    callbacks.set(key, callback)
    return true
  }
  try {
    player.focus()
    player.webContents.focus()
    const first = 'document.querySelector(".shortcut-capture")'
    const trigger = () => run(`${first}.focus(); ${first}.click()`)
    const press = (key, code, modifiers = {}) => run(`${first}.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({
      key, code, ...modifiers, bubbles: true, cancelable: true,
    })}))`)
    await waitFor(`!!${first}`, 'shortcut settings loaded')
    await trigger()
    await waitFor(`${first}.getAttribute("aria-pressed") === "true"`, 'shortcut recording ready')
    assert.equal(globalShortcut.isSuspended(), true)
    await press('a', 'KeyA')
    await waitFor('!!document.querySelector(".shortcut-row [role=alert]")', 'rejects an unmodified key')
    await press('Escape', 'Escape')
    await waitFor(`${first}.getAttribute("aria-pressed") === "false"`, 'escape cancels recording')
    await trigger()
    await waitFor(`${first}.getAttribute("aria-pressed") === "true"`, 'shortcut recording resumes')
    const modifiers = ['control', 'shift']
    player.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11', modifiers })
    player.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11', modifiers })
    await waitFor(`${first}.textContent === "Ctrl+Shift+F11"`, 'combination is captured as accelerator')
    await click('Сохранить')
    await waitFor('(async () => (await window.mustplay.getShortcuts()).toggle.registered)()', 'recorded shortcut saved')
    assert.equal(globalShortcut.isSuspended(), false)
    for (const [action, key] of Object.entries(bindings).filter(([action]) => action !== 'toggle')) {
      const result = await run(`window.mustplay.setShortcut(${JSON.stringify(action)}, ${JSON.stringify(key)})`)
      assert.equal(result.status, 'saved', `Windows registers ${key}`)
      assert.equal(globalShortcut.isRegistered(key), true)
    }
  } finally {
    globalShortcut.register = register
  }
  assert.deepEqual(await run('window.mustplay.setShortcut("mute", "shift+ctrl+f11")'), { status: 'duplicate' })
  assert.equal(globalShortcut.register('Ctrl+Shift+F12', () => {}), true)
  try {
    assert.deepEqual(await run('window.mustplay.setShortcut("next", "Ctrl+Shift+F12")'), { status: 'unavailable' })
    assert.equal(globalShortcut.isRegistered(bindings.next), true)
  } finally {
    globalShortcut.unregister('Ctrl+Shift+F12')
  }
  // Physical media keys may be owned by Windows or another active media session.
  const media = await run('window.mustplay.setShortcut("previous", "MediaPreviousTrack")')
  assert.ok(['saved', 'unavailable'].includes(media.status))
  console.log('MediaPreviousTrack registration:', media.status)
  if (media.status === 'saved') assert.equal(globalShortcut.isRegistered('MediaPreviousTrack'), true)
  await run('window.mustplay.setShortcut("previous", null)')
  assert.equal(globalShortcut.isRegistered('MediaPreviousTrack'), false)
  assert.equal(globalShortcut.isRegistered(bindings.previous), false)
  app.once('will-quit', () => {
    for (const key of Object.values(bindings)) assert.equal(globalShortcut.isRegistered(key), false)
  })

  await click('Библиотека')
  await click('Test Tone MP3')
  const mp3 = await waitForAudio('!audio.paused && audio.currentTime > 0.1', 'MP3 playback')
  await run('window.originalAudio = document.querySelector("audio"); void 0')
  await setRepeat('one')
  await click('Текст песни')
  await waitFor(`document.querySelector(".lyrics-plain")?.textContent === ${JSON.stringify('Первая строка\nВторая строка')}`, 'reading mode for LRC')
  await run('document.querySelector("footer button[aria-label=Текстомузыка]").click()')
  await waitFor('document.querySelector(".lyrics-lines button[aria-current]")?.textContent === "Первая строка"', 'LRC active row')
  assert.equal(await run('document.querySelector(".text-music h1").textContent'), 'Текстомузыка')
  assert.equal(await run('document.querySelector("audio") === window.originalAudio'), true)
  const screenshotFolder = process.env.MUSTPLAY_SCREENSHOTS
  if (screenshotFolder) {
    await mkdir(screenshotFolder, { recursive: true })
    const image = await player.webContents.capturePage()
    await writeFile(join(screenshotFolder, 'text-music.png'), image.toPNG())
  }
  await click('Вторая строка')
  await waitForAudio('audio.currentTime >= 1.5', 'LRC click seeks')
  await waitFor('document.querySelector(".lyrics-lines button[aria-current]")?.textContent === "Вторая строка"', 'seek updates active row')
  await run('document.querySelector(".lyrics-lines").dispatchEvent(new WheelEvent("wheel", {deltaY: 80, bubbles: true}))')
  await waitFor('document.querySelector(".lyrics-toolbar button").getAttribute("aria-pressed") === "false"', 'manual scrolling disables follow')
  await click('Следующий трек')
  const flac = await waitForAudio(`!audio.paused && audio.src !== ${JSON.stringify(mp3)}`, 'FLAC playback')
  await waitFor('document.querySelector(".lyrics-plain")?.textContent === "Простой текст FLAC" && !document.querySelector(".lyrics-lines")', 'lyrics follow track change')
  assert.match(await run('document.querySelector(".lyrics-note").textContent'), /нет временных меток/)
  await waitFor('!document.querySelector(\'footer button[aria-label="Предыдущий трек"]\').disabled', 'previous track is ready')
  await click('Предыдущий трек')
  await waitForAudio(`!audio.paused && audio.src === ${JSON.stringify(mp3)}`, 'back to MP3')
  await waitFor('document.querySelector(".lyrics-toolbar button")?.getAttribute("aria-pressed") === "true"', 'new track resets lyric follow')
  await click('Читать текст')
  await waitFor('!!document.querySelector(".lyrics-plain") && !document.querySelector(".lyrics-lines")', 'read text without synchronization')
  await run('document.querySelector(".lyrics-heading button").click()')
  await waitFor('!!document.querySelector(".text-music .lyrics-lines")', 'return to synchronized lyrics')
  await run('window.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", cancelable:true}))')
  await waitFor('document.querySelector("nav button[aria-current]").getAttribute("aria-label") === "Библиотека"', 'Escape returns to previous section')
  await waitForAudio(`audio === window.originalAudio && audio.src === ${JSON.stringify(mp3)} && !audio.paused`, 'lyrics mode never replaces playback')

  if (v8) {
    await click('Текст песни')
    await waitFor('!document.querySelector("#song-lyrics").parentElement.hidden && !!document.querySelector(".text-music .lyrics-lines")', 'lyrics tab remembers synchronization mode')
    assert.equal(await run('getComputedStyle(document.querySelector(".lyrics-lines")).scrollbarWidth'), 'none')
    await click('Библиотека')
  }
  await verifyFullPlayer({ player, run, click, waitFor, waitForAudio, mp3, flac, screenshotFolder, v8 })

  await click('Настройки')
  await click('Открыть мини-плеер')
  const miniDeadline = Date.now() + 5000
  while ((!getMini()?.isVisible() || player.isVisible()) && Date.now() < miniDeadline) await delay(40)
  const mini = getMini()
  assert.ok(mini)
  const miniRun = (script, gesture = false) => mini.webContents.executeJavaScript(script, gesture)
  const miniButton = label => `document.querySelector('button[aria-label="${label}"]')`
  const miniClick = label => miniRun(`${miniButton(label)}.click()`, true)
  async function waitMini(script) {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (await miniRun(script)) return
      await delay(40)
    }
    assert.fail(`Mini state did not satisfy ${script}`)
  }
  await waitMini('document.querySelector(".mini-player .track-name")?.textContent === "Test Tone MP3"')
  const { sandbox, contextIsolation, nodeIntegration } = mini.webContents.getLastWebPreferences()
  assert.deepEqual({ sandbox, contextIsolation, nodeIntegration }, { sandbox: true, contextIsolation: true, nodeIntegration: false })
  assert.equal(player.isVisible(), false)
  assert.equal(await miniRun('document.querySelectorAll("audio").length'), 0)
  assert.equal(await miniRun('typeof window.mustplay'), 'undefined')
  assert.equal(await miniRun(`(() => {
    const main = document.querySelector('.mini-player')
    return main.scrollWidth <= innerWidth && main.scrollHeight <= innerHeight
  })()`), true)
  if (!app.isPackaged) await waitMini('document.querySelector(".mini-player img")?.naturalWidth > 0')
  await waitForAudio(`audio === window.originalAudio && !audio.paused && audio.src === ${JSON.stringify(mp3)}`, 'audio continues in mini player')
  assert.equal(await miniRun('window.miniPlayer.control({type:"volume", level:2}).then(() => false, () => true)'), true)
  await miniClick('Пауза')
  await waitForAudio('audio.paused', 'mini pauses shared audio')
  await miniRun('window.miniPlayer.control({type:"volume", level:0.42})')
  await waitForAudio('Math.abs(audio.volume - 0.42) < 0.001', 'mini adjusts shared volume')
  await waitMini('document.querySelector(\'input[aria-label="Громкость"]\').value === "42"')
  callbacks.get(bindings.volumeUp)()
  await waitForAudio('Math.abs(audio.volume - 0.47) < 0.001', 'shortcut raises volume from background')
  callbacks.get(bindings.volumeDown)()
  await waitForAudio('Math.abs(audio.volume - 0.42) < 0.001', 'shortcut lowers volume from background')
  callbacks.get(bindings.mute)()
  await waitForAudio('audio.muted', 'shortcut mutes from background')
  callbacks.get(bindings.mute)()
  await waitForAudio('!audio.muted', 'shortcut unmutes from background')
  const { playback } = await miniRun('window.miniPlayer.getState()')
  await miniRun(`window.miniPlayer.control({type:"seek", entryId:${JSON.stringify(playback.entryId)}, seconds:2})`)
  await waitForAudio('Math.abs(audio.currentTime - 2) < 0.05', 'mini seeks shared audio')
  callbacks.get(bindings.toggle)()
  await waitForAudio('!audio.paused', 'shortcut resumes shared audio from background')
  callbacks.get(bindings.next)()
  await waitForAudio(`!audio.paused && audio.src === ${JSON.stringify(flac)}`, 'mini next')
  await waitMini('document.querySelector(".mini-player .track-name")?.textContent === "Test Tone FLAC"')
  if (v8) {
    const { playback: snapshot } = await miniRun('window.miniPlayer.getState()')
    await miniRun(`window.miniPlayer.control({type:'seek', entryId:${JSON.stringify(snapshot.entryId)}, seconds:3.25})`)
    await waitForAudio('audio.currentTime >= 3.25', 'seek past restart threshold')
    await miniClick('Предыдущий трек')
    await waitForAudio(`!audio.paused && audio.src === ${JSON.stringify(flac)} && audio.currentTime < 1`, 'first previous tap restarts current track')
  }
  await miniClick('Предыдущий трек')
  await waitForAudio(`!audio.paused && audio.src === ${JSON.stringify(mp3)}`, 'mini previous')
  await miniClick('Поверх других окон')
  await waitMini(miniButton('Поверх других окон') + '.getAttribute("aria-pressed") === "true"')
  const pinDeadline = Date.now() + 2_000
  while (!mini.isAlwaysOnTop() && Date.now() < pinDeadline) await delay(40)
  assert.equal(mini.isAlwaysOnTop(), true)
  const closed = once(mini, 'closed', { signal: AbortSignal.timeout(5_000) })
  await Promise.all([
    closed,
    miniClick('Основное окно').catch(error => {
      if (!/Render frame was disposed/.test(String(error))) throw error
    }),
  ])
  await waitForAudio('audio === window.originalAudio && !audio.paused', 'restore main window keeps audio')
  assert.equal(player.isVisible(), true)
  assert.equal(getMini(), undefined)
  const reopened = await openMini()
  assert.ok(reopened && reopened !== mini)
  assert.equal(reopened.isAlwaysOnTop(), true)
  reopened.close()
  await waitForAudio('audio === window.originalAudio && !audio.paused', 'native close restores playing main window')
  assert.equal(player.isVisible(), true)

  if (v8) {
    const compact = await openMini()
    const miniCover = '.mini-player .player-cover-button'
    const readyBy = Date.now() + 5_000
    while (!await compact.webContents.executeJavaScript('!!document.querySelector(' + JSON.stringify(miniCover) + ')')) {
      if (Date.now() > readyBy) assert.fail('Mini cover never rendered')
      await delay(40)
    }
    const closed = once(compact, 'closed', { signal: AbortSignal.timeout(5_000) })
    await Promise.all([closed, compact.webContents.executeJavaScript(`document.querySelector('${miniCover}').click()`, true)
      .catch(error => { if (!compact.isDestroyed() && !/Render frame was disposed/.test(String(error))) throw error })])
    await waitFor('document.querySelector("dialog.full-player").open', 'mini cover opens fullscreen')
    assert.equal(player.isFullScreen(), true)
    await waitForAudio('audio === window.originalAudio && !audio.paused', 'mini to fullscreen keeps audio')
    await click('Свернуть полноэкранный плеер')
    const deadline = Date.now() + 5000
    while (player.isFullScreen() && Date.now() < deadline) await delay(40)
    assert.equal(player.isFullScreen(), false)
  }
  await click('Shuffle')
  if (v8) {
    await click('Таймер сна')
    await waitFor('!!document.querySelector(".sleep-controls")', 'timer opens from the player')
  }
  await click('После текущего трека')
  await waitForAudio('!audio.paused && audio.volume < 0.42', 'sleep timer fades')
  await click('Отменить таймер')
  await waitForAudio('!audio.paused && Math.abs(audio.volume - 0.42) < 0.001', 'cancel restores base volume')
  await click('После текущего трека')
  await click('Следующий трек')
  await waitForAudio(`!audio.paused && audio.src === ${JSON.stringify(flac)} && Math.abs(audio.volume - 0.42) < 0.001`, 'manual track change cancels track timer')
  await waitFor('!document.querySelector(".sleep-remaining")', 'timer clears on track change')
  if (v8 && !await run('!!document.querySelector(".sleep-menu:popover-open")')) {
    await click('Таймер сна')
    await waitFor('!!document.querySelector(".sleep-controls")', 'timer can reopen')
  }
  await click('После текущего трека')
  const beforeEnd = (await sessionState()).queue.current
  await finishTrack()
  await waitForAudio('audio.paused && audio.ended && Math.abs(audio.volume - 0.42) < 0.001', 'track timer stops and restores volume before Repeat One')
  assert.equal((await sessionState()).queue.current, beforeEnd)

  // Advance the clock in the renderer while exercising the real interval and audio.
  await click('Воспроизвести')
  await waitForAudio('!audio.paused && !audio.ended', 'can resume after sleep')
  await run('window.realNow = Date.now; window.sleepClock = Date.now(); Date.now = () => window.sleepClock; void 0')
  try {
    await click('5 мин')
    await run('window.sleepClock += 295000')
    await waitForAudio('!audio.paused && Math.abs(audio.volume - 0.21) < 0.001', 'deadline fade')
    await run(`(() => {
      const volume = document.querySelector('footer input[aria-label="Громкость"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(volume, '60')
      volume.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitForAudio('!audio.paused && Math.abs(audio.volume - 0.3) < 0.001', 'manual volume during fade')
    await run(`(() => {
      const audio = document.querySelector('audio')
      audio.currentTime = audio.duration - 0.1
      window.sleepClock += 5001
    })()`)
    await waitForAudio('audio.paused && Math.abs(audio.volume - 0.6) < 0.001', 'deadline pauses and restores the latest volume')
    assert.deepEqual(await run('window.mustplay.getVolume()'), { level: 0.6, muted: false })
  } finally {
    await run('Date.now = window.realNow; void 0')
  }
}

async function verifyFullPlayer({ player, run, click, waitFor, waitForAudio, mp3, flac, screenshotFolder, v8 }) {
  const modal = 'document.querySelector("dialog.full-player")'
  const stage = modal + '.querySelector(".full-player-stage")'
  const cover = modal + '.querySelector(".full-player-cover")'
  const timeline = modal + '.querySelector(".timeline input")'
  const opener = 'document.querySelector(".player-cover-button")'
  const control = label => modal + '.querySelector(' + JSON.stringify(`button[aria-label="${label}"]`) + ')'
  const press = label => run(control(label) + '.click()', true)
  const point = selector => run(`(() => {
    const rect = (${selector}).getBoundingClientRect()
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  })()`)
  async function hover(selector) {
    player.webContents.sendInputEvent({ type: 'mouseMove', ...await point(selector) })
  }

  await hover(opener)
  await waitFor('getComputedStyle(document.querySelector(".player-cover-expand")).opacity === "1"', 'cover exposes fullscreen on hover')
  await click('На весь экран')
  await waitFor(`${modal}.matches(":modal") && document.fullscreenElement === document.documentElement`, 'player enters native fullscreen')
  assert.equal(player.isFullScreen(), true)
  await waitFor(`document.activeElement === ${control('Свернуть полноэкранный плеер')}`, 'fullscreen takes keyboard focus')
  await waitFor(`${timeline}.valueAsNumber > 0 && !${timeline}.disabled`, 'fullscreen progress reflects active playback')
  assert.equal(await run(`${modal}.querySelector("h1").textContent`), 'Test Tone MP3')
  assert.equal(await run('document.querySelectorAll("audio").length'), 1)
  if (!app.isPackaged) {
    await waitFor(`${cover}.querySelector("img")?.naturalWidth > 0 && !!${stage}.style.getPropertyValue("--cover-tint")`, 'local artwork colors the stage')
  }
  await hover(cover)
  await waitFor(`getComputedStyle(${cover}.querySelector(".full-cover-controls")).opacity === "1"`, 'hover reveals full cover controls')
  const fullVolume = modal + '.querySelector(".full-volume-slider input")'
  await hover(modal + '.querySelector(".full-volume > button")')
  await waitFor(`getComputedStyle(${fullVolume}.parentElement).opacity === "1"`, 'hover reveals fullscreen volume')
  await run(`(() => {
    const input = ${fullVolume}
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '65')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitForAudio('audio.volume === 0.65', 'fullscreen volume adjusts the shared audio')
  await run('window.mustplay.setVolume(1, false)')
  await run(`(() => {
    const input = ${fullVolume}
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '100')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitForAudio('audio.volume === 1', 'fullscreen volume can return to 100%')
  await press('Звуковые эффекты')
  await waitFor(`!!${modal}.querySelector(".sound-menu:popover-open")`, 'fullscreen opens sound presets')
  if (v8) {
    assert.equal(await run(`getComputedStyle(${fullVolume}.parentElement).backgroundColor`), 'rgba(0, 0, 0, 0)')
  }
  await run(`${modal}.querySelector(".sound-menu").hidePopover()`)
  if (v8) {
    await press('Дополнительно')
    await waitFor('!!document.querySelector("#full-player-menu .sleep-panel") && !!document.querySelector("#full-player-menu .disco-setting input")', 'fullscreen actions have timer and disco')
    await run('document.querySelector("#full-player-menu").hidePopover()')
  }
  await press('Пауза')
  await waitForAudio('audio === window.originalAudio && audio.paused', 'fullscreen pauses the same audio')
  await run(`(() => {
    const input = ${timeline}
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.8')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await waitForAudio('audio.paused && Math.abs(audio.currentTime - 0.8) < 0.05', 'fullscreen timeline seeks shared audio')
  await press('Воспроизвести')
  await waitForAudio(`audio === window.originalAudio && audio.src === ${JSON.stringify(mp3)} && !audio.paused`, 'fullscreen resumes the same track')
  const like = control('Лайк текущему треку')
  const wasLiked = await run(like + '.getAttribute("aria-pressed")')
  await press('Лайк текущему треку')
  await waitFor(`!${like}.disabled && ${like}.getAttribute("aria-pressed") !== ${JSON.stringify(wasLiked)}`, 'fullscreen like updates preference')
  await press('Лайк текущему треку')
  await waitFor(`!${like}.disabled && ${like}.getAttribute("aria-pressed") === ${JSON.stringify(wasLiked)}`, 'preference can be toggled back')
  await press('Очередь')
  await waitFor(`document.querySelector("#full-playback-queue .queue-track")?.title === "Test Tone FLAC"`, 'fullscreen shows the shared queue')
  await press('Закрыть очередь')
  await waitFor(`document.activeElement === ${control('Очередь')}`, 'queue close restores focus')
  const lyricsButton = control('Текстомузыка')
  await hover(cover)
  await waitFor(`getComputedStyle(${lyricsButton}.closest(".full-cover-controls")).opacity === "1"`, 'hover reveals text music toggle')
  const lyricsPoint = await point(lyricsButton)
  player.webContents.sendInputEvent({ type: 'mouseMove', ...lyricsPoint })
  player.webContents.sendInputEvent({ type: 'mouseDown', ...lyricsPoint, button: 'left', clickCount: 1 })
  player.webContents.sendInputEvent({ type: 'mouseUp', ...lyricsPoint, button: 'left', clickCount: 1 })
  const lines = modal + '.querySelector(".lyrics-lines")'
  await waitFor(`${lines}?.querySelectorAll("button").length === 2`, 'fullscreen loads synchronized lyrics alongside the cover')
  await hover(control('Свернуть полноэкранный плеер'))
  const coverControls = `getComputedStyle(${cover}.querySelector(".full-cover-controls")).opacity`
  await waitFor(`${coverControls} === "0"`, 'cover controls disappear when the pointer leaves in text music')
  await hover(cover)
  await waitFor(`${coverControls} === "1"`, 'hover reveals controls again while showing lyrics')
  assert.equal(await run('!document.querySelector("#full-player-lyrics :is(.lyrics-heading, .lyrics-toolbar)")'), true)
  assert.equal(await run(`getComputedStyle(${lines}).scrollbarWidth`), 'none')
  await press('Пауза')
  await waitForAudio('audio.paused', 'pause before testing manual lyric scrolling')
  await hover(control('Свернуть полноэкранный плеер'))
  await waitFor(`${coverControls} === "0"`, 'paused text music still hides cover controls')
  await run(`${lines}.focus()`)
  player.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' })
  player.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' })
  await waitFor(`${lines}.scrollTop > 0 && ${lines}.scrollTop >= ${lines}.scrollHeight - ${lines}.clientHeight - 1`,
    'hidden scrollbar still permits manual scrolling')
  await run(`${lines}.querySelector("li:last-child button").click()`)
  await press('Воспроизвести')
  await waitForAudio('audio.currentTime >= 1.5 && !audio.paused', 'fullscreen lyrics seek the current audio')
  await waitFor(`${lines}.querySelector("[aria-current]")?.textContent === "Вторая строка"`, 'fullscreen highlights the current line')
  if (screenshotFolder) {
    const image = await player.webContents.capturePage()
    await writeFile(join(screenshotFolder, 'fullscreen-text-music.png'), image.toPNG())
  }
  await press('Следующий трек')
  await waitForAudio(`audio === window.originalAudio && audio.src === ${JSON.stringify(flac)} && !audio.paused`, 'fullscreen next uses the shared queue')
  await waitFor(`${modal}.querySelector(".lyrics-plain")?.textContent === "Простой текст FLAC" && !${lines}`, 'fullscreen shows untimed lyrics after switching tracks')
  await waitFor(`!${control('Предыдущий трек')}.disabled`, 'previous track is available in fullscreen')
  await press('Предыдущий трек')
  await waitFor(`${lines}?.querySelectorAll("button").length === 2`, 'fullscreen restores synchronized lyrics on the previous track')
  if (!v8) {
    await press('Дополнительно')
    await waitFor('!!document.querySelector("#full-player-menu:popover-open")', 'fullscreen actions menu opens')
    await run('document.querySelector("#full-player-menu button").click()', true)
    await waitFor(`${modal}.querySelector(".lyrics-plain")?.textContent.includes("Вторая строка")`, 'actions menu opens reading mode')
  }
  await press('Свернуть полноэкранный плеер')
  await waitFor(`!${modal}.open && !document.fullscreenElement && document.activeElement === ${opener}`, 'collapse returns focus and exits fullscreen')
  await click('На весь экран')
  await waitFor(`${modal}.open && document.fullscreenElement === document.documentElement && !${stage}.dataset.side`, 'fullscreen can reopen with a clean view')
  player.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  player.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await waitFor(`!${modal}.open && !document.fullscreenElement`, 'Escape exits fullscreen')
  await waitForAudio(`audio === window.originalAudio && !audio.paused && audio.src === ${JSON.stringify(mp3)}`, 'leaving fullscreen keeps playback')
}
