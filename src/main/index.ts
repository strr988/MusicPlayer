import { randomInt } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { channels, playerOrigin, playlistNameLimit, waveModes } from '../shared/contracts'
import type { ImportResult, WaveMode } from '../shared/contracts'
import { Library } from './library'
import { serveMedia } from './media'
import { Artwork, artworkMime } from './artwork'
import { DownloadManager } from './music-sources/download-manager'
import { YtDlpProvider } from './music-sources/archive'
import { registerDownloadIpc } from './music-sources/ipc'
import { validatePlaybackEvent, validatePreference } from './feedback-validation'
import { validatePlaybackSession } from './playback-session'
import { explainWave, generateWave } from '../recommendations/engine'
import type { RecommendationContext } from '../recommendations/engine'

const scheme = 'music-player'
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
protocol.registerSchemesAsPrivileged([{
  scheme,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
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
  ipcMain.handle(channels.importFolder, (event) => {
    const owner = senderWindow(event)
    pendingImport ??= chooseFolder(owner, library).finally(() => { pendingImport = undefined })
    return pendingImport
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
  const userData = app.getPath('userData')
  await mkdir(userData, { recursive: true })
  // The profile has one writer for filesystem scans and playback availability updates.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  const library = new Library(join(userData, 'library.sqlite3'))
  const artwork = new Artwork(library)
  const downloads = new DownloadManager(userData, new YtDlpProvider(join(userData, 'tools', 'yt-dlp.exe')), library)
  let quitting = false
  let downloadsStopped = false
  app.on('before-quit', event => {
    if (downloadsStopped) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    void downloads.stop().finally(() => {
      downloadsStopped = true
      app.quit()
    })
  })
  app.once('will-quit', () => library.close())

  const playerSession = session.fromPartition('music-player')
  playerSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false))
  playerSession.setPermissionCheckHandler(() => false)
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

  playerSession.protocol.handle(scheme, async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app' || url.username || url.password || url.search) return new Response(null, { status: 404 })
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    if (url.pathname.startsWith('/audio/')) {
      const id = url.pathname.slice('/audio/'.length)
      return idPattern.test(id) ? serveMedia(request, library, id) : new Response(null, { status: 404 })
    }
    if (url.pathname.startsWith('/artwork/')) {
      const id = url.pathname.slice('/artwork/'.length)
      return idPattern.test(id) ? artwork.serve(request, id) : new Response(null, { status: 404 })
    }
    if (url.pathname.startsWith('/download-artwork/')) {
      const [, , id, variant, extra] = url.pathname.split('/')
      const bytes = idPattern.test(id) && !extra && (variant === undefined || variant === 'custom') ?
        downloads.cover(id, variant === 'custom') : null
      const mime = bytes && artworkMime(bytes)
      if (!bytes || !mime) return new Response(null, { status: 404 })
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
        headers: { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      })
    }
    const asset = assets.get(url.pathname)
    return asset ? net.fetch(asset.href, { method: request.method }) : new Response(null, { status: 404 })
  })

  registerIpc(library)
  registerDownloadIpc(downloads, senderWindow)

  async function createWindow(): Promise<void> {
    const player = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 620,
      minHeight: 520,
      title: 'Music Player',
      backgroundColor: '#14131a',
      autoHideMenuBar: true,
      webPreferences: {
        session: playerSession,
        preload: fileURLToPath(new URL('../preload/index.cjs', renderer)),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // Keep muted playback and automatic transitions running in a hidden window.
        backgroundThrottling: false,
      },
    })
    window = player
    player.setMenu(null)
    player.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    player.webContents.on('will-navigate', (event) => event.preventDefault())
    player.webContents.on('will-redirect', (event) => event.preventDefault())
    player.on('closed', () => { window = null })
    await player.loadURL(entryUrl)
  }

  await createWindow()
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on('activate', () => { if (!window) void createWindow().catch(onStartupError) })
}

function onStartupError(error: unknown): void {
  console.error('Music Player failed to start', error)
  app.exit(1)
}

void app.whenReady().then(start).catch(onStartupError)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
