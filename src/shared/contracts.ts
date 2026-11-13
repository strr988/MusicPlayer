export const channels = {
  getWaveQueue: 'recommendations:get-wave-queue',
  getWaveRecommendations: 'recommendations:get-wave-recommendations',
  getWaveMode: 'recommendations:get-mode',
  setWaveMode: 'recommendations:set-mode',
  getWavePulse: 'appearance:get-wave-pulse',
  setWavePulse: 'appearance:set-wave-pulse',
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
  rescanLibrary: 'library:rescan',
  getTracks: 'library:get-tracks',
  getPlayableSource: 'playback:get-source',
  getVolume: 'playback:get-volume',
  setVolume: 'playback:set-volume',
  getPlaybackSession: 'playback:get-session',
  setPlaybackSession: 'playback:set-session',
  getLyrics: 'lyrics:get',
  openMiniPlayer: 'mini:open',
  getMiniState: 'mini:get-state',
  publishMiniState: 'mini:publish-state',
  miniState: 'mini:state',
  miniVisibility: 'mini:visibility',
  setMiniPinned: 'mini:set-pinned',
  showMainPlayer: 'mini:show-main',
  controlMiniPlayback: 'mini:control',
  playbackCommand: 'playback:command',
  getShortcuts: 'shortcuts:get',
  setShortcut: 'shortcuts:set',
  setShortcutCapture: 'shortcuts:set-capture',
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
export const defaultWavePulse = 100
export const maxWavePulse = 300

export interface WaveScoreFactors {
  likedTrack: number
  likedArtist: number
  likedGenre: number
  unheard: number
  completions: number
  skips: number
}

export interface WaveDecision {
  trackId: string
  score: number
  factors: WaveScoreFactors
  remaining: number
  recentExcluded: number
  recentRelaxed: boolean
  sameArtistExcluded: number
  eligible: number
  selection: 'only-eligible' | 'highest-score' | 'seeded-tie' | 'exploration'
  prioritizedUnheard: boolean
  explorationRoll: number
  tiedForChoice: number
}

export interface WaveRecommendations {
  algorithmVersion: string
  mode: WaveMode
  calculatedAt: number
  reactionWindowMs: number
  recentLimit: number
  seed: number
  explorationChance: number
  decisions: WaveDecision[]
}

export const playlistNameLimit = 100
export interface Playlist {
  id: string
  name: string
  trackIds: string[]
}

export interface ImportIssue {
  entry: string
  reason: 'directory-unreadable' | 'file-unreadable' | 'format-mismatch'
}

export type ImportResult =
  | { status: 'cancelled' }
  | { status: 'failed' }
  | { status: 'complete'; tracks: LibraryTrack[]; processed: number; issues: ImportIssue[] }

export type RescanResult = Extract<ImportResult, { status: 'complete' | 'failed' }> | { status: 'no-folders' }

export interface PlayableSource {
  url: string
}

export interface VolumePreference {
  level: number
  muted: boolean
}

export interface LyricLine {
  seconds: number
  text: string
}

export type Lyrics =
  | { kind: 'timed'; lines: LyricLine[] }
  | { kind: 'plain'; text: string }

export const shortcutActions = ['toggle', 'next', 'previous', 'volumeUp', 'volumeDown', 'mute'] as const
export type ShortcutAction = typeof shortcutActions[number]
export interface ShortcutBinding {
  accelerator: string | null
  registered: boolean
}
export type ShortcutBindings = Record<ShortcutAction, ShortcutBinding>
export type ShortcutResult =
  | { status: 'saved'; binding: ShortcutBinding }
  | { status: 'invalid' | 'duplicate' | 'unavailable' }

export type PlaybackCommand =
  | { type: ShortcutAction }
  | { type: 'seek'; entryId: string; seconds: number }
  | { type: 'volume'; level: number }

export interface MiniPlayback {
  track: { title: string; artist: string | null; artworkUrl: string | null } | null
  entryId: string | null
  playing: boolean
  canPlay: boolean
  canGoBack: boolean
  canGoNext: boolean
  duration: number | null
  position: number
  seekable: boolean
  volume: VolumePreference | null
}

export interface MiniState {
  playback: MiniPlayback | null
  pinned: boolean
}

export interface MiniPlayerApi {
  getState(): Promise<MiniState>
  onState(callback: (state: MiniState) => void): () => void
  control(command: PlaybackCommand): Promise<void>
  setPinned(pinned: boolean): Promise<void>
  showMain(): Promise<void>
}

export const repeatModes = ['off', 'all', 'one'] as const
export type RepeatMode = typeof repeatModes[number]
export type QueueSource =
  | { type: 'library' | 'wave' }
  | { type: 'playlist'; id: string; name: string }

export interface QueueEntry {
  id: string
  trackId: string
  kind: 'source' | 'manual' | 'recommendation'
}

export interface PlaybackQueue {
  source: QueueSource
  // The canonical order survives Shuffle and defines the next Repeat All cycle.
  entries: QueueEntry[]
  current: string | null
  pending: string[]
  history: string[]
  shuffle: boolean
  repeat: RepeatMode
}

export interface PlaybackSession {
  queue: PlaybackQueue
  position: number
}

export const queueEntryLimit = 50_000

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
  getWaveRecommendations(): Promise<WaveRecommendations>
  getWaveMode(): Promise<WaveMode>
  setWaveMode(mode: WaveMode): Promise<void>
  getWavePulse(): Promise<number>
  setWavePulse(intensity: number): Promise<void>
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
  rescanLibrary(): Promise<RescanResult>
  getTracks(): Promise<LibraryTrack[]>
  getPlayableSource(trackId: string): Promise<PlayableSource | null>
  getVolume(): Promise<VolumePreference>
  setVolume(level: number, muted: boolean): Promise<void>
  getPlaybackSession(): Promise<PlaybackSession | null>
  setPlaybackSession(session: PlaybackSession): Promise<void>
  getLyrics(trackId: string): Promise<Lyrics | null>
  openMiniPlayer(): Promise<void>
  publishMiniState(state: MiniPlayback): Promise<void>
  onMiniVisibility(callback: (visible: boolean) => void): () => void
  onPlaybackCommand(callback: (command: PlaybackCommand) => void): () => void
  getShortcuts(): Promise<ShortcutBindings>
  setShortcut(action: ShortcutAction, accelerator: string | null): Promise<ShortcutResult>
  setShortcutCapture(capturing: boolean): Promise<void>
}
