export const downloadChannels = {
  list: 'downloads:list',
  analyze: 'downloads:analyze',
  confirm: 'downloads:confirm',
  cancel: 'downloads:cancel',
  addToLibrary: 'downloads:add-to-library',
  reveal: 'downloads:reveal',
  chooseCover: 'downloads:choose-cover',
  dismiss: 'downloads:dismiss',
} as const

export type AudioFormat = 'mp3' | 'flac'
export type DownloadStatus = 'waiting' | 'analyzing' | 'ready' | 'downloading' | 'processing' |
  'completed' | 'cancelled' | 'failed'

export interface SourceMetadata {
  provider: 'archive.org'
  sourceId: string
  originalUrl: string
  title: string | null
  artist: string | null
  album: string | null
  durationSeconds: number | null
  artworkUrl: string | null
  audioFormats: string[]
  licenseUrl: string | null
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
  coverUrl?: string
  duplicate?: boolean
}

export interface DownloadsApi {
  list(): Promise<DownloadJob[]>
  analyze(url: string): Promise<void>
  confirm(id: string, edits: MetadataEdits): Promise<void>
  cancel(id: string): Promise<void>
  addToLibrary(id: string): Promise<void>
  reveal(id: string): Promise<void>
  chooseCover(id: string): Promise<string | null>
  dismiss(id: string): Promise<void>
}
