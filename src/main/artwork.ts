import { audioMime } from './audio-formats'
import { parseStream } from 'music-metadata'
import type { FileHandle } from 'node:fs/promises'
import type { Library } from './library'
import type { LocalSource } from './library-store'
import { sameFile } from './local-file'

const probeBytes = 8 * 1024 * 1024
const maxImageBytes = 2 * 1024 * 1024
const maxCacheBytes = 16 * 1024 * 1024
const maxCacheEntries = 256
const maxSide = 2048
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const jpegFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

interface Image {
  bytes: Uint8Array<ArrayBuffer>
  mime: 'image/png' | 'image/jpeg'
}

function supportedSize(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= maxSide && height <= maxSide
}

function isStaticPng(bytes: Buffer): boolean {
  if (bytes.length < 45 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      !supportedSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20))) return false
  let hasPixels = false
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    offset += 12 + length
    if (offset > bytes.length || type === 'acTL') return false
    if (type === 'IDAT') hasPixels = true
    if (type === 'IEND') return hasPixels && length === 0 && offset === bytes.length
  }
  return false
}

function isSizedJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return false
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return false
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return false
    if (jpegFrameMarkers.has(marker)) {
      return length >= 8 && supportedSize(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
    }
    offset += length
  }
  return false
}

function artworkMime(data: Uint8Array): Image['mime'] | null {
  if (data.length > maxImageBytes) return null
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.subarray(0, 8).equals(pngSignature) && isStaticPng(bytes)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && isSizedJpeg(bytes)) return 'image/jpeg'
  return null
}

export class Artwork {
  private readonly cache = new Map<string, Image | null>()
  private cacheBytes = 0
  private pending = Promise.resolve()

  constructor(private readonly library: Library) {}

  async serve(request: Request, id: string): Promise<Response> {
    // Queue reads before allocating parser buffers. A queued duplicate uses the first result.
    const read = this.pending.then(() => request.signal.aborted ? null : this.read(id))
    this.pending = read.then(() => undefined, () => undefined)
    const image = await read.catch(() => null)
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    if (!image) return new Response(null, { status: 404, headers })
    return new Response(request.method === 'HEAD' ? null : image.bytes, {
      headers: { ...headers, 'Content-Type': image.mime, 'Content-Length': String(image.bytes.length) },
    })
  }

  private async read(id: string): Promise<Image | null> {
    const opened = await this.library.openAvailableSource(id)
    const cached = this.cache.get(id)
    if (cached !== undefined) {
      this.cache.delete(id)
      this.cacheBytes -= cached?.bytes.length ?? 0
    }
    if (!opened) return null

    const { file, source } = opened
    try {
      const image = cached === undefined ? await this.extract(file, source) : cached
      this.cache.set(id, image)
      this.cacheBytes += image?.bytes.length ?? 0
      while (this.cacheBytes > maxCacheBytes || this.cache.size > maxCacheEntries) {
        const oldest = this.cache.keys().next().value!
        this.cacheBytes -= this.cache.get(oldest)?.bytes.length ?? 0
        this.cache.delete(oldest)
      }
      return image
    } finally {
      await file.close()
    }
  }

  private async extract(file: FileHandle, source: LocalSource): Promise<Image | null> {
    const size = Math.min(probeBytes, Number(source.identity.size))
    if (size <= 0) return null
    const stream = file.createReadStream({ start: 0, end: size - 1, autoClose: false })
    try {
      const mimeType = audioMime[source.format]
      const { common } = await parseStream(stream, { mimeType, size }, {
        maxMemoryAllocation: probeBytes,
        maxMetadataEntries: 1_000,
      })
      const pictures = common.picture ?? []
      const front = pictures.find(picture => ['front', 'cover', 'cover (front)'].includes(picture.type?.toLowerCase() ?? ''))
      for (const picture of front ? [front, ...pictures.filter(candidate => candidate !== front)] : pictures) {
        const mime = artworkMime(picture.data)
        // Copy the selected image so a slice cannot keep the entire metadata buffer alive.
        if (mime && sameFile(source.identity, await file.stat({ bigint: true }))) {
          return { mime, bytes: new Uint8Array(picture.data) }
        }
      }
    } catch {
      // A malformed or oversized tag affects only artwork.
    } finally {
      stream.destroy()
    }
    return null
  }
}
