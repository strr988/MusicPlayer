import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog } from 'electron'

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
  const run = (script, gesture = false) => webContents.executeJavaScript(script, gesture).catch((error) => {
    throw new Error(`Renderer script failed: ${script}`, { cause: error })
  })
  const buttons = '[...document.querySelectorAll("button")]'
  const click = (label) => run(`${buttons}.find(button =>
    (button.getAttribute('aria-label') ?? button.innerText).includes(${JSON.stringify(label)})).click()`, true)
  const waitFor = async (script, label) => {
    try {
      return await eventually(() => run(script), label)
    } catch (error) {
      const snapshot = await run(`(() => {
        const audio = document.querySelector('audio')
        return { player: document.querySelector('footer')?.innerText, width: innerWidth,
          audio: audio && { src: audio.src, paused: audio.paused, time: audio.currentTime,
            muted: audio.muted, error: audio.error?.message },
          rows: [...document.querySelectorAll('tbody tr')].map(row => row.innerText),
          images: [...document.images].map(image => ({ src: image.src, width: image.naturalWidth, complete: image.complete }))
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

  await waitFor('document.querySelector("h1")?.innerText === "Библиотека"', 'library UI')
  assert.equal(webContents.getURL(), 'music-player://app/')
  const { sandbox, contextIsolation, nodeIntegration } = webContents.getLastWebPreferences()
  assert.deepEqual({ sandbox, contextIsolation, nodeIntegration }, { sandbox: true, contextIsolation: true, nodeIntegration: false })
  const oldApi = [
    'getListeningData', 'getPlayableSource', 'getTracks', 'getVolume', 'getWaveQueue',
    'importFolder', 'recordPlaybackEvent', 'setTrackPreference', 'setVolume',
  ]
  const expectedApi = phase === 'legacy-import' ? oldApi : oldApi.concat([
    'addPlaylistTrack', 'createPlaylist', 'deletePlaylist', 'getPlaylists', 'getWaveMode',
    'movePlaylistTrack', 'removePlaylistTrack', 'renamePlaylist', 'setWaveMode',
  ]).sort()
  assert.deepEqual(await run(`({
    process: typeof window.process,
    require: typeof window.require,
    api: Object.keys(window.musicPlayer).sort()
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
  if (phase === 'wave-import' || phase === 'legacy-import') {
    assert.equal(await run(`${buttons}.find(button => button.innerText === 'Моя волна').disabled`), true)
    assert.deepEqual(await run('window.musicPlayer.getWaveQueue()'), [])
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click('Выбрать папку')
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'imported wave catalog')
    await waitFor('!document.querySelector("tbody img") && document.querySelectorAll("tbody .artwork").length === 2', 'fallback artwork')
    await waitFor('!document.querySelector(\'input[aria-label="Громкость"]\').disabled', 'volume preference loaded')
    await setInput('input[aria-label="Громкость"]', '37')
    await waitFor('document.querySelector("audio").volume === 0.37', 'slider sets audio volume')
    await click('Без звука')
    await waitFor('document.querySelector("audio").muted', 'mute')
    await click('Без звука')
    await waitFor('!document.querySelector("audio").muted && document.querySelector("audio").volume === 0.37', 'unmute restores level')
    const tracks = await run('window.musicPlayer.getTracks()')
    const mp3Id = tracks.find(track => track.format === 'mp3').id
    const flacId = tracks.find(track => track.format === 'flac').id
    const queue = await run('window.musicPlayer.getWaveQueue()')
    assert.deepEqual(new Set(queue), new Set([mp3Id, flacId]))
    await click('Лайк: Test Tone FLAC')
    await waitFor('(async () => (await window.musicPlayer.getListeningData()).preferences.some(p => p.liked))()', 'wave preference saved')
    assert.deepEqual(await run('window.musicPlayer.getWaveQueue()'), [flacId, mp3Id])

    await click('Моя волна')
    const flac = await waitForAudio(`${advancing} && audio.duration === 5 && audio.volume === 0.37`, 'liked FLAC played by wave at saved volume')
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
    const mp3 = await waitForAudio(`${advancing} && audio.src !== ${JSON.stringify(flac)} && audio.volume === 0.37`, 'next wave track keeps volume')
    const skipped = await run('window.musicPlayer.getListeningData()')
    assert.ok(skipped.events.some(event => event.type === 'skipped' && event.trackId === flacId))
    await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(flac)}`, 'automatic wave transition after completion')
    const feedback = await run('window.musicPlayer.getListeningData()')
    assert.ok(feedback.events.some(event => event.type === 'completed' && event.trackId === mp3Id))
    await click('Без звука')
    await waitFor('(async () => (await window.musicPlayer.getVolume()).muted)()', 'mute preference saved')
    await writeFile(stateFile, JSON.stringify({ tracks, mp3Id, mp3, feedback }))
    return
  }
  if (phase === 'verify-upgrade') {
    const { tracks, feedback } = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.deepEqual(await run('window.musicPlayer.getTracks()'), tracks.map(track => ({ ...track, available: true })))
    assert.deepEqual(await run('window.musicPlayer.getListeningData()'), feedback)
    assert.deepEqual(await run('window.musicPlayer.getVolume()'), { level: 0.37, muted: true })
    assert.equal(await run('window.musicPlayer.getWaveMode()'), 'balance')
    assert.deepEqual(await run('window.musicPlayer.getPlaylists()'), [])
    await waitFor('document.querySelector("audio").muted && document.querySelector("audio").volume === 0.37', 'migrated volume in player')
    await waitFor(`!${buttons}.find(button => button.innerText === 'Моя волна').disabled`, 'migrated Wave controls ready')
    await click('Моя волна')
    await waitForAudio(`${advancing} && audio.muted`, 'migrated library plays in Balance')
    return
  }
  if (phase === 'wave-restart') {
    const { mp3Id, mp3, feedback } = JSON.parse(await readFile(stateFile, 'utf8'))
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'restored wave catalog')
    await waitFor('document.querySelector("audio").muted && document.querySelector("audio").volume === 0.37', 'volume and mute restored on restart')
    assert.deepEqual(await run('window.musicPlayer.getListeningData()'), feedback)
    assert.deepEqual(await run('window.musicPlayer.getWaveQueue()'), [mp3Id])
    player.minimize()
    await eventually(() => player.isMinimized(), 'minimized Windows player')
    await click('Моя волна')
    await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)} && audio.muted`, 'only available track plays muted while minimized')
    player.restore()
    await click('Без звука')
    await waitForAudio('!audio.muted && audio.volume === 0.37', 'unmute after restart restores prior level')
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
    const available = tracks.map(track => ({ ...track, available: track.format !== 'flac' }))
    assert.deepEqual(await run('window.musicPlayer.getTracks()'), available)
    assert.deepEqual(await run('window.musicPlayer.getListeningData()'), feedback)
    await waitFor(`document.querySelector('button[aria-label="Лайк: Test Tone MP3"]')?.getAttribute("aria-pressed") === "true"`, 'restored like')
    const flacId = tracks.find(({ format }) => format === 'flac').id
    assert.equal(await run(`window.musicPlayer.getPlayableSource(${JSON.stringify(flacId)})`), null)
    await click('Test Tone MP3')
    await waitForAudio(`${advancing} && audio.src === ${JSON.stringify(mp3)}`, 'restored MP3 playback')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    const rescan = await run('window.musicPlayer.importFolder()')
    assert.deepEqual(rescan, { status: 'complete', tracks: available, processed: 1, issues: [{ entry: 'broken.mp3', reason: 'file-unreadable' }] })
    return
  }
  if (phase === 'playlist-import') {
    const waveSelector = 'select[aria-label="Режим «Моей волны»"]'
    await waitFor(`document.querySelector('${waveSelector}').value === 'balance'`, 'default Balance mode')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    await click('Выбрать папку')
    await waitFor('document.querySelectorAll("tbody tr").length === 2', 'catalog for playlists')
    const tracks = await run('window.musicPlayer.getTracks()')
    const mp3Id = tracks.find(track => track.format === 'mp3').id
    const flacId = tracks.find(track => track.format === 'flac').id
    for (const mode of ['familiar', 'balance', 'discovery']) {
      await choose('Режим «Моей волны»', mode)
      await waitFor(`document.querySelector('${waveSelector}').value === '${mode}' &&
        !document.querySelector('${waveSelector}').disabled`, `${mode} setting acknowledged`)
      assert.equal(await run('window.musicPlayer.getWaveMode()'), mode)
      assert.deepEqual(new Set(await run('window.musicPlayer.getWaveQueue()')), new Set([mp3Id, flacId]))
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
    const [playlist] = await run('window.musicPlayer.getPlaylists()')
    const duplicate = await run(`window.musicPlayer.addPlaylistTrack('${playlist.id}', '${mp3Id}')`)
    assert.deepEqual(duplicate.trackIds, [mp3Id, flacId])
    await click('Выше: Test Tone FLAC')
    await waitFor('document.querySelector(".playlist-track").innerText.includes("FLAC")', 'playlist reordered')
    const newOrder = await run('window.musicPlayer.getPlaylists()')
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
    await waitFor('document.querySelector(\'select[aria-label="Режим «Моей волны»"]\').value === "discovery"', 'restored Wave mode')
    await waitFor('!document.querySelector(\'nav button:last-child\').disabled', 'restored library')
    await click('Плейлисты')
    await waitFor('document.querySelector(".playlist-track")?.innerText.includes("Файл недоступен")', 'restored unavailable first track')
    assert.deepEqual(await run('window.musicPlayer.getPlaylists()'), [playlist])
    await click('Воспроизвести плейлист')
    await waitForAudio(`${advancing} && audio.src === '${mp3}'`, 'restored playlist playback')
    await click('Убрать из плейлиста: Test Tone MP3')
    await waitFor('document.querySelectorAll(".playlist-track").length === 1', 'track removed from playlist')
    assert.deepEqual(await run('window.musicPlayer.getPlaylists()'), [{ ...playlist, trackIds: [flacId] }])
    assert.equal(await run(`${buttons}.find(button => button.innerText === 'Воспроизвести плейлист').disabled`), true)
    await click('Удалить плейлист')
    await click('Отмена')
    assert.equal((await run('window.musicPlayer.getPlaylists()')).length, 1)
    await click('Удалить плейлист')
    await click('Подтвердить удаление')
    await waitFor('!document.querySelector(\'select[aria-label="Выбрать плейлист"]\')', 'playlist removed after confirmation')
    assert.deepEqual(await run('window.musicPlayer.getPlaylists()'), [])
    assert.equal((await run('window.musicPlayer.getTracks()')).length, 2)
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
      [window.musicPlayer.getTracks(), window.musicPlayer.getWaveQueue(),
        window.musicPlayer.getVolume(), window.musicPlayer.setVolume(0, true),
        window.musicPlayer.getPlaylists(), window.musicPlayer.createPlaylist('test'),
        window.musicPlayer.getWaveMode(), window.musicPlayer.setWaveMode('discovery')]
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
  assert.ok(tracks.every(track => !('path' in track) && /^music-player:\/\/app\/artwork\/[0-9a-f-]{36}$/.test(track.artworkUrl)))
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
    assert.match(await run(`window.musicPlayer.setVolume(${input}).then(() => 'accepted', e => e.message)`), /Invalid volume/)
  }
  for (const operation of [
    'createPlaylist("   ")', 'createPlaylist("a".repeat(101))', 'deletePlaylist("C:/Windows/win.ini")',
    'movePlaylistTrack("bad", "bad", 2)', 'setWaveMode("unknown")',
  ]) {
    assert.match(await run(`window.musicPlayer.${operation}.then(() => 'accepted', e => e.message)`), /Invalid/)
  }
  player.setSize(620, 520)
  await waitFor('innerWidth <= 620', 'compact Windows window')
  assert.equal(await run(`[document.querySelector('main'), document.querySelector('footer')].every(
    element => element.scrollWidth <= element.clientWidth)`), true)

  await search('нет такого трека')
  await waitFor('document.querySelector("main h2")?.innerText === "Треки не найдены"', 'empty search result')
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
  assert.deepEqual(await run('window.musicPlayer.getTracks()'), tracks)
  await search('тЕСТОВЫЙ')
  await waitFor('document.querySelectorAll("tbody tr").length === 1 && document.querySelector("tbody").innerText.includes("Test Tone MP3")', 'Cyrillic artist search')
  const flacId = tracks.find(track => track.format === 'flac').id
  await click('Лайк: Test Tone MP3')
  await waitFor('(async () => (await window.musicPlayer.getListeningData()).preferences.some(p => p.liked))()', 'saved like')
  await search('Test Tone')
  await waitFor('document.querySelectorAll("tbody tr").length === 2', 'title search')
  await click('Лайк: Test Tone FLAC')
  await waitFor('(async () => (await window.musicPlayer.getListeningData()).preferences.filter(p => p.liked).length === 2)()', 'second like')
  await click('Лайк: Test Tone FLAC')
  await waitFor('(async () => (await window.musicPlayer.getListeningData()).preferences.filter(p => p.liked).length === 1)()', 'cancelled like')
  assert.match(await run(`window.musicPlayer.setTrackPreference('bad-id', true).then(() => 'accepted', e => e.message)`), /Invalid preference/)
  await search('MP3')
  await waitFor('document.querySelectorAll("tbody tr").length === 1', 'filtered selection')
  await click('Test Tone MP3')
  const mp3 = await waitForAudio(advancing, 'MP3 playback')
  await waitFor('document.querySelector("footer .artwork img")?.naturalWidth === 12', 'now-playing artwork decoded')
  await waitFor('!!document.querySelector(\'button[aria-label="Пауза"]\')', 'pause button')
  await click('Пауза')
  await waitForAudio('audio.paused', 'pause')
  const pausedEvents = (await run('window.musicPlayer.getListeningData()')).events
  assert.deepEqual(pausedEvents.map(e => e.type), ['started'])
  await waitFor('!!document.querySelector(\'button[aria-label="Воспроизвести"]\')', 'resume button')
  await click('Воспроизвести')
  await waitForAudio('!audio.paused', 'resume')

  await click('Следующий трек')
  const flac = await waitForAudio(`${advancing} && audio.src !== ${JSON.stringify(mp3)} && audio.duration === 5`, 'next uses import order despite filter and sort')
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
  assert.equal(await run(`fetch(${JSON.stringify(flacArtwork)}).then(response => response.status)`), 404)
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
