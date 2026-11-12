export const downloadChannels = {
  list: 'downloads:list',
  analyze: 'downloads:analyze',
  confirm: 'downloads:confirm',
  cancel: 'downloads:cancel',
  addToLibrary: 'downloads:add-to-library',
  reveal: 'downloads:reveal',
  chooseCover: 'downloads:choose-cover',
  dismiss: 'downloads:dismiss',
  openSoundCloud: 'downloads:open-soundcloud',
  importSoundCloudOriginal: 'downloads:import-soundcloud-original',
} as const

export type AudioFormat = 'mp3' | 'flac'
export const sourceNames = { 'archive.org': 'Archive.org', soundcloud: 'SoundCloud' } as const
export type DownloadStatus = 'waiting' | 'analyzing' | 'ready' | 'downloading' | 'processing' |
  'completed' | 'cancelled' | 'failed'

export interface SourceMetadata {
  provider: keyof typeof sourceNames
  sourceId: string
  originalUrl: string
  title: string | null
  artist: string | null
  publisher?: string | null
  album: string | null
  durationSeconds: number | null
  artworkUrl: string | null
  audioFormats: string[]
  licenseUrl: string | null
  licenseName?: string | null
  downloadFormat: AudioFormat | null
  restriction: string | null
}

export interface MetadataEdits {
  title?: string | null
  artist?: string | null
  album?: string | null
  durationSeconds?: number | null
  artwork?: 'remove' | 'custom'
}

export interface DownloadJob {
  id: string
  url: string
  status: DownloadStatus
  metadata?: SourceMetadata
  edits?: MetadataEdits
  progress?: { bytes: number; total: number | null }
  error?: string
  trackId?: string
  importing?: boolean
  canDismiss?: boolean
  coverUrl?: string
  duplicate?: boolean
}

export interface DownloadsApi {
  list(): Promise<DownloadJob[]>
  analyze(url: string): Promise<void>
  confirm(id: string, edits: MetadataEdits): Promise<void>
  cancel(id: string): Promise<void>
  addToLibrary(id: string): Promise<boolean>
  reveal(id: string): Promise<void>
  chooseCover(id: string): Promise<string | null>
  dismiss(id: string): Promise<void>
  openSoundCloud(id: string): Promise<void>
  importSoundCloudOriginal(id: string, edits: MetadataEdits): Promise<boolean>
}
