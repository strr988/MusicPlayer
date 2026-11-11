import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dialog } from 'electron'

import { catalogSize, longTitle } from './fixtures/interface-catalog.mjs'

export async function verifyInterface({ player, run, click, waitFor, waitForAudio, folder, pendingRows }) {
  const { webContents } = player
  const output = process.env.MUSIC_PLAYER_SCREENSHOTS
  const queueToggle = '.queue-toggle'
  const noOverflow = String.raw`(() => {
    const main = document.querySelector('main')
    const player = document.querySelector('footer')
    const queue = document.querySelector('.queue-panel')
    const scroll = document.scrollingElement
    return [main, player, queue, scroll].every(element =>
      element.scrollWidth <= element.clientWidth) &&
      main.getBoundingClientRect().bottom <= player.getBoundingClientRect().top &&
      (queue.hidden || queue.getBoundingClientRect().bottom <= player.getBoundingClientRect().top) &&
      scroll.scrollHeight === scroll.clientHeight
  })()`
  const key = keyCode => {
    webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const focus = selector => run('document.querySelector(' + JSON.stringify(selector) + ').focus()')
  const setInput = (selector, value) => run(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const size = async (width, height) => {
    player.setContentSize(width, height)
    await waitFor('innerWidth === ' + width + ' && innerHeight === ' + height, 'viewport ' + width + ' × ' + height)
    assert.equal(await run(noOverflow), true)
  }
  const capture = async name => {
    if (!output) return
    await mkdir(output, { recursive: true })
    const image = await webContents.capturePage()
    assert.equal(image.isEmpty(), false)
    await writeFile(join(output, name + '.png'), image.toPNG())
  }
  const openQueue = async () => {
    await focus(queueToggle)
    key('Enter')
    await waitFor('document.activeElement.matches(".queue-heading button") && ' +
      '!document.querySelector(".queue-panel").hidden', 'queue close button receives focus')
  }

  await size(1280, 800)
  await capture('05-library-empty-1280x800')
  await click('Моя волна')
  assert.equal(await run('document.querySelector(".wave-start .primary").disabled'), true)
  await click('Открыть библиотеку')
  assert.equal(await run('document.activeElement.getAttribute("aria-label")'), 'Библиотека')
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  await click('Выбрать папку')
  await waitFor('document.querySelectorAll("tbody tr").length === 100', 'first page of the synthetic library')
  const libraryPager = '[aria-label="Страницы библиотеки"]'
  const libraryNext = libraryPager + ' [aria-label="Следующая страница"]'
  player.focus()
  webContents.focus()
  await focus(libraryNext)
  key('Enter')
  await waitFor('document.querySelectorAll("tbody tr").length === ' + (catalogSize - 100), 'second page renders the remaining tracks')
  assert.equal(await run('document.activeElement.matches(' + JSON.stringify(libraryNext) + ')'), true)
  await setInput('.search-control input', 'Полевая запись · 120')
  await waitFor('document.querySelectorAll("tbody tr").length === 1 && ' +
    'document.querySelector("tbody .track-name").textContent === "Полевая запись · 120"', 'search includes tracks outside the first page')
  await setInput('.search-control input', '')
  await waitFor('document.querySelector("tbody .track-name").textContent === ' + JSON.stringify(longTitle), 'clearing search returns to first page')
  await run('document.querySelector("main").scrollTop = 0')
  assert.equal(await run('document.querySelector(".import-result").open'), false)
  await run('document.querySelector(".import-result summary").click()')
  assert.match(await run('document.querySelector(".import-result").innerText'), new RegExp('Файлов обработано: ' + catalogSize))
  await run('document.querySelector(".import-result summary").click()')

  await waitFor('document.querySelector("tbody img")?.naturalWidth > 0', 'embedded cover decoded')
  assert.equal(await run('!document.querySelector("tbody tr:first-child img") && ' +
    '!!document.querySelector("tbody tr:first-child .artwork [data-icon=music]")'), true)

  player.focus()
  webContents.focus()
  await focus('nav button[aria-label="Библиотека"]')
  key('Tab')
  await waitFor('document.activeElement.getAttribute("aria-label") === "Моя волна"', 'navigation is in the tab order')
  await waitFor('!document.querySelector(".play-button").disabled', 'keyboard play control is ready')
  await focus('footer .play-button')
  assert.equal(await run('document.activeElement.matches(".play-button")'), true)
  key('Enter')
  const source = await waitForAudio('!audio.paused && audio.currentTime > 0.1', 'keyboard starts playback')
  await run('void (window.originalAudio = document.querySelector("audio"))')

  await focus('nav button[aria-label="Моя волна"]')
  key('Enter')
  await waitFor('document.querySelector("nav [aria-current]").getAttribute("aria-label") === "Моя волна"', 'keyboard opens Wave')
  await click('Плейлисты')
  await waitForAudio('audio === window.originalAudio && !audio.paused && audio.src === ' + JSON.stringify(source), 'same audio plays across all sections')
  await waitFor('!document.querySelector(".play-button").disabled', 'keyboard play control is ready')
  await focus('footer .play-button')
  assert.equal(await run('document.activeElement.matches(".play-button")'), true)
  key('Enter')
  await waitForAudio('audio.paused', 'keyboard pauses playback')

  const events = () => run('window.musicPlayer.getListeningData().then(data => data.events)')
  await waitFor('(async () => (await window.musicPlayer.getListeningData()).events.length === 1)()', 'one started event')
  const initialEvents = await events()
  assert.deepEqual(initialEvents.map(event => event.type), ['started'])
  await click('Библиотека')
  await click('Воспроизвести следующим: ' + longTitle)
  await click('Добавить в очередь: ' + longTitle)
  const pending = await run('window.musicPlayer.getPlaybackSession().then(session => session.queue.pending.length)')
  assert.equal(pending, catalogSize + 1)
  assert.equal(await run('document.querySelector(".queue-panel").hidden'), true)
  await click('Лайк текущему треку')
  await waitFor('(async () => (await window.musicPlayer.getListeningData()).preferences.some(item => item.liked))()', 'player saves like')
  await waitFor('!!document.querySelector("tbody button[aria-pressed=true]")', 'track row reflects the player like')

  for (const [width, height] of [[620, 700], [900, 700], [1280, 800], [1480, 1024]]) {
    await size(width, height)
    const playerHeight = await run('document.querySelector("footer").getBoundingClientRect().height')
    const mainWidth = await run('document.querySelector("main").getBoundingClientRect().width')
    await openQueue()
    assert.equal(await run(noOverflow), true)
    assert.equal(await run('document.querySelector("footer").getBoundingClientRect().height'), playerHeight)
    assert.equal(await run('document.querySelector("main").inert'), width < 1080)
    assert.equal(await run('document.querySelector(".section-nav").inert'), width < 1080)
    assert.equal(await run('!!document.querySelector(".queue-scrim")'), width < 1080)
    const openedWidth = await run('document.querySelector("main").getBoundingClientRect().width')
    assert.ok(width < 1080 ? openedWidth === mainWidth : openedWidth < mainWidth)
    const firstPage = await pendingRows()
    assert.equal(firstPage.length, 100)
    const queuePager = '[aria-label="Страницы очереди"]'
    const pageQueue = async label => run('document.querySelector(' + JSON.stringify(queuePager + ' [aria-label="' + label + '"]') + ').click()')
    await pageQueue('Следующая страница')
    await waitFor('document.querySelectorAll(".queue-list li").length === ' + (pending - 100), 'queue second page is reachable')
    const rows = [...firstPage, ...await pendingRows()]
    assert.equal(rows.length, pending)
    assert.equal(rows.filter(row => row.title === longTitle).length, 2)
    assert.equal(new Set(rows.map(row => row.id)).size, pending)
    await pageQueue('Предыдущая страница')
    await waitFor('document.querySelectorAll(".queue-list li").length === 100', 'queue returns to the first page')
    assert.equal(await run(String.raw`(() => {
      const main = document.querySelector('main')
      const queue = document.querySelector('.queue-body')
      const previous = main.scrollTop
      queue.scrollTop = queue.scrollHeight
      const independent = queue.scrollTop > 0 && main.scrollTop === previous
      queue.scrollTop = 0
      return independent
    })()`), true)
    if (width === 620) {
      assert.equal(await run(String.raw`(() => {
        const title = document.querySelector('tbody .track-name')
        return title.scrollWidth > title.clientWidth &&
          getComputedStyle(document.querySelector('.album-column')).display === 'none' &&
          getComputedStyle(document.querySelector('.format-column')).display === 'none'
      })()`), true)
      key('Tab')
      await waitFor('document.activeElement.textContent === "Очистить ожидающие"', 'queue has a predictable tab order')
      await capture('04-queue-overlay-620x700')
    }
    if (width === 900) {
      await focus('.queue-list li:last-child [data-move="1"]')
      key('Enter')
      await waitFor('document.activeElement.closest("li")?.dataset.queueEntry === ' +
        JSON.stringify(rows[99].id), 'moving down across pages keeps the moved row focused')
      assert.equal((await pendingRows())[0].id, rows[99].id)
      await focus('.queue-list li:first-child [data-move="-1"]')
      key('Enter')
      await waitFor('document.activeElement.closest("li")?.dataset.queueEntry === ' +
        JSON.stringify(rows[99].id), 'moving up across pages keeps the moved row focused')
      assert.deepEqual(await pendingRows(), firstPage)
    }
    if (width === 1280) await capture('03-queue-docked-1280x800')
    key('Escape')
    await waitFor('document.querySelector(".queue-panel").hidden && document.activeElement.matches(".queue-toggle")', 'Escape closes queue and restores focus')
  }
  assert.deepEqual(await events(), initialEvents)
  assert.equal(await run('document.querySelectorAll("audio").length'), 1)
  await capture('01-library-1480x1024')

  await click('Добавить в плейлист: ' + longTitle)
  await waitFor('document.activeElement.textContent.trim() === "Создать плейлист"', 'library shortcut focuses the first playlist action')
  await click('Создать плейлист')
  await setInput('[aria-label="Название плейлиста"]', 'Ночная смена')
  await click('Сохранить')
  await waitFor('document.querySelector(\'select[aria-label="Трек для добавления"]\')?.value', 'new playlist has the requested track preselected')
  await click('Добавить')
  await waitFor('!!document.querySelector(".playlist-track")', 'track added via the library shortcut')
  for (const [index, title] of ['Полярная ночь', 'Километр тишины'].entries()) {
    await click('Библиотека')
    await click('Добавить в плейлист: ' + title)
    await waitFor('document.activeElement.getAttribute("aria-label") === "Трек для добавления"', 'library shortcut focuses the track picker')
    await click('Добавить')
    await waitFor('document.querySelectorAll(".playlist-track").length === ' + (index + 2), 'another track added')
  }
  await run('document.querySelector("main").scrollTop = 0')
  await capture('06-playlists-1480x1024')
  await click('Переименовать')
  const longName = 'Очень длинное название плейлиста для проверки переноса в компактном окне'
  await setInput('[aria-label="Название плейлиста"]', longName)
  await click('Сохранить')
  await waitFor('document.querySelector(".playlist-identity h2").textContent === ' + JSON.stringify(longName), 'long playlist name is shown in the detail header')
  for (const [width, height] of [[620, 700], [900, 700], [1280, 800], [1480, 1024]]) await size(width, height)
  await size(620, 700)
  await click('Удалить плейлист')
  await waitFor('document.activeElement.textContent === "Отмена"', 'delete confirmation starts on the safe action')
  assert.match(await run('document.querySelector(".playlist-confirm").innerText'), new RegExp(longName))
  await capture('07-playlist-delete-620x700')
  key('Escape')
  await waitFor('!document.querySelector(".playlist-confirm") && document.activeElement.textContent === "Удалить плейлист"', 'Escape cancels deletion and restores focus')
  assert.equal(await run('document.querySelectorAll(".playlist-track").length'), 3)

  await size(900, 700)
  await click('Моя волна')
  await focus('input[name="wave-mode"]:checked')
  key('Right')
  await waitFor('(async () => (await window.musicPlayer.getWaveMode()) === "discovery")()', 'arrow key changes the Wave mode')
  await waitFor('document.querySelector(\'input[value="discovery"]\').checked', 'selected mode reflected on the page')
  assert.deepEqual(await events(), initialEvents)
  await click('Запустить волну')
  await waitForAudio('!audio.paused && audio.currentTime > 0.1', 'Wave starts from its dedicated section')
  await waitFor('document.querySelector(".wave-status[role=status]")?.innerText.includes("Сейчас играет")', 'Wave reports active playback')
  await capture('02-wave-900x700')
}
