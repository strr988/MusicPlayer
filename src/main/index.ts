import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { channels, playerOrigin } from '../shared/contracts'
import type { ImportResult } from '../shared/contracts'
import { Library } from './library'
import { serveMedia } from './media'

const scheme = 'music-player'
const trackIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
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
  ipcMain.handle(channels.importFolder, (event) => {
    const owner = senderWindow(event)
    pendingImport ??= chooseFolder(owner, library).finally(() => { pendingImport = undefined })
    return pendingImport
  })
  ipcMain.handle(channels.getTracks, (event) => {
    senderWindow(event)
    return library.getTracks()
  })
  ipcMain.handle(channels.getPlayableSource, async (event, trackId: unknown) => {
    senderWindow(event)
    if (typeof trackId !== 'string' || !trackIdPattern.test(trackId)) return null
    const sourceId = library.getSourceId(trackId)
    const source = sourceId && await library.getAvailableSource(sourceId)
    return source ? { url: `${playerOrigin}/audio/${source.id}` } : null
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
  app.once('will-quit', () => library.close())
  await library.refreshAvailability()

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
      return trackIdPattern.test(id) ? serveMedia(request, library, id) : new Response(null, { status: 404 })
    }
    const asset = assets.get(url.pathname)
    return asset ? net.fetch(asset.href, { method: request.method }) : new Response(null, { status: 404 })
  })

  registerIpc(library)

  async function createWindow(): Promise<void> {
    const player = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 730,
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
