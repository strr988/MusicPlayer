import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/contracts'
import type { MusicPlayerApi } from '../shared/contracts'

const api: MusicPlayerApi = {
  getWaveQueue: () => ipcRenderer.invoke(channels.getWaveQueue),
  getWaveRecommendations: () => ipcRenderer.invoke(channels.getWaveRecommendations),
  getWaveMode: () => ipcRenderer.invoke(channels.getWaveMode),
  setWaveMode: (mode) => ipcRenderer.invoke(channels.setWaveMode, mode),
  getPlaylists: () => ipcRenderer.invoke(channels.getPlaylists),
  createPlaylist: (name) => ipcRenderer.invoke(channels.createPlaylist, name),
  renamePlaylist: (id, name) => ipcRenderer.invoke(channels.renamePlaylist, id, name),
  deletePlaylist: (id) => ipcRenderer.invoke(channels.deletePlaylist, id),
  addPlaylistTrack: (id, trackId) => ipcRenderer.invoke(channels.addPlaylistTrack, id, trackId),
  removePlaylistTrack: (id, trackId) => ipcRenderer.invoke(channels.removePlaylistTrack, id, trackId),
  movePlaylistTrack: (id, trackId, offset) => ipcRenderer.invoke(channels.movePlaylistTrack, id, trackId, offset),
  getListeningData: () => ipcRenderer.invoke(channels.getListeningData),
  setTrackPreference: (trackId, liked) => ipcRenderer.invoke(channels.setTrackPreference, trackId, liked),
  recordPlaybackEvent: (event) => ipcRenderer.invoke(channels.recordPlaybackEvent, event),
  importFolder: () => ipcRenderer.invoke(channels.importFolder),
  getTracks: () => ipcRenderer.invoke(channels.getTracks),
  getPlayableSource: (trackId) => ipcRenderer.invoke(channels.getPlayableSource, trackId),
  getVolume: () => ipcRenderer.invoke(channels.getVolume),
  setVolume: (level, muted) => ipcRenderer.invoke(channels.setVolume, level, muted),
  getPlaybackSession: () => ipcRenderer.invoke(channels.getPlaybackSession),
  setPlaybackSession: (session) => ipcRenderer.invoke(channels.setPlaybackSession, session),
}

contextBridge.exposeInMainWorld('musicPlayer', api)
