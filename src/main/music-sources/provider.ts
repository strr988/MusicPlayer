import type { AudioFormat, DownloadJob, SourceMetadata } from '../../shared/music-sources'

export const maxAudioBytes = 150 * 1024 * 1024

export interface SourceLink {
  url: string
}

export interface OriginalFile {
  format: AudioFormat
  name: string
  size: number
  sha1: string
}

export interface Analysis {
  metadata: SourceMetadata
  original: OriginalFile | null
  cover: Buffer | null
}

export interface MusicSourceProvider {
  readonly id: SourceMetadata['provider']
  readonly hosts: readonly string[]
  recognize(value: unknown): SourceLink
  matchesRecording(sourceId: string, link: SourceLink): boolean
  analyze(link: SourceLink, directory: string, signal: AbortSignal): Promise<Analysis>
  download?(link: SourceLink, analysis: Analysis, path: string, signal: AbortSignal,
    progress: (value: NonNullable<DownloadJob['progress']>) => void): Promise<void>
}

export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ?
    value as Record<string, unknown> : {}
}

export function parseJson(value: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('Источник вернул некорректный JSON.') }
  const result = object(parsed)
  if (!Object.keys(result).length) throw new Error('Источник не вернул метаданные записи.')
  return result
}

export function label(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 240) || null
}
