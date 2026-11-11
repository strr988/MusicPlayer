export const channels = {
  getListeningData: 'feedback:get-data',
  setTrackPreference: 'feedback:set-preference',
  recordPlaybackEvent: 'feedback:record-event',
  importFolder: 'library:import-folder',
  getTracks: 'library:get-tracks',
  getPlayableSource: 'playback:get-source',
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

export interface ImportIssue {
  entry: string
  reason: 'directory-unreadable' | 'file-unreadable'
}

export type ImportResult =
  | { status: 'cancelled' }
  | { status: 'failed' }
  | { status: 'complete'; tracks: Track[]; processed: number; issues: ImportIssue[] }

export interface PlayableSource {
  url: string
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
  getListeningData(): Promise<ListeningData>
  setTrackPreference(trackId: string, liked: boolean): Promise<TrackPreference>
  recordPlaybackEvent(event: PlaybackEventInput): Promise<void>
  importFolder(): Promise<ImportResult>
  getTracks(): Promise<Track[]>
  getPlayableSource(trackId: string): Promise<PlayableSource | null>
}
