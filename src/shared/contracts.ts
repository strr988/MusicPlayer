export const channels = {
  getWaveQueue: 'recommendations:get-wave-queue',
  getWaveRecommendations: 'recommendations:get-wave-recommendations',
  getWaveMode: 'recommendations:get-mode',
  setWaveMode: 'recommendations:set-mode',
  getWavePulse: 'appearance:get-wave-pulse',
  setWavePulse: 'appearance:set-wave-pulse',
  setTheme: 'appearance:set-theme',
  getCursorSettings: 'appearance:get-cursors',
  setCursorPreset: 'appearance:set-cursor',
  importCursorPreset: 'appearance:import-cursor',
  getInterfaceScale: 'appearance:get-interface-scale',
  setInterfaceScale: 'appearance:set-interface-scale',
  getSoundEffect: 'playback:get-sound-effect',
  setSoundEffect: 'playback:set-sound-effect',
  setReverb: 'playback:set-reverb',
  getDiscoMode: 'appearance:get-disco-mode',
  setDiscoMode: 'appearance:set-disco-mode',
  publishDiscoBeat: 'mini:publish-disco-beat',
  discoBeat: 'mini:disco-beat',
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
  getMusicFolders: 'library:music-folders',
  removeMusicFolder: 'library:remove-folder',
  rescanLibrary: 'library:rescan',
  getTracks: 'library:get-tracks',
  getPlayableSource: 'playback:get-source',
  getVolume: 'playback:get-volume',
  setVolume: 'playback:set-volume',
  getPlaybackSession: 'playback:get-session',
  setPlaybackSession: 'playback:set-session',
  getLyrics: 'lyrics:get',
  getLyricsMode: 'lyrics:get-mode',
  setLyricsMode: 'lyrics:set-mode',
  openMiniPlayer: 'mini:open',
  getMiniState: 'mini:get-state',
  publishMiniState: 'mini:publish-state',
  miniState: 'mini:state',
  miniVisibility: 'mini:visibility',
  setMiniPinned: 'mini:set-pinned',
  showMainPlayer: 'mini:show-main',
  showFullPlayer: 'mini:show-full',
  showFullPlayerEvent: 'mini:show-full-event',
  exitMiniFullscreen: 'mini:exit-full',
  controlMiniPlayback: 'mini:control',
  playbackCommand: 'playback:command',
  getShortcuts: 'shortcuts:get',
  setShortcut: 'shortcuts:set',
  setShortcutCapture: 'shortcuts:set-capture',
} as const

export const playerScheme = 'mustplay'
export const playerOrigin = `${playerScheme}://app`
export const builtInCursors = ['mustplay', 'contrast', 'system'] as const
export interface CursorPreset {
  id: string
  label: string
  arrow?: { x: number; y: number }
  pointer?: { x: number; y: number }
}
export interface CursorSettings { selected: CursorPreset; presets: CursorPreset[] }

export type LyricsMode = 'read' | 'sync'
export type Theme = 'dark' | 'light'
export const themeBackground = { dark: '#15131a', light: '#f8f6fc' } satisfies Record<Theme, string>
export const interfaceScales = [80, 90, 100, 110, 125, 150] as const
export type InterfaceScale = typeof interfaceScales[number]
export const defaultInterfaceScale = 100
export const soundEffects = ['original', 'speed-up', 'slowed'] as const
export type SoundEffect = typeof soundEffects[number]
export const soundEffectRates = { original: 1, 'speed-up': 1.25, slowed: 0.8 } satisfies Record<SoundEffect, number>
export interface SoundSettings {
  effect: SoundEffect
  reverb: Record<SoundEffect, boolean>
}
export const defaultSoundSettings: SoundSettings = {
  effect: 'original', reverb: { original: false, 'speed-up': false, slowed: false },
}

export function isSoundEffect(value: unknown): value is SoundEffect {
  return soundEffects.includes(value as SoundEffect)
}

