import { randomInt } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, session } from 'electron'
import type { IpcMainInvokeEvent, WebContents, WebPreferences } from 'electron'
import { builtInCursors, channels, interfaceScales, isSoundEffect, maxWavePulse, playerOrigin, playerScheme, playlistNameLimit, themeBackground, waveModes } from '../shared/contracts'
import type { ImportResult, InterfaceScale, RescanResult, WaveMode } from '../shared/contracts'
import { hasTitleBarOverlay, titleBarColors, windowChrome } from './window-chrome'
import { Library } from './library'
import { readCursorPreset } from './cursor-presets'
import { serveMedia } from './media'
import { Artwork } from './artwork'
import { validatePlaybackEvent, validatePreference } from './feedback-validation'
import { validatePlaybackSession } from './playback-session'
import { registerPlayerExperience } from './player-experience'
import { resolveLibraryPath, resolveProfileDirectory } from './library-profile'
import { explainWave, generateWave } from '../recommendations/engine'
import type { RecommendationContext } from '../recommendations/engine'

const appIcon = fileURLToPath(new URL('./mustplay.ico', import.meta.url))
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
protocol.registerSchemesAsPrivileged([{
  scheme: playerScheme,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}])

const developmentEntry = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
const developmentUrl = developmentEntry ? new URL(developmentEntry) : null
if (developmentUrl && (developmentUrl.protocol !== 'http:' || developmentUrl.hostname !== '127.0.0.1' ||
    developmentUrl.username || developmentUrl.password)) {
  throw new Error('Expected a loopback renderer development server')
}
const entryUrl = developmentUrl?.href ?? `${playerOrigin}/`
let window: BrowserWindow | null = null
let pendingImport: Promise<ImportResult> | undefined
let importingCursor = false
let pendingRescan: Promise<RescanResult> | undefined

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  if (!window || event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== entryUrl) {
    throw new Error('IPC sender denied')
  }
  return window
}

function playlistId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !idPattern.test(value)) throw new Error('Invalid playlist or track ID')
  return value
}

