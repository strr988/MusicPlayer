import { audioFormats } from '../shared/contracts'
import type { AudioFormat } from '../shared/contracts'
import type { IFormat } from 'music-metadata'

export const audioMime: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
}

export function audioFormatForPath(extension: string): AudioFormat | undefined {
  if (extension === '.mp4') return 'm4a'
  if (extension === '.oga') return 'ogg'
  if (extension === '.wave') return 'wav'
  return audioFormats.find(format => extension === '.' + format)
}

export function matchesAudioFormat(format: AudioFormat, container: string, metadata: IFormat): boolean {
  const codec = metadata.codec ?? ''
  switch (format) {
    case 'mp3': return container === 'mpeg' && codec.endsWith('Layer 3')
    case 'flac': return container === 'flac'
    case 'aac': return /^adts\/mpeg-[24]$/.test(container) && codec === 'AAC'
    case 'm4a': {
      if (!/^(?:m4a|isom|iso[2-9]|mp4[12]|qt|dash|m4b|f4a)(?:\/|$)/.test(container)) return false
      // A FLAC sample entry is reported per track, without a top-level codec name.
      return /(?:^|\/)AAC$/.test(codec) ||
        metadata.trackInfo.some(track => track.audio && track.codecId === 'fLaC' && track.flagEnabled !== false)
    }
    case 'wav': return container === 'wave' && /^(PCM|IEEE_FLOAT)$/.test(codec)
    case 'ogg': return container === 'ogg' && /^(Vorbis|Opus)/i.test(codec)
    case 'opus': return container === 'ogg' && /^Opus/i.test(codec)
    case 'webm': return container === 'ebml/webm' && /^(Vorbis|Opus)$/i.test(codec)
  }
}
