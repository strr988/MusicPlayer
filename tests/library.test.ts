import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library } from '../src/main/library'
import { parseRange, serveMedia } from '../src/main/media'

const mp3 = new URL('./fixtures/01-tone.mp3', import.meta.url)
const flac = new URL('./fixtures/02-tone.flac', import.meta.url)
let temp: string
let folder: string

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'music-player-'))
  folder = join(temp, 'Музыка')
  await mkdir(folder)
})

afterEach(async () => { await rm(temp, { recursive: true, force: true }) })

describe('local library', () => {
  it('imports tagged files recursively, reports corrupt files and preserves stable IDs', async () => {
    const nested = join(folder, 'Альбом')
    await mkdir(nested)
    await copyFile(mp3, join(folder, '01 # tone.MP3'))
    await copyFile(flac, join(nested, '02 tone.flac'))
    await writeFile(join(folder, 'broken.flac'), 'not audio')
    await writeFile(join(folder, 'ignore.txt'), 'not audio')
    const library = new Library()

    const first = await library.importFolder(folder)
    expect(first.processed).toBe(2)
    expect(first.issues).toEqual([{ entry: 'broken.flac', reason: 'file-unreadable' }])
    expect(first.tracks).toEqual([
      expect.objectContaining({ title: 'Test Tone MP3', artist: 'Fixture Artist', album: 'Fixture Album', format: 'mp3' }),
      expect.objectContaining({ title: 'Test Tone FLAC', artist: 'Fixture Artist', album: 'Fixture Album', format: 'flac' }),
    ])
    for (const track of first.tracks) expect(track.durationSeconds).toBeGreaterThan(3)
    expect(await library.importFolder(folder)).toEqual(first)
    expect(first.tracks[0]).not.toHaveProperty('path')
    expect(await readFile(join(folder, '01 # tone.MP3'))).toEqual(await readFile(mp3))
  })

  it('uses the file name for missing tags and ignores directory links outside the chosen folder', async () => {
    const bytes = await readFile(mp3)
    expect(bytes.toString('ascii', 0, 3)).toBe('ID3')
    const tagSize = bytes.subarray(6, 10).reduce((size, byte) => size * 128 + byte, 0)
    await writeFile(join(folder, 'Без тегов.mp3'), bytes.subarray(10 + tagSize))
    const outside = join(temp, 'outside')
    await mkdir(outside)
    await copyFile(flac, join(outside, 'private.flac'))
    await symlink(outside, join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = await new Library().importFolder(folder)
    expect(result.tracks).toEqual([
      expect.objectContaining({ title: 'Без тегов', artist: null, album: null }),
    ])
    expect(result.issues).toEqual([])
  })
})

describe('local audio', () => {
  it('streams authorized ranges and rejects unknown, removed and replaced files', async () => {
    const path = join(folder, 'track.mp3')
    await copyFile(mp3, path)
    const library = new Library()
    const { tracks } = await library.importFolder(folder)
    const source = library.getSourceId(tracks[0].id)!
    const url = `music-player://app/audio/${source}`
    const request = new Request(url, { headers: { Range: 'bytes=15-30' } })
    const bytes = await readFile(mp3)

    const response = await serveMedia(request, library, source)
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe(`bytes 15-30/${bytes.length}`)
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(15, 31))
    const invalid = await serveMedia(new Request(url, { headers: { Range: 'bytes=999999-' } }), library, source)
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('Content-Range')).toBe(`bytes */${bytes.length}`)
    const head = await serveMedia(new Request(url, { method: 'HEAD' }), library, source)
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe(String(bytes.length))
    expect(head.body).toBeNull()
    expect((await serveMedia(request, library, 'unknown')).status).toBe(404)

    await rm(path)
    expect((await serveMedia(request, library, source)).status).toBe(404)
    await copyFile(mp3, path)
    expect((await serveMedia(request, library, source)).status).toBe(404)
    expect((await library.importFolder(folder)).tracks[0].id).toBe(tracks[0].id)
    const updatedSource = library.getSourceId(tracks[0].id)!
    expect(updatedSource).not.toBe(source)
    expect((await serveMedia(request, library, source)).status).toBe(404)
    const afterImport = await serveMedia(request, library, updatedSource)
    expect(afterImport.status).toBe(206)
    await afterImport.arrayBuffer()
  })

  it.each([
    ['bytes=0-', { start: 0, end: 49 }],
    ['bytes=40-60', { start: 40, end: 49 }],
    ['bytes=-3', { start: 47, end: 49 }],
    ['bytes=-500', { start: 0, end: 49 }],
    ['bytes=-0', null],
    ['bytes=50-', null],
    ['bytes=9-1', null],
    ['bytes=0-1,4-8', null],
    ['items=0-1', null],
  ])('handles %s', (header, expected) => {
    expect(parseRange(header, 50)).toEqual(expected)
  })
})