function playlistName(value: unknown): string {
  if (typeof value !== 'string' || value.length > playlistNameLimit ||
      !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid playlist name')
  return value.trim()
}

async function chooseFolder(owner: BrowserWindow, library: Library): Promise<ImportResult> {
  try {
    const selection = await dialog.showOpenDialog(owner, {
      title: 'Выберите папку с музыкой',
      properties: ['openDirectory'],
    })
    if (selection.canceled || !selection.filePaths[0]) return { status: 'cancelled' }
    return await library.importFolder(selection.filePaths[0])
  } catch {
    return { status: 'failed' }
  }
}

function registerIpc(library: Library): void {
  ipcMain.handle(channels.getPlaybackSession, (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length !== 0) throw new Error('Unexpected playback session arguments')
    return library.getPlaybackSession()
  })
  ipcMain.handle(channels.setPlaybackSession, (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length !== 1) throw new Error('Unexpected playback session arguments')
    library.setPlaybackSession(validatePlaybackSession(args[0]))
  })
  async function waveContext(): Promise<RecommendationContext> {
    const candidates = await library.getRecommendationCandidates()
    return {
      candidates, listening: library.getListeningData(), now: Date.now(),
      seed: randomInt(2 ** 32), mode: library.getWaveMode(),
    }
  }
  ipcMain.handle(channels.getWaveQueue, async (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length !== 0) throw new Error('Unexpected wave arguments')
    return generateWave(await waveContext(), 10)
  })
  ipcMain.handle(channels.getWaveRecommendations, async (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length !== 0) throw new Error('Unexpected wave arguments')
    return explainWave(await waveContext(), 10)
  })
  ipcMain.handle(channels.getWaveMode, (event) => {
    senderWindow(event)
    return library.getWaveMode()
  })
  ipcMain.handle(channels.setWaveMode, (event, mode: unknown) => {
    senderWindow(event)
    if (!waveModes.includes(mode as WaveMode)) throw new Error('Invalid wave mode')
    library.setWaveMode(mode as WaveMode)
  })
  ipcMain.handle(channels.getWavePulse, (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length) throw new Error('Unexpected Wave pulse arguments')
    return library.getWavePulse()
  })
  ipcMain.handle(channels.setWavePulse, (event, ...args: unknown[]) => {
    senderWindow(event)
    const [intensity] = args
    if (args.length !== 1 || typeof intensity !== 'number' || !Number.isInteger(intensity) ||
        intensity < 0 || intensity > maxWavePulse) throw new Error('Invalid Wave pulse intensity')
    library.setWavePulse(intensity)
  })
  ipcMain.handle(channels.setTheme, (event, ...args: unknown[]) => {
    const player = senderWindow(event)
    const [theme] = args
    if (args.length !== 1 || (theme !== 'dark' && theme !== 'light')) throw new Error('Invalid theme')
    library.setTheme(theme)
    nativeTheme.themeSource = theme
    player.setBackgroundColor(themeBackground[theme])
    if (hasTitleBarOverlay) player.setTitleBarOverlay(titleBarColors(theme))
  })
  ipcMain.handle(channels.getInterfaceScale, (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length) throw new Error('Unexpected interface scale arguments')
    return library.getInterfaceScale()
  })
  ipcMain.handle(channels.setInterfaceScale, (event, ...args: unknown[]) => {
    const player = senderWindow(event)
    const [scale] = args as InterfaceScale[]
    if (args.length !== 1 || !interfaceScales.includes(scale)) throw new Error('Invalid interface scale')
    library.setInterfaceScale(scale)
    player.webContents.setZoomFactor(scale / 100)
  })
  ipcMain.handle(channels.getSoundEffect, (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length) throw new Error('Unexpected sound effect arguments')
    return library.getSoundEffect()
  })
  ipcMain.handle(channels.setSoundEffect, (event, ...args: unknown[]) => {
    senderWindow(event)
    const [effect] = args
    if (args.length !== 1 || !isSoundEffect(effect)) throw new Error('Invalid sound effect')
    library.setSoundEffect(effect)
  })
  ipcMain.handle(channels.setReverb, (event, ...args: unknown[]) => {
    senderWindow(event)
    const [effect, enabled] = args
    if (args.length !== 2 || !isSoundEffect(effect) || typeof enabled !== 'boolean') throw new Error('Invalid reverb setting')
    library.setReverb(effect, enabled)
  })
  ipcMain.handle(channels.getCursorSettings, (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length) throw new Error('Unexpected cursor arguments')
    return library.getCursorSettings()
  })
  ipcMain.handle(channels.setCursorPreset, (event, ...args: unknown[]) => {
    senderWindow(event)
    const [id] = args
    if (args.length !== 1 || typeof id !== 'string' || !(builtInCursors.some(value => value === id) || idPattern.test(id))) {
      throw new Error('Invalid cursor preset ID')
    }
    return library.setCursorPreset(id)
  })
  ipcMain.handle(channels.importCursorPreset, async (event, ...args: unknown[]) => {
    const owner = senderWindow(event)
    if (args.length || importingCursor) throw new Error('Invalid cursor import request')
    importingCursor = true
    try {
      const result = await dialog.showOpenDialog(owner, {
        title: 'Импорт пресета курсора', properties: ['openFile'], filters: [{ name: 'Пресет mustplay', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePaths[0]) return null
      const { label, arrow, pointer } = await readCursorPreset(result.filePaths[0])
      return library.importCursorPreset(label, arrow, pointer)
    } finally {
      importingCursor = false
    }
  })
  ipcMain.handle(channels.getDiscoMode, (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length) throw new Error('Unexpected disco arguments')
    return library.getDiscoMode()
  })
  ipcMain.handle(channels.setDiscoMode, (event, ...args: unknown[]) => {
    senderWindow(event)
    const [enabled] = args
    if (args.length !== 1 || typeof enabled !== 'boolean') throw new Error('Invalid disco setting')
    library.setDiscoMode(enabled)
  })
  ipcMain.handle(channels.getPlaylists, (event) => {
    senderWindow(event)
    return library.getPlaylists()
  })
  ipcMain.handle(channels.createPlaylist, (event, name: unknown) => {
    senderWindow(event)
    return library.createPlaylist(playlistName(name))
  })
  ipcMain.handle(channels.renamePlaylist, (event, id: unknown, name: unknown) => {
    senderWindow(event)
    library.renamePlaylist(playlistId(id), playlistName(name))
  })
  ipcMain.handle(channels.deletePlaylist, (event, id: unknown) => {
    senderWindow(event)
    library.deletePlaylist(playlistId(id))
  })
  ipcMain.handle(channels.addPlaylistTrack, (event, id: unknown, trackId: unknown) => {
    senderWindow(event)
    return library.addPlaylistTrack(playlistId(id), playlistId(trackId))
  })
  ipcMain.handle(channels.removePlaylistTrack, (event, id: unknown, trackId: unknown) => {
    senderWindow(event)
    return library.removePlaylistTrack(playlistId(id), playlistId(trackId))
  })
  ipcMain.handle(channels.movePlaylistTrack, (event, id: unknown, trackId: unknown, offset: unknown) => {
    senderWindow(event)
    if (offset !== -1 && offset !== 1) throw new Error('Invalid playlist move')
    return library.movePlaylistTrack(playlistId(id), playlistId(trackId), offset)
  })
  ipcMain.handle(channels.getListeningData, (event) => {
    senderWindow(event)
    return library.getListeningData()
  })
  ipcMain.handle(channels.setTrackPreference, (event, trackId: unknown, liked: unknown) => {
    senderWindow(event)
    validatePreference(trackId, liked)
    return library.setTrackPreference(trackId as string, liked as boolean)
  })
  ipcMain.handle(channels.recordPlaybackEvent, (event, input: unknown) => {
    senderWindow(event)
    validatePlaybackEvent(input)
    library.recordPlaybackEvent(input)
  })
  ipcMain.handle(channels.importFolder, (event, ...args: unknown[]) => {
    const owner = senderWindow(event)
    if (args.length) throw new Error('Unexpected import arguments')
    pendingImport ??= chooseFolder(owner, library).finally(() => { pendingImport = undefined })
    return pendingImport
  })
  ipcMain.handle(channels.getMusicFolders, (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length) throw new Error('Unexpected music folder arguments')
    return library.getMusicFolders()
  })
  ipcMain.handle(channels.removeMusicFolder, (event, ...args: unknown[]) => {
    senderWindow(event)
    const [id] = args
    if (args.length !== 1 || typeof id !== 'string' || id.length !== 64 || !/^[a-f0-9]+$/.test(id)) {
      throw new Error('Invalid music folder ID')
    }
    return library.removeMusicFolder(id)
  })
  ipcMain.handle(channels.rescanLibrary, (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length !== 0) throw new Error('Unexpected library rescan arguments')
    pendingRescan ??= library.rescanLibrary().catch((): RescanResult => ({ status: 'failed' }))
      .finally(() => { pendingRescan = undefined })
    return pendingRescan
  })
  ipcMain.handle(channels.getTracks, async (event) => {
    senderWindow(event)
    await library.refreshAvailability()
    return library.getTracks()
  })
  ipcMain.handle(channels.getPlayableSource, async (event, trackId: unknown) => {
    senderWindow(event)
    if (typeof trackId !== 'string' || !idPattern.test(trackId)) return null
    const sourceId = library.getSourceId(trackId)
    const source = sourceId && await library.getAvailableSource(sourceId)
    return source ? { url: `${playerOrigin}/audio/${source.id}` } : null
  })
  ipcMain.handle(channels.getVolume, (event, ...args: unknown[]) => {
    senderWindow(event)
    if (args.length !== 0) throw new Error('Unexpected volume arguments')
    return library.getVolume()
  })
  ipcMain.handle(channels.setVolume, (event, ...args: unknown[]) => {
    senderWindow(event)
    const [level, muted] = args
    if (args.length !== 2 || typeof level !== 'number' || !Number.isFinite(level) ||
        level < 0 || level > 1 || typeof muted !== 'boolean') throw new Error('Invalid volume preference')
    library.setVolume({ level, muted })
  })
}

