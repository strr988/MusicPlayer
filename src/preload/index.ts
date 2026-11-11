import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/contracts'
import type { MusicPlayerApi } from '../shared/contracts'

const api: MusicPlayerApi = {
  importFolder: () => ipcRenderer.invoke(channels.importFolder),
  getTracks: () => ipcRenderer.invoke(channels.getTracks),
  getPlayableSource: (trackId) => ipcRenderer.invoke(channels.getPlayableSource, trackId),
}

contextBridge.exposeInMainWorld('musicPlayer', api)
