import { lstat, open, realpath } from 'node:fs/promises'
import { extname } from 'node:path'
import { LyricsContentType, parseStream, TimestampFormat } from 'music-metadata'
import type { FileHandle } from 'node:fs/promises'
import type { Lyrics } from '../shared/contracts'
import type { Library } from './library'
import type { LocalSource } from './library-store'
import { sameFile } from './local-file'
import { cleanText, lyricLineLimit, lyricSizeLimit, parseLrc, plainLyrics, timedLyrics } from './lyric-text'

const probeLimit = 8 * 1024 * 1024

async function readSidecar(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path, { bigint: true })
    if (!stat.isFile() || stat.size > lyricSizeLimit) return null
    const canonical = await realpath(path)
    if (canonical !== path && (process.platform !== 'win32' || canonical.toLowerCase() !== path.toLowerCase())) return null
    await using file = await open(path, 'r')
    if (!sameFile(stat, await file.stat({ bigint: true }))) return null
    const data = Buffer.alloc(Number(stat.size))
    const { bytesRead } = await file.read(data, 0, data.length, 0)
    if (bytesRead !== data.length || !sameFile(stat, await file.stat({ bigint: true }))) return null
    const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
      : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8'
    return new TextDecoder(encoding, { fatal: true }).decode(data)
  } catch {
    return null
  }
}

async function readEmbedded(file: FileHandle, source: LocalSource): Promise<Lyrics | null> {
  const size = Math.min(probeLimit, Number(source.identity.size))
  if (size <= 0) return null
  const stream = file.createReadStream({ start: 0, end: size - 1, autoClose: false })
  try {
    const mimeType = source.format === 'mp3' ? 'audio/mpeg' : 'audio/flac'
    const { common, native } = await parseStream(stream, { mimeType, size }, {
      skipCovers: true, maxMemoryAllocation: probeLimit, maxMetadataEntries: 10_000,
    })
    if (!sameFile(source.identity, await file.stat({ bigint: true }))) return null
    // Preserve the original Vorbis text, since the tag parser normalizes simple LRC.
    let plain: Lyrics | null = null
    for (const { id, value } of native.vorbis ?? []) {
      if (!/^(?:UNSYNCED)?LYRICS$/i.test(id) || typeof value !== 'string') continue
      const result = parseLrc(value)
      if (result?.kind === 'timed') return result
      plain ??= result
    }

    for (const tag of common.lyrics ?? []) {
      if (tag.contentType !== LyricsContentType.lyrics) continue
      if (tag.syncText.length > lyricLineLimit ||
          tag.syncText.reduce((size, line) => size + line.text.length + 1, 0) > lyricSizeLimit) continue
      if (tag.timeStampFormat === TimestampFormat.milliseconds) {
        const lines = tag.syncText.flatMap(({ timestamp, text }) =>
          timestamp !== undefined && Number.isFinite(timestamp) && timestamp >= 0
            ? [{ seconds: timestamp / 1000, text: cleanText(text) ?? '' }] : [])
        const result = timedLyrics(lines)
        if (result) return result
      }
      // A frame-based ID3 tag has no reliable millisecond position here.
      const result = tag.text ? parseLrc(tag.text) : plainLyrics(tag.syncText.map(line => line.text).join('\n'))
      if (result?.kind === 'timed') return result
      plain ??= result
    }
    return plain
  } catch {
    return null
  } finally {
    stream.destroy()
  }
}

export async function readTrackLyrics(library: Library, trackId: string): Promise<Lyrics | null> {
  const sourceId = library.getSourceId(trackId)
  const opened = sourceId && await library.openAvailableSource(sourceId)
  if (!opened) return null
  const { source, file } = opened
  try {
    const stem = source.path.slice(0, -extname(source.path).length)
    const lrc = await readSidecar(stem + '.lrc')
    const lyrics = lrc && parseLrc(lrc)
    if (lyrics) return lyrics
    const txt = await readSidecar(stem + '.txt')
    return (txt && plainLyrics(txt)) || await readEmbedded(file, source)
  } finally {
    await file.close()
  }
}