async function start(): Promise<void> {
  const defaultProfile = join(app.getPath('appData'), app.getName())
  const current = app.getPath('userData')
  const userData = current === defaultProfile && !app.commandLine.hasSwitch('user-data-dir')
    ? resolveProfileDirectory(current, join(app.getPath('appData'), 'Music Player'))
    : current
  await mkdir(userData, { recursive: true })
  if (userData !== current) app.setPath('userData', userData)
  app.setAppUserModelId('mustplay')
  // The profile has one writer for filesystem scans and playback availability updates.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  const library = new Library(resolveLibraryPath(userData))
  nativeTheme.themeSource = library.getTheme()
  const artwork = new Artwork(library)
  app.once('will-quit', () => library.close())

  const playerSession = session.fromPartition('mustplay')
  const canEnterFullscreen = (contents: WebContents | null, permission: string, details: {
    isMainFrame: boolean
    requestingUrl?: string
  }) => permission === 'fullscreen' && details.isMainFrame && details.requestingUrl === entryUrl &&
    contents === window?.webContents && contents?.mainFrame.url === entryUrl
  playerSession.setPermissionRequestHandler((contents, permission, reply, details) => {
    reply(canEnterFullscreen(contents, permission, details))
  })
  playerSession.setPermissionCheckHandler((contents, permission, _origin, details) => canEnterFullscreen(contents, permission, details))
  playerSession.on('will-download', (event) => event.preventDefault())

  const renderer = new URL('../renderer/', import.meta.url)
  const assets = new Map<string, URL>()
  if (!developmentUrl) {
    assets.set('/', new URL('index.html', renderer))
    const directory = new URL('assets/', renderer)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile()) assets.set(`/assets/${entry.name}`, new URL(encodeURIComponent(entry.name), directory))
    }
  }

  playerSession.protocol.handle(playerScheme, async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app' || url.username || url.password || url.search) return new Response(null, { status: 404 })
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    if (url.pathname.startsWith('/audio/')) {
      const id = url.pathname.slice('/audio/'.length)
      const response = idPattern.test(id) ? await serveMedia(request, library, id) : new Response(null, { status: 404 })
      if (developmentUrl && request.headers.get('origin') === developmentUrl.origin) {
        response.headers.set('Access-Control-Allow-Origin', developmentUrl.origin)
      }
      return response
    }
    if (url.pathname.startsWith('/cursor/')) {
      const [, , id, kind, extra] = url.pathname.split('/')
      const png = extra === undefined && idPattern.test(id) && (kind === 'arrow' || kind === 'pointer')
        ? library.readCursorImage(id, kind) : undefined
      return png ? new Response(request.method === 'HEAD' ? null : png, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      }) : new Response(null, { status: 404 })
    }
    if (url.pathname.startsWith('/artwork/')) {
      const id = url.pathname.slice('/artwork/'.length)
      return idPattern.test(id) ? artwork.serve(request, id) : new Response(null, { status: 404 })
    }
    const asset = assets.get(url.pathname)
    return asset ? net.fetch(asset.href, { method: request.method }) : new Response(null, { status: 404 })
  })

  registerIpc(library)
  const preferences: WebPreferences = {
    session: playerSession,
    preload: fileURLToPath(new URL('../preload/index.cjs', renderer)),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  }
  const experience = registerPlayerExperience(library, () => window, senderWindow, entryUrl, preferences, appIcon)
  app.on('before-quit', experience.beginQuit)
  app.once('will-quit', experience.dispose)

  async function createWindow(): Promise<void> {
    const player = new BrowserWindow({
      ...windowChrome(library.getTheme()),
      width: 1100,
      height: 760,
      minWidth: 620,
      minHeight: 520,
      title: 'mustplay',
      icon: appIcon,
      backgroundColor: themeBackground[library.getTheme()],
      autoHideMenuBar: true,
      webPreferences: {
        ...preferences,
        zoomMode: 'isolated',
        zoomFactor: library.getInterfaceScale() / 100,
        // Keep muted playback and automatic transitions running in a hidden window.
        backgroundThrottling: false,
      },
    })
    window = player
    player.setMenu(null)
    player.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    player.webContents.on('will-navigate', (event) => event.preventDefault())
    player.webContents.on('will-redirect', (event) => event.preventDefault())
    player.on('blur', experience.endShortcutCapture)
    player.webContents.on('render-process-gone', experience.endShortcutCapture)
    player.on('closed', () => {
      experience.endShortcutCapture()
      window = null
      experience.closeMini()
    })
    await player.loadURL(entryUrl)
  }

  await createWindow()
  app.on('second-instance', experience.focus)
  app.on('activate', () => {
    if (window) experience.focus()
    else void createWindow().catch(onStartupError)
  })
}

function onStartupError(error: unknown): void {
  console.error('mustplay failed to start', error)
  if (app.isPackaged) {
    dialog.showErrorBox('mustplay', 'Не удалось открыть плеер. Проверьте доступ к папке профиля и версию базы медиатеки.')
  }
  app.exit(1)
}

void app.whenReady().then(start).catch(onStartupError)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
