import { artworkMime, maxImageBytes } from '../artwork'
import { guardedResponse, readBounded, validateHttpsEndpoint, withSourceProxy } from './network'
import { label, object, parseJson } from './provider'
import type { Analysis, MusicSourceProvider, SourceLink } from './provider'
import { verifiedYtDlp } from './yt-dlp'

const trackHosts = ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']
const imageHosts = ['i1.sndcdn.com', 'a1.sndcdn.com']
const analysisHosts = ['soundcloud.com', 'api-v2.soundcloud.com', 'a-v2.sndcdn.com', ...imageHosts]
const tracking = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'si'])
const profileSections = new Set(['tracks', 'albums', 'sets', 'reposts', 'likes', 'spotlight', 'comments'])
const trackId = /^[1-9][0-9]{0,23}$/

export function soundCloudLink(value: unknown): SourceLink {
  const match = typeof value === 'string' && value.length <= 2048 &&
    /^https:\/\/(?:www\.|m\.)?soundcloud\.com\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/?(\?[^#]*)?$/i.exec(value.trim())
  if (!match || profileSections.has(match[2].toLowerCase()) ||
      [...new URLSearchParams(match[3]).keys()].some(key => !tracking.has(key))) {
    throw new Error('Укажите публичную HTTPS-ссылку на отдельный трек SoundCloud.')
  }
  return { url: `https://soundcloud.com/${match[1]}/${match[2]}` }
}

export function validateSoundCloudArtwork(url: URL): void {
  validateHttpsEndpoint(url, target => imageHosts.includes(target.hostname) &&
    /^\/[a-z0-9_-]{1,240}\.(?:jpg|jpeg|png)$/i.test(target.pathname))
}

function artworkUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const url = URL.parse(value)
  if (!url) return null
  try { validateSoundCloudArtwork(url) } catch { return null }
  return url.href
}

function describeStream(format: Record<string, unknown>): string | null {
  const id = format.format_id
  if (typeof id !== 'string' || id === 'download' || /(?:^|_)preview(?:_|$)/i.test(id) ||
      format.has_drm || format.format_note === 'Premium' || format.vcodec !== 'none') return null
  const protocol = format.protocol
  const transport = protocol === 'm3u8_native' || protocol === 'm3u8' ? 'HLS' :
    protocol === 'https' || protocol === 'http' ? 'HTTP' : null
  const codec = typeof format.acodec === 'string' && format.acodec.startsWith('mp4a.') ? 'AAC' :
    format.ext === 'opus' ? 'Opus' : format.ext === 'mp3' ? 'MP3' : null
  if (!codec || !transport) return null
  const rate = format.abr
  const bitrate = typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate <= 1024 ?
    `, ${Math.round(rate)} кбит/с` : ''
  return `${codec} (${transport}${bitrate})`
}

export function normalizeSoundCloud(stdout: string, stderr: string): Omit<Analysis, 'cover'> {
  const info = parseJson(stdout)
  if (info.extractor !== 'soundcloud' || Array.isArray(info.entries) ||
      typeof info.id !== 'string' || !trackId.test(info.id)) {
    throw new Error('yt-dlp не вернул сведения об отдельном треке SoundCloud.')
  }
  const { url } = soundCloudLink(info.webpage_url)
  const formats = Array.isArray(info.formats) ? info.formats.map(object) : []
  const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails.map(object) : []
  const thumbnail = thumbnails.find(image => image.id === 't500x500')
  const artists = Array.isArray(info.artists) ? info.artists.map(label).filter(Boolean).slice(0, 8).join(', ') : null
  const duration = info.duration
  const license = label(info.license)
  const knownLicense = license === 'all-rights-reserved' ? 'Все права защищены' :
    license && /^cc-(?:by(?:-nc)?(?:-sa|-nd)?|zero)$/.test(license) ? license.toUpperCase().replace(/-/g, ' ') : null
  const signInRequired = /Original download format is only available for registered users/i.test(stderr)
  const originalAdvertised = formats.some(format => format.format_id === 'download' && format.format_note === 'Original')
  return {
    original: null,
    metadata: {
      provider: 'soundcloud', sourceId: info.id, originalUrl: url,
      title: label(info.track) ?? label(info.title), artist: label(info.artist) ?? label(artists),
      publisher: label(info.uploader), album: label(info.album),
      durationSeconds: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
      artworkUrl: artworkUrl(thumbnail?.url) ?? artworkUrl(info.thumbnail),
      audioFormats: [...new Set(formats.map(describeStream).filter((format): format is string => format !== null))].slice(0, 16),
      licenseUrl: null, licenseName: knownLicense, downloadFormat: null,
      restriction: signInRequired || originalAdvertised ?
        'Для скачивания оригинала откройте трек на SoundCloud и войдите в аккаунт.' :
        'SoundCloud позволяет скачать оригинал после входа, если автор включил загрузку.',
    },
  }
}

export class SoundCloudProvider implements MusicSourceProvider {
  readonly id = 'soundcloud' as const
  readonly hosts = trackHosts

  constructor(private readonly binary: string) {}

  recognize = soundCloudLink

  matchesRecording(sourceId: string): boolean {
    return trackId.test(sourceId)
  }

  async analyze({ url }: SourceLink, directory: string, signal: AbortSignal): Promise<Analysis> {
    const analyze = await verifiedYtDlp(this.binary, directory, signal)
    const { stdout, stderr } = await withSourceProxy(analysisHosts, proxy => analyze(url, proxy, 'soundcloud'))
    const result = normalizeSoundCloud(stdout, stderr)
    const image = result.metadata.artworkUrl
    let cover: Buffer | null = null
    if (image) {
      const artworkSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)])
      const bytes = await guardedResponse(new URL(image), validateSoundCloudArtwork, artworkSignal)
        .then(response => readBounded(response, maxImageBytes)).catch(() => null)
      if (bytes && artworkMime(bytes)) cover = bytes
    }
    signal.throwIfAborted()
    return { ...result, cover }
  }
}
