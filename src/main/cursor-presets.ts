import { lstat, open } from 'node:fs/promises'
import { nativeImage } from 'electron'
import type { CursorImage } from './library-store'
import { sameFile } from './local-file'

const limit = 160 * 1024
const maxSide = 64
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cursor preset')
  return value as Record<string, unknown>
}

function decode(value: unknown): CursorImage {
  const { png, x, y } = object(value)
  if (typeof png !== 'string' || typeof x !== 'number' || typeof y !== 'number' ||
      !Number.isInteger(x) || !Number.isInteger(y) || !/^[a-z0-9+/]+={0,2}$/i.test(png)) {
    throw new Error('Invalid cursor image')
  }
  const bytes = Buffer.from(png, 'base64')
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(pngSignature) || bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Expected a PNG cursor')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (width > maxSide || height > maxSide || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error('Invalid cursor dimensions or hotspot')
  }
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty() || image.getSize().width !== width || image.getSize().height !== height) {
    throw new Error('Could not decode PNG cursor')
  }
  return { png: new Uint8Array(image.toPNG()), x, y }
}

export async function readCursorPreset(path: string) {
  const stat = await lstat(path, { bigint: true })
  if (!stat.isFile() || stat.size === 0n || stat.size > limit) throw new Error('Invalid cursor preset size')
  await using file = await open(path, 'r')
  if (!sameFile(stat, await file.stat({ bigint: true }))) throw new Error('Cursor preset changed')
  const bytes = Buffer.alloc(Number(stat.size))
  const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
  if (bytesRead !== bytes.length || !sameFile(stat, await file.stat({ bigint: true }))) throw new Error('Cursor preset changed')
  const { version, name, arrow, pointer } = object(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')))
  if (version !== 1 || typeof name !== 'string' || !name.trim() || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('Invalid cursor preset name or version')
  }
  return { label: name.trim(), arrow: decode(arrow), pointer: decode(pointer ?? arrow) }
}