export const audioFormats = ['mp3', 'flac', 'aac', 'm4a', 'wav', 'ogg', 'opus', 'webm'] as const
export type AudioFormat = typeof audioFormats[number]

export interface Track {
  id: string
  title: string
  artist: string | null
  album: string | null
  durationSeconds: number | null
  genres: string[]
  format: AudioFormat
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
  reason: 'directory-unreadable' | 'file-unreadable' | 'format-mismatch' | 'codec-unsupported'
}

export type ImportResult =
  | { status: 'cancelled' }
  | { status: 'failed' }
  | { status: 'complete'; tracks: LibraryTrack[]; processed: number; issues: ImportIssue[] }

export interface MusicFolder { id: string; label: string }

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
  | { type: 'sound-effect'; effect: SoundEffect }
  | { type: 'reverb'; effect: SoundEffect; enabled: boolean }

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
  sound: SoundSettings | null
  savingSound: boolean
  soundError: string
}

export interface MiniState {
  cursor: CursorPreset
  playback: MiniPlayback | null
  pinned: boolean
}

export interface MiniPlayerApi {
  getState(): Promise<MiniState>
  onState(callback: (state: MiniState) => void): () => void
  onDiscoBeat(callback: (strength: number) => void): () => void
  control(command: PlaybackCommand): Promise<void>
  setPinned(pinned: boolean): Promise<void>
  showMain(): Promise<void>
  showFull(): Promise<void>
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

export interface MustplayApi {
  getWaveQueue(): Promise<string[]>
  getWaveRecommendations(): Promise<WaveRecommendations>
  getWaveMode(): Promise<WaveMode>
  setWaveMode(mode: WaveMode): Promise<void>
  getWavePulse(): Promise<number>
  setWavePulse(intensity: number): Promise<void>
  setTheme(theme: Theme): Promise<void>
  getCursorSettings(): Promise<CursorSettings>
  setCursorPreset(id: string): Promise<CursorSettings>
  importCursorPreset(): Promise<CursorSettings | null>
  getInterfaceScale(): Promise<InterfaceScale>
  setInterfaceScale(scale: InterfaceScale): Promise<void>
  getSoundEffect(): Promise<SoundSettings>
  setSoundEffect(effect: SoundEffect): Promise<void>
  setReverb(effect: SoundEffect, enabled: boolean): Promise<void>
  getDiscoMode(): Promise<boolean>
  setDiscoMode(enabled: boolean): Promise<void>
  publishDiscoBeat(strength: number): Promise<void>
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
  getMusicFolders(): Promise<MusicFolder[]>
  removeMusicFolder(id: string): Promise<{ tracks: LibraryTrack[]; folders: MusicFolder[] }>
  rescanLibrary(): Promise<RescanResult>
  getTracks(): Promise<LibraryTrack[]>
  getPlayableSource(trackId: string): Promise<PlayableSource | null>
  getVolume(): Promise<VolumePreference>
  setVolume(level: number, muted: boolean): Promise<void>
  getPlaybackSession(): Promise<PlaybackSession | null>
  setPlaybackSession(session: PlaybackSession): Promise<void>
  getLyrics(trackId: string): Promise<Lyrics | null>
  getLyricsMode(): Promise<LyricsMode>
  setLyricsMode(mode: LyricsMode): Promise<void>
  openMiniPlayer(): Promise<void>
  publishMiniState(state: MiniPlayback): Promise<void>
  onShowFullPlayer(callback: (open: boolean) => void): () => void
  exitMiniFullscreen(): Promise<void>
  onMiniVisibility(callback: (visible: boolean) => void): () => void
  onPlaybackCommand(callback: (command: PlaybackCommand) => void): () => void
  getShortcuts(): Promise<ShortcutBindings>
  setShortcut(action: ShortcutAction, accelerator: string | null): Promise<ShortcutResult>
  setShortcutCapture(capturing: boolean): Promise<void>
}
