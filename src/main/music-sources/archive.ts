import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DownloadJob } from '../../shared/music-sources'
import { artworkMime, maxImageBytes } from '../artwork'
import { archiveResponse, readBounded, validateArchiveEndpoint, withSourceProxy } from './network'
import { prepareYtDlp } from './yt-dlp'
import type { LoadYtDlp } from './yt-dlp'
import { label, maxAudioBytes, object, parseJson } from './provider'
import type { Analysis, MusicSourceProvider, OriginalFile, SourceLink } from './provider'

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/

interface ArchiveLink extends SourceLink {
  item: string
  file: string | null
}

function safeName(value: string): boolean {
  return value.length > 0 && value.length <= 240 && value.split('/').every(part =>
    !!part && part !== '.' && part !== '..' && !/[\\%<>:"|?*#\u0000-\u001f\u007f]/u.test(part))
}

function encodeFile(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/')
}

export function archiveLink(value: unknown): ArchiveLink {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Введите ссылку HTTPS на запись Archive.org.')
  const match = /^https:\/\/(?:www\.)?archive\.org\/details\/([^/?#]+)(?:\/([^?#]+))?\/?$/i.exec(value.trim())
  if (!match || !identifierPattern.test(match[1])) throw new Error('Поддерживаются ссылки на записи archive.org/details/.')
  let file: string | null = null
  if (match[2]) {
    try { file = decodeURIComponent(match[2].replace(/\/$/, '')) } catch { throw new Error('Некорректное имя записи.') }
    if (!safeName(file)) throw new Error('Некорректное имя записи.')
  }
  return { item: match[1], file, url: `https://archive.org/details/${match[1]}${file ? '/' + encodeFile(file) : ''}` }
}

function openLicense(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^https?:\/\/creativecommons\.org\/(publicdomain\/zero\/1\.0|licenses\/(?:by|by-sa)\/(?:1\.0|2\.0|2\.5|3\.0|4\.0))\/?$/.exec(value)
  return match ? `https://creativecommons.org/${match[1]}/` : null
}

function archiveDocument(raw: string, item: string) {
  const data = parseJson(raw)
  const metadata = object(data.metadata)
  if (metadata.identifier !== item || metadata.mediatype !== 'audio' || !Array.isArray(data.files)) {
    throw new Error('В Archive.org не найдена поддерживаемая аудиозапись.')
  }
  const restricted = data.is_dark || metadata['access-restricted-item'] || metadata['no-download'] || metadata['loans__status__status']
  return { licenseUrl: restricted ? null : openLicense(metadata.licenseurl), files: data.files.map(object) }
}

function originalFile(document: ReturnType<typeof archiveDocument>, name: string): OriginalFile | null {
  if (!document.licenseUrl) return null
  const file = document.files.find(candidate => candidate.name === name)
  if (!file || file.source !== 'original' || file.private || file['no-download']) return null
  if (file.licenseurl !== undefined && openLicense(file.licenseurl) !== document.licenseUrl) return null
  const format = name.toLowerCase().split('.').pop()
  const size = typeof file.size === 'string' && /^\d+$/.test(file.size) ? Number(file.size) : file.size
  if ((format !== 'mp3' && format !== 'flac') || typeof size !== 'number' ||
      !Number.isSafeInteger(size) || size <= 0 || size > maxAudioBytes ||
      typeof file.sha1 !== 'string' || !/^[a-f0-9]{40}$/.test(file.sha1)) return null
  if (format === 'mp3' ? !/^(?:VBR )?MP3$/.test(String(file.format)) : file.format !== 'Flac') return null
  return { format, name, size, sha1: file.sha1 }
}

export function normalizeArchive(link: ArchiveLink, json: string, archiveJson: string): Omit<Analysis, 'cover'> {
  const info = parseJson(json)
  if (Array.isArray(info.entries) || info._type === 'playlist' || info._type === 'multi_video') {
    throw new Error('Ссылка содержит несколько записей. Укажите ссылку на один файл в Archive.org.')
  }
  const name = info.display_id
  if (info.extractor !== 'archive.org' || typeof name !== 'string' || !safeName(name) ||
      (link.file && name !== link.file) || (info.id !== link.item && info.id !== `${link.item}/${name}`)) {
    throw new Error('yt-dlp вернул сведения о другой записи.')
  }
  const document = archiveDocument(archiveJson, link.item)
  const original = originalFile(document, name)
  const formats = Array.isArray(info.formats) ? info.formats.map(object) : []
  const audioFormats = [...new Set(formats.filter(format => format.has_drm !== true)
    .map(format => format.ext).filter((ext): ext is string => typeof ext === 'string' &&
      /^(?:mp3|flac|m4a|aac|opus|ogg|oga|wav|aiff|alac|weba|mka|shn)$/.test(ext)))].slice(0, 16)
  const creator = Array.isArray(info.creators) ? info.creators.map(label).filter(Boolean).slice(0, 8).join(', ') : info.creators
  const matchesOriginal = original && formats.some(format => {
    if (typeof format.url !== 'string' || format.ext !== original.format || format.has_drm) return false
    try {
      validateOriginalUrl(new URL(format.url), link.item, name)
      return true
    } catch { return false }
  })
  const allowed = matchesOriginal ? original : null
  const duration = info.duration
  return {
    original: allowed,
    metadata: {
      provider: 'archive.org', sourceId: `${link.item}/${name}`,
      originalUrl: `https://archive.org/details/${link.item}/${encodeFile(name)}`,
      title: label(info.track) ?? (info.title === name ? null : label(info.title)),
      artist: label(info.artist) ?? label(creator), album: label(info.album),
      durationSeconds: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
      artworkUrl: null, audioFormats, licenseUrl: document.licenseUrl,
      downloadFormat: allowed?.format ?? null,
      restriction: allowed ? null : document.licenseUrl ?
        'Нет доступного оригинала MP3 или FLAC размером до 150 МиБ.' :
        'Загрузка доступна для публичных записей с лицензией CC0, CC BY или CC BY-SA.',
    },
  }
}

function validateOriginalUrl(url: URL, item: string, name: string) {
  const pathAllowed = filePathAllowed(item, name)
  validateArchiveEndpoint(url, target => target.hostname === 'archive.org' && pathAllowed(target))
}

function filePathAllowed(item: string, name: string) {
  const suffix = `/${item}/${name}`
  return (url: URL) => {
    let pathname: string
    try { pathname = decodeURIComponent(url.pathname) } catch { return false }
    return url.hostname === 'archive.org' ? pathname === '/download' + suffix :
      pathname.endsWith(suffix) && /^\/\d+\/items\//.test(pathname) && /^\/\d+\/items$/.test(pathname.slice(0, -suffix.length))
  }
}

async function metadataResponse(link: ArchiveLink, signal: AbortSignal): Promise<string> {
  const path = `/metadata/${link.item}`
  return (await readBounded(await archiveResponse(new URL(path, 'https://archive.org'),
    url => url.hostname === 'archive.org' && url.pathname === path, signal), 2 * 1024 * 1024)).toString('utf8')
}

async function coverImage(link: ArchiveLink, signal: AbortSignal): Promise<Buffer | null> {
  const name = '__ia_thumb.jpg'
  const url = new URL(`/download/${link.item}/${name}`, 'https://archive.org')
  const image = await readBounded(await archiveResponse(url, filePathAllowed(link.item, name), signal), maxImageBytes)
  return artworkMime(image) ? image : null
}

export class YtDlpProvider implements MusicSourceProvider {
  readonly id = 'archive.org' as const
  readonly hosts = ['archive.org', 'www.archive.org']

  constructor(private readonly load: LoadYtDlp) {}

  recognize = archiveLink

  matchesRecording(sourceId: string, { url }: SourceLink): boolean {
    const { item, file } = archiveLink(url)
    return file !== null && sourceId === `${item}/${file}`
  }

  async analyze(input: SourceLink, directory: string, signal: AbortSignal): Promise<Analysis> {
    const link = archiveLink(input.url)
    const analyze = await prepareYtDlp(this.load, directory, signal)
    const { stdout } = await withSourceProxy(['archive.org'], proxy => analyze(link.url, proxy, 'archive.org'))
    const result = normalizeArchive(link, stdout, await metadataResponse(link, signal))
    const cover = await coverImage(link, signal).catch(() => null)
    signal.throwIfAborted()
    if (cover) result.metadata.artworkUrl = `https://archive.org/download/${link.item}/__ia_thumb.jpg`
    return { ...result, cover }
  }

  async download(input: SourceLink, analysis: Analysis, path: string, signal: AbortSignal,
    progress: (value: NonNullable<DownloadJob['progress']>) => void): Promise<void> {
    const link = archiveLink(input.url)
    const expected = analysis.original
    if (!expected) throw new Error('Загрузка этой записи недоступна.')
    const document = archiveDocument(await metadataResponse(link, signal), link.item)
    const current = originalFile(document, expected.name)
    if (!current || current.sha1 !== expected.sha1 || current.size !== expected.size ||
        document.licenseUrl !== analysis.metadata.licenseUrl) throw new Error('Запись или лицензия изменилась. Повторите анализ.')
    const url = new URL(`/download/${link.item}/${encodeFile(expected.name)}`, 'https://archive.org')
    const response = await archiveResponse(url, filePathAllowed(link.item, expected.name), signal)
    const length = response.headers['content-length']
    if (length !== undefined && Number(length) !== expected.size) {
      response.destroy()
      throw new Error('Размер файла отличается от метаданных источника.')
    }
    const hash = createHash('sha1')
    let bytes = 0
    const total = length === undefined ? null : expected.size
    progress({ bytes, total })
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > expected.size) return callback(new Error('Размер загрузки превысил допустимый.'))
        hash.update(chunk)
        progress({ bytes, total })
        callback(null, chunk)
      },
    })
    await pipeline(response, limit, createWriteStream(path, { flags: 'wx', flush: true }), { signal })
    if (bytes !== expected.size || hash.digest('hex') !== expected.sha1) throw new Error('Скачанный файл не прошёл проверку целостности.')
  }
}
