import { BrowserWindow, globalShortcut, ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebPreferences } from 'electron'
import { channels, isSoundEffect, playerOrigin, shortcutActions, themeBackground } from '../shared/contracts'
import type { MiniPlayback, MiniState, PlaybackCommand, ShortcutAction } from '../shared/contracts'
import type { Library } from './library'
import { readTrackLyrics } from './lyrics'
import { Shortcuts } from './shortcuts'
import { windowChrome } from './window-chrome'

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const artworkPrefix = playerOrigin + '/artwork/'
const validId = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && idPattern.test(value)
const validArtwork = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(artworkPrefix) && validId(value.slice(artworkPrefix.length))
const numeric = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isShortcut = (value: unknown): value is ShortcutAction => shortcutActions.includes(value as ShortcutAction)
const label = (value: unknown): value is string => typeof value === 'string' && value.length <= 1_024

function miniPlayback(value: unknown): MiniPlayback {
  if (!isObject(value)) throw new Error('Invalid mini player state')
  const { track, entryId, playing, canPlay, canGoBack, canGoNext, duration, position, seekable, volume, sound, savingSound, soundError } = value
  if ((entryId !== null && !validId(entryId)) || typeof playing !== 'boolean' || typeof canPlay !== 'boolean' ||
      typeof canGoBack !== 'boolean' || typeof canGoNext !== 'boolean' || typeof seekable !== 'boolean' ||
      (duration !== null && !numeric(duration)) || !numeric(position) || typeof savingSound !== 'boolean' ||
      !label(soundError)) throw new Error('Invalid mini player state')
  let trackData: MiniPlayback['track'] = null
  if (track !== null) {
    if (!isObject(track) || !label(track.title) || (track.artist !== null && !label(track.artist)) ||
        (track.artworkUrl !== null && !validArtwork(track.artworkUrl))) {
      throw new Error('Invalid mini player track')
    }
    trackData = { title: track.title, artist: track.artist, artworkUrl: track.artworkUrl }
  }
  let volumeData: MiniPlayback['volume'] = null
  if (volume !== null) {
    if (!isObject(volume) || !numeric(volume.level, 1) || typeof volume.muted !== 'boolean') {
      throw new Error('Invalid mini player volume')
    }
    volumeData = { level: volume.level, muted: volume.muted }
  }
  let soundData: MiniPlayback['sound'] = null
  if (sound !== null) {
    if (!isObject(sound) || !isSoundEffect(sound.effect) || !isObject(sound.reverb)) throw new Error('Invalid sound presets')
    const { original, 'speed-up': speedUp, slowed } = sound.reverb
    if (typeof original !== 'boolean' || typeof speedUp !== 'boolean' || typeof slowed !== 'boolean') {
      throw new Error('Invalid preset reverb')
    }
    soundData = { effect: sound.effect, reverb: { original, 'speed-up': speedUp, slowed } }
  }
  return { track: trackData, entryId, playing, canPlay, canGoBack, canGoNext, duration, position, seekable,
    volume: volumeData, sound: soundData, savingSound, soundError }
}

function playbackCommand(input: unknown): PlaybackCommand {
  if (isObject(input)) {
    if (isShortcut(input.type)) return { type: input.type }
    if (input.type === 'volume' && numeric(input.level, 1)) return { type: input.type, level: input.level }
    if (input.type === 'sound-effect' && isSoundEffect(input.effect)) return { type: input.type, effect: input.effect }
    if (input.type === 'reverb' && isSoundEffect(input.effect) && typeof input.enabled === 'boolean') {
      return { type: input.type, effect: input.effect, enabled: input.enabled }
    }
    if (input.type === 'seek' && validId(input.entryId) && numeric(input.seconds)) {
      return { type: input.type, entryId: input.entryId, seconds: input.seconds }
    }
  }
  throw new Error('Invalid playback command')
}

