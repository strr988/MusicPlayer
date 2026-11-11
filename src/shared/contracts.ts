export const channels = {
  getWaveQueue: 'recommendations:get-wave-queue',
  getWaveMode: 'recommendations:get-mode',
  setWaveMode: 'recommendations:set-mode',
  getPlaylists: 'playlists:get',
  createPlaylist: 'playlists:create',
  renamePlaylist: 'playlists:rename',
  deletePlaylist: 'playlists:delete',
  addPlaylistTrack: 'playlists:add-track',
  removePlaylistTrack: 'playlists:remove-track',
  movePlaylistTrack: 'playlists:move-track',
  getListeningData: 'feedback:get-data',
  setTrackPreference: 'feedback:set-preference',
  recordPlaybackEvent: 'feedback:record-event',
  importFolder: 'library:import-folder',
  getTracks: 'library:get-tracks',
  getPlayableSource: 'playback:get-source',
  getVolume: 'playback:get-volume',
  setVolume: 'playback:set-volume',
} as const

export const playerOrigin = 'music-player://app'

export interface Track {
  id: string
  title: string
  artist: string | null
  album: string | null
  durationSeconds: number | null
  genres: string[]
  format: 'mp3' | 'flac'
}

export interface LibraryTrack extends Track {
  artworkUrl: string | null
  available: boolean
}

export const waveModes = ['familiar', 'balance', 'discovery'] as const
export type WaveMode = typeof waveModes[number]

export const playlistNameLimit = 100
export interface Playlist {
  id: string
  name: string
  trackIds: string[]
}

export interface ImportIssue {
  entry: string
  reason: 'directory-unreadable' | 'file-unreadable'
}

export type ImportResult =
  | { status: 'cancelled' }
  | { status: 'failed' }
  | { status: 'complete'; tracks: LibraryTrack[]; processed: number; issues: ImportIssue[] }

export interface PlayableSource {
  url: string
}

export interface VolumePreference {
  level: number
  muted: boolean
}

export interface TrackPreference {
  trackId: string
  liked: boolean
  updatedAt: string
}
export type PlaybackEventType = 'started' | 'completed' | 'skipped' | 'ended' | 'error'
export interface PlaybackEventInput {
  sessionId: string
  trackId: string
  type: PlaybackEventType
  listenedSeconds: number
}
export interface PlaybackEvent extends PlaybackEventInput { timestamp: string }
export interface ListeningData { preferences: TrackPreference[]; events: PlaybackEvent[] }
export interface ListeningDataReader { getListeningData(): ListeningData }

export interface MusicPlayerApi {
  getWaveQueue(): Promise<string[]>
  getWaveMode(): Promise<WaveMode>
  setWaveMode(mode: WaveMode): Promise<void>
  getPlaylists(): Promise<Playlist[]>
  createPlaylist(name: string): Promise<Playlist>
  renamePlaylist(id: string, name: string): Promise<void>
  deletePlaylist(id: string): Promise<void>
  addPlaylistTrack(id: string, trackId: string): Promise<Playlist>
  removePlaylistTrack(id: string, trackId: string): Promise<Playlist>
  movePlaylistTrack(id: string, trackId: string, offset: -1 | 1): Promise<Playlist>
  getListeningData(): Promise<ListeningData>
  setTrackPreference(trackId: string, liked: boolean): Promise<TrackPreference>
  recordPlaybackEvent(event: PlaybackEventInput): Promise<void>
  importFolder(): Promise<ImportResult>
  getTracks(): Promise<LibraryTrack[]>
  getPlayableSource(trackId: string): Promise<PlayableSource | null>
  getVolume(): Promise<VolumePreference>
  setVolume(level: number, muted: boolean): Promise<void>
}
