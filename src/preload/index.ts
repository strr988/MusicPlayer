import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/contracts'
import type { MusicPlayerApi } from '../shared/contracts'

const api: MusicPlayerApi = {
  getWaveQueue: () => ipcRenderer.invoke(channels.getWaveQueue),
  getListeningData: () => ipcRenderer.invoke(channels.getListeningData),
  setTrackPreference: (trackId, liked) => ipcRenderer.invoke(channels.setTrackPreference, trackId, liked),
  recordPlaybackEvent: (event) => ipcRenderer.invoke(channels.recordPlaybackEvent, event),
  importFolder: () => ipcRenderer.invoke(channels.importFolder),
  getTracks: () => ipcRenderer.invoke(channels.getTracks),
  getPlayableSource: (trackId) => ipcRenderer.invoke(channels.getPlayableSource, trackId),
  getVolume: () => ipcRenderer.invoke(channels.getVolume),
  setVolume: (level, muted) => ipcRenderer.invoke(channels.setVolume, level, muted),
}

contextBridge.exposeInMainWorld('musicPlayer', api)