export function registerPlayerExperience(
  library: Library,
  getMain: () => BrowserWindow | null,
  mainSender: (event: IpcMainInvokeEvent) => BrowserWindow,
  entryUrl: string,
  preferences: WebPreferences,
  appIcon: string,
) {
  const miniUrl = new URL(entryUrl)
  miniUrl.hash = 'mini-player'
  let mini: BrowserWindow | null = null
  let playback: MiniPlayback | null = null
  let pinned = library.getMiniPinned()
  let quitting = false
  let fullWindow: BrowserWindow | null = null
  let lastDiscoBeat = -Infinity
  let pendingLyrics = Promise.resolve()
  const sendCommand = (command: PlaybackCommand) => getMain()?.webContents.send(channels.playbackCommand, command)
  const shortcuts = new Shortcuts(globalShortcut, type => sendCommand({ type }), library.getShortcuts(),
    (action, accelerator) => library.setShortcut(action, accelerator))

  let miniCursor = library.getCursorSettings().selected
  const state = (): MiniState => ({ playback, pinned, cursor: miniCursor })
  const publish = () => mini?.webContents.send(channels.miniState, state())
  const showMain = () => {
    const main = getMain()
    if (!main || main.isDestroyed() || quitting) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
  }

  function miniSender(event: IpcMainInvokeEvent): BrowserWindow {
    if (!mini || event.sender !== mini.webContents || event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame?.url !== miniUrl.href) throw new Error('IPC sender denied')
    return mini
  }

  ipcMain.handle(channels.openMiniPlayer, async (event, ...args: unknown[]) => {
    const main = mainSender(event)
    if (args.length || quitting) throw new Error('Invalid mini player request')
    if (mini) {
      mini.focus()
      return
    }
    miniCursor = library.getCursorSettings().selected
    const zoomFactor = library.getInterfaceScale() / 100
    const compact = new BrowserWindow({
      ...windowChrome(library.getTheme()),
      width: Math.ceil(390 * zoomFactor), height: Math.ceil(236 * zoomFactor), useContentSize: true,
      resizable: false, maximizable: false, show: false, alwaysOnTop: pinned,
      title: 'mustplay · Мини-плеер', icon: appIcon, backgroundColor: themeBackground[library.getTheme()],
      webPreferences: { ...preferences, zoomMode: 'isolated', zoomFactor, additionalArguments: ['--mustplay-mini'] },
    })
    mini = compact
    compact.setMenu(null)
    compact.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    compact.webContents.on('will-navigate', event => event.preventDefault())
    compact.webContents.on('will-redirect', event => event.preventDefault())
    compact.once('closed', () => {
      mini = null
      playback = null
      if (getMain() === main && !main.isDestroyed() && !quitting) {
        main.webContents.send(channels.miniVisibility, false)
        showMain()
      }
    })
    main.webContents.send(channels.miniVisibility, true)
    try {
      await compact.loadURL(miniUrl.href)
      if (compact.isDestroyed() || main.isDestroyed() || quitting) return
      compact.show()
      main.hide()
    } catch (error) {
      if (compact.isDestroyed()) return
      compact.destroy()
      throw error
    }
  })
  ipcMain.handle(channels.getMiniState, (event, ...args: unknown[]) => {
    miniSender(event)
    if (args.length) throw new Error('Unexpected mini player arguments')
    return state()
  })
  ipcMain.handle(channels.publishMiniState, (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length !== 1) throw new Error('Invalid mini player state arguments')
    const next = miniPlayback(args[0])
    if (!mini) return
    playback = next
    publish()
  })
  ipcMain.handle(channels.publishDiscoBeat, (event, ...args: unknown[]) => {
    mainSender(event)
    const [strength] = args
    if (args.length !== 1 || !numeric(strength, 1)) throw new Error('Invalid disco beat')
    const now = performance.now()
    if (!mini || now - lastDiscoBeat < 100) return
    lastDiscoBeat = now
    mini.webContents.send(channels.discoBeat, strength)
  })
  ipcMain.handle(channels.setMiniPinned, (event, ...args: unknown[]) => {
    const compact = miniSender(event)
    const [value] = args
    if (args.length !== 1 || typeof value !== 'boolean') throw new Error('Invalid mini player pin')
    library.setMiniPinned(value)
    pinned = value
    compact.setAlwaysOnTop(pinned)
    publish()
  })
  ipcMain.handle(channels.showMainPlayer, (event, ...args: unknown[]) => {
    const compact = miniSender(event)
    if (args.length) throw new Error('Unexpected mini player arguments')
    compact.close()
  })
  ipcMain.handle(channels.showFullPlayer, (event, ...args: unknown[]) => {
    const compact = miniSender(event)
    if (args.length) throw new Error('Unexpected fullscreen arguments')
    const main = getMain()
    if (!main || main.isDestroyed() || quitting) return
    compact.close()
    if (fullWindow === main) return
    fullWindow = main
    const clear = () => { if (fullWindow === main) fullWindow = null }
    main.once('closed', clear)
    main.once('leave-full-screen', () => {
      main.removeListener('closed', clear)
      if (fullWindow === main) fullWindow = null
      if (!main.isDestroyed()) main.webContents.send(channels.showFullPlayerEvent, false)
    })
    main.setFullScreen(true)
    main.webContents.send(channels.showFullPlayerEvent, true)
  })
  ipcMain.handle(channels.exitMiniFullscreen, (event, ...args: unknown[]) => {
    const main = mainSender(event)
    if (args.length) throw new Error('Unexpected fullscreen exit arguments')
    if (fullWindow === main) main.setFullScreen(false)
  })
  ipcMain.handle(channels.controlMiniPlayback, (event, ...args: unknown[]) => {
    miniSender(event)
    if (args.length !== 1) throw new Error('Invalid mini player command arguments')
    sendCommand(playbackCommand(args[0]))
  })
  ipcMain.handle(channels.getLyricsMode, (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length) throw new Error('Unexpected lyrics mode arguments')
    return library.getLyricsMode()
  })
  ipcMain.handle(channels.setLyricsMode, (event, ...args: unknown[]) => {
    mainSender(event)
    const [mode] = args
    if (args.length !== 1 || (mode !== 'read' && mode !== 'sync')) throw new Error('Invalid lyrics mode')
    library.setLyricsMode(mode)
  })
  ipcMain.handle(channels.getLyrics, (event, ...args: unknown[]) => {
    mainSender(event)
    const [id] = args
    if (args.length !== 1 || !validId(id)) throw new Error('Invalid lyrics track ID')
    const read = pendingLyrics.then(() => quitting ? null : readTrackLyrics(library, id))
    pendingLyrics = read.then(() => undefined, () => undefined)
    return read
  })
  ipcMain.handle(channels.getShortcuts, (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length) throw new Error('Unexpected shortcut arguments')
    return shortcuts.get()
  })
  ipcMain.handle(channels.setShortcut, (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length !== 2 || !isShortcut(args[0])) throw new Error('Invalid shortcut action')
    return shortcuts.set(args[0], args[1])
  })
  ipcMain.handle(channels.setShortcutCapture, (event, ...args: unknown[]) => {
    const main = mainSender(event)
    const [capturing] = args
    if (args.length !== 1 || typeof capturing !== 'boolean') throw new Error('Invalid shortcut capture state')
    if (capturing && (!main.isFocused() || quitting)) throw new Error('Shortcut capture requires focus')
    globalShortcut.setSuspended(capturing)
  })

  return {
    focus: () => {
      if (!mini || !mini.isVisible()) showMain()
      else {
        if (mini.isMinimized()) mini.restore()
        mini.focus()
      }
    },
    closeMini: () => mini?.destroy(),
    endShortcutCapture: () => { if (globalShortcut.isSuspended()) globalShortcut.setSuspended(false) },
    beginQuit: () => { quitting = true },
    dispose: () => shortcuts.dispose(),
  }
}
