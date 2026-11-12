import { dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { downloadChannels } from '../../shared/music-sources'
import { downloadIdPattern, metadataEdits } from './download-manager'
import type { DownloadManager } from './download-manager'
import { soundCloudLink } from './soundcloud'

function downloadId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !downloadIdPattern.test(value)) {
    throw new Error('Некорректный ID задачи.')
  }
  return value
}

export function registerDownloadIpc(manager: DownloadManager, senderWindow: (event: IpcMainInvokeEvent) => BrowserWindow) {
  function handle(channel: typeof downloadChannels[keyof typeof downloadChannels], count: number,
    handler: (owner: BrowserWindow, args: unknown[]) => unknown) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const owner = senderWindow(event)
      if (args.length !== count) throw new Error('Некорректные параметры загрузки.')
      return handler(owner, args)
    })
  }
  handle(downloadChannels.list, 0, () => manager.list())
  handle(downloadChannels.analyze, 1, (_owner, [url]) => manager.analyze(url))
  handle(downloadChannels.confirm, 2, (_owner, [id, edits]) => manager.confirm(downloadId(id), edits))
  handle(downloadChannels.cancel, 1, (_owner, [id]) => manager.cancel(downloadId(id)))
  handle(downloadChannels.dismiss, 1, (_owner, [id]) => manager.dismiss(downloadId(id)))
  handle(downloadChannels.addToLibrary, 1, (_owner, [id]) => manager.addToLibrary(downloadId(id)))
  handle(downloadChannels.openSoundCloud, 1, async (_owner, [input]) => {
    const { metadata: { originalUrl } } = manager.soundCloudRecording(downloadId(input))
    await shell.openExternal(soundCloudLink(originalUrl).url).catch(() => {
      throw new Error('Не удалось открыть трек в браузере.')
    })
  })
  let choosingOriginal = false
  handle(downloadChannels.importSoundCloudOriginal, 2, async (owner, [input, value]) => {
    const id = downloadId(input)
    const edits = metadataEdits(value)
    const { trackId } = manager.soundCloudRecording(id)
    if (trackId || choosingOriginal) return false
    choosingOriginal = true
    try {
      const selection = await dialog.showOpenDialog(owner, {
        title: 'Выберите скачанный оригинал SoundCloud',
        filters: [{ name: 'MP3 и FLAC', extensions: ['mp3', 'flac'] }],
        properties: ['openFile'],
      }).catch(() => { throw new Error('Не удалось открыть диалог выбора аудиофайла.') })
      if (selection.canceled || !selection.filePaths[0]) return false
      return await manager.importSoundCloudOriginal(id, selection.filePaths[0], edits)
    } finally {
      choosingOriginal = false
    }
  })
  handle(downloadChannels.reveal, 1, async (_owner, [input]) => {
    const id = downloadId(input)
    const path = await manager.file(id).catch(() => { throw new Error('Загруженный файл недоступен.') })
    shell.showItemInFolder(path)
  })
  let choosingCover = false
  handle(downloadChannels.chooseCover, 1, async (owner, [input]) => {
    const id = downloadId(input)
    if (choosingCover) return null
    choosingCover = true
    try {
      const selection = await dialog.showOpenDialog(owner, {
        title: 'Выберите обложку',
        filters: [{ name: 'PNG и JPEG', extensions: ['png', 'jpg', 'jpeg'] }],
        properties: ['openFile'],
      })
      if (selection.canceled || !selection.filePaths[0]) return null
      return await manager.setCover(id, selection.filePaths[0])
    } catch {
      throw new Error('Не удалось открыть обложку. Выберите статичный PNG или JPEG до 2 МиБ и 2048 × 2048.')
    } finally {
      choosingCover = false
    }
  })
}
