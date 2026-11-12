import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, expect, test, vi } from 'vitest'
import { registerDownloadIpc } from '../src/main/music-sources/ipc'
import type { DownloadManager } from '../src/main/music-sources/download-manager'
import { downloadChannels } from '../src/shared/music-sources'

const electron = vi.hoisted(() => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}))
vi.mock('electron', () => electron)

const id = '00000000-0000-0000-0000-000000000001'
const owner = {} as BrowserWindow
const trusted = {} as IpcMainInvokeEvent
const url = 'https://soundcloud.com/artist/track'
const manager = {
  soundCloudRecording: vi.fn(),
  importSoundCloudOriginal: vi.fn(),
}

beforeEach(() => {
  vi.resetAllMocks()
  manager.soundCloudRecording.mockReturnValue({ metadata: { originalUrl: url } })
  manager.importSoundCloudOriginal.mockResolvedValue(true)
  electron.shell.openExternal.mockResolvedValue(undefined)
  registerDownloadIpc(manager as unknown as DownloadManager, event => {
    if (event !== trusted) throw new Error('Untrusted sender')
    return owner
  })
})

function handler(channel: string) {
  return electron.ipcMain.handle.mock.calls.find(([name]) => name === channel)![1] as
    (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
}

test('opens only the canonical address from a trusted SoundCloud analysis', async () => {
  const open = handler(downloadChannels.openSoundCloud)
  expect(() => open({} as IpcMainInvokeEvent, id)).toThrow('Untrusted sender')
  expect(() => open(trusted, id, url)).toThrow('параметры')
  await expect(open(trusted, url)).rejects.toThrow('ID')
  manager.soundCloudRecording.mockReturnValueOnce({ metadata: { originalUrl: 'https://soundcloud.com.evil.test/artist/track' } })
  await expect(open(trusted, id)).rejects.toThrow('HTTPS')
  expect(electron.shell.openExternal).not.toHaveBeenCalled()
  manager.soundCloudRecording.mockReturnValueOnce({ metadata: { originalUrl: 'https://m.soundcloud.com/artist/track?si=tracking' } })
  await open(trusted, id)
  expect(electron.shell.openExternal).toHaveBeenCalledExactlyOnceWith(url)
})

test('imports only the native dialog selection and skips the picker for an existing track', async () => {
  const importOriginal = handler(downloadChannels.importSoundCloudOriginal)
  expect(() => importOriginal(trusted, id, {}, 'injected.mp3')).toThrow('параметры')
  await expect(importOriginal(trusted, id, { path: 'injected.mp3' })).rejects.toThrow('поле')
  manager.soundCloudRecording.mockReturnValueOnce({ metadata: { originalUrl: url }, trackId: 'existing' })
  await expect(importOriginal(trusted, id, {})).resolves.toBe(false)
  expect(electron.dialog.showOpenDialog).not.toHaveBeenCalled()
  electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
  await expect(importOriginal(trusted, id, {})).resolves.toBe(false)
  expect(manager.importSoundCloudOriginal).not.toHaveBeenCalled()
  electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['selected.flac'] })
  await expect(importOriginal(trusted, id, { title: ' Edited ' })).resolves.toBe(true)
  expect(manager.importSoundCloudOriginal).toHaveBeenCalledExactlyOnceWith(id, 'selected.flac', { title: 'Edited' })
})
