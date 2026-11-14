import { audioMime } from './audio-formats'
import { Readable } from 'node:stream'
import type { Library } from './library'

export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || size <= 0) return null

  const [, first, last] = match
  if (!first) {
    const length = Number(last)
    return length > 0 ? { start: Math.max(0, size - length), end: size - 1 } : null
  }

  const start = Number(first)
  const end = last ? Math.min(Number(last), size - 1) : size - 1
  return start < size && start <= end ? { start, end } : null
}

export async function serveMedia(request: Request, library: Library, id: string): Promise<Response> {
  try {
    const opened = await library.openAvailableSource(id)
    if (!opened) return new Response(null, { status: 404 })
    const { source, file } = opened
    let streaming = false
    try {
      const size = Number(source.identity.size)
      if (!Number.isSafeInteger(size) || size <= 0) {
        return new Response(null, { status: 404 })
      }

      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': audioMime[source.format],
        'X-Content-Type-Options': 'nosniff',
      })
      const rangeHeader = request.headers.get('range')
      const range = rangeHeader === null ? null : parseRange(rangeHeader, size)
      if (rangeHeader !== null && !range) {
        headers.set('Content-Range', `bytes */${size}`)
        return new Response(null, { status: 416, headers })
      }

      if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      headers.set('Content-Length', String(range ? range.end - range.start + 1 : size))
      const status = range ? 206 : 200
      if (request.method === 'HEAD') return new Response(null, { status, headers })

      const stream = file.createReadStream(range ?? { start: 0, end: size - 1 })
      streaming = true
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers })
    } finally {
      if (!streaming) await file.close()
    }
  } catch {
    return new Response(null, { status: 404 })
  }
}
