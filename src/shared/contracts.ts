export const channels = {
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

export interface MusicPlayerApi {
  importFolder(): Promise<ImportResult>
  getTracks(): Promise<Track[]>
  getPlayableSource(trackId: string): Promise<PlayableSource | null>
}
