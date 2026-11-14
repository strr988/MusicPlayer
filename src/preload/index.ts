import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/contracts'
import type { IpcRendererEvent } from 'electron'
import type { MiniPlayerApi, MustplayApi } from '../shared/contracts'

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const api: MustplayApi = {
  getWaveQueue: () => ipcRenderer.invoke(channels.getWaveQueue),
  getWaveRecommendations: () => ipcRenderer.invoke(channels.getWaveRecommendations),
  getWaveMode: () => ipcRenderer.invoke(channels.getWaveMode),
  setWaveMode: (mode) => ipcRenderer.invoke(channels.setWaveMode, mode),
  getWavePulse: () => ipcRenderer.invoke(channels.getWavePulse),
  setWavePulse: (intensity) => ipcRenderer.invoke(channels.setWavePulse, intensity),
  getCursorSettings: () => ipcRenderer.invoke(channels.getCursorSettings),
  setCursorPreset: id => ipcRenderer.invoke(channels.setCursorPreset, id),
  importCursorPreset: () => ipcRenderer.invoke(channels.importCursorPreset),
  setTheme: (theme) => ipcRenderer.invoke(channels.setTheme, theme),
  getInterfaceScale: () => ipcRenderer.invoke(channels.getInterfaceScale),
  setInterfaceScale: (scale) => ipcRenderer.invoke(channels.setInterfaceScale, scale),
  getSoundEffect: () => ipcRenderer.invoke(channels.getSoundEffect),
  setSoundEffect: (effect) => ipcRenderer.invoke(channels.setSoundEffect, effect),
  setReverb: (effect, enabled) => ipcRenderer.invoke(channels.setReverb, effect, enabled),
  getDiscoMode: () => ipcRenderer.invoke(channels.getDiscoMode),
  setDiscoMode: (enabled) => ipcRenderer.invoke(channels.setDiscoMode, enabled),
  publishDiscoBeat: (strength) => ipcRenderer.invoke(channels.publishDiscoBeat, strength),
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
  getMusicFolders: () => ipcRenderer.invoke(channels.getMusicFolders),
  removeMusicFolder: id => ipcRenderer.invoke(channels.removeMusicFolder, id),
  importFolder: () => ipcRenderer.invoke(channels.importFolder),
  rescanLibrary: () => ipcRenderer.invoke(channels.rescanLibrary),
  getTracks: () => ipcRenderer.invoke(channels.getTracks),
  getPlayableSource: (trackId) => ipcRenderer.invoke(channels.getPlayableSource, trackId),
  getVolume: () => ipcRenderer.invoke(channels.getVolume),
  setVolume: (level, muted) => ipcRenderer.invoke(channels.setVolume, level, muted),
  getPlaybackSession: () => ipcRenderer.invoke(channels.getPlaybackSession),
  setPlaybackSession: (session) => ipcRenderer.invoke(channels.setPlaybackSession, session),
  getLyricsMode: () => ipcRenderer.invoke(channels.getLyricsMode),
  setLyricsMode: mode => ipcRenderer.invoke(channels.setLyricsMode, mode),
  getLyrics: (id) => ipcRenderer.invoke(channels.getLyrics, id),
  openMiniPlayer: () => ipcRenderer.invoke(channels.openMiniPlayer),
  publishMiniState: (state) => ipcRenderer.invoke(channels.publishMiniState, state),
  onShowFullPlayer: callback => subscribe(channels.showFullPlayerEvent, callback),
  exitMiniFullscreen: () => ipcRenderer.invoke(channels.exitMiniFullscreen),
  onMiniVisibility: (callback) => subscribe(channels.miniVisibility, callback),
  onPlaybackCommand: (callback) => subscribe(channels.playbackCommand, callback),
  getShortcuts: () => ipcRenderer.invoke(channels.getShortcuts),
  setShortcut: (action, accelerator) => ipcRenderer.invoke(channels.setShortcut, action, accelerator),
  setShortcutCapture: (capturing) => ipcRenderer.invoke(channels.setShortcutCapture, capturing),
}

const mini: MiniPlayerApi = {
  getState: () => ipcRenderer.invoke(channels.getMiniState),
  onState: (callback) => subscribe(channels.miniState, callback),
  onDiscoBeat: (callback) => subscribe(channels.discoBeat, callback),
  control: (command) => ipcRenderer.invoke(channels.controlMiniPlayback, command),
  setPinned: (pinned) => ipcRenderer.invoke(channels.setMiniPinned, pinned),
  showFull: () => ipcRenderer.invoke(channels.showFullPlayer),
  showMain: () => ipcRenderer.invoke(channels.showMainPlayer),
}

if (process.argv.includes('--mustplay-mini')) contextBridge.exposeInMainWorld('miniPlayer', mini)
else contextBridge.exposeInMainWorld('mustplay', api)
