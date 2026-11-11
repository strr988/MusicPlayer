import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Artwork } from '../src/main/artwork'
import { Library } from '../src/main/library'
import { flacWithArtwork, mp3WithArtwork } from './fixtures/artwork'

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url))
let folder: string
let library: Library
let artwork: Artwork

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'music-player-artwork-'))
  library = new Library(':memory:')
  artwork = new Artwork(library)
})

afterEach(async () => {
  library.close()
  await rm(folder, { recursive: true, force: true })
})

function serve(url: string, method = 'GET') {
  return artwork.serve(new Request(url, { method }), url.split('/').at(-1)!)
}

it('serves actual JPEG and PNG bytes from imported sources, reuses reads, and revokes old IDs', async () => {
  const [mp3, flac, jpg, png] = await Promise.all(['01-tone.mp3', '02-tone.flac', 'cover.jpg', 'cover.png'].map(fixture))
  const mp3Path = join(folder, '01.mp3')
  const mp3Bytes = mp3WithArtwork(mp3, jpg)
  await writeFile(mp3Path, mp3Bytes)
  await writeFile(join(folder, '02.flac'), flacWithArtwork(flac, png))
  const { tracks, processed } = await library.importFolder(folder)
  expect(processed).toBe(2)
  const original = library.openAvailableSource.bind(library)
  let reads = 0
  vi.spyOn(library, 'openAvailableSource').mockImplementation(async id => {
    const opened = await original(id)
    if (opened) {
      const createReadStream = opened.file.createReadStream.bind(opened.file)
      vi.spyOn(opened.file, 'createReadStream').mockImplementation(options => {
        reads++
        return createReadStream(options)
      })
    }
    return opened
  })

  const url = tracks[0].artworkUrl!
  const [jpeg, head] = await Promise.all([serve(url), serve(url, 'HEAD')])
  expect(reads).toBe(1)
  expect(jpeg.status).toBe(200)
  expect(jpeg.headers.get('Content-Type')).toBe('image/jpeg')
  expect(jpeg.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(Buffer.from(await jpeg.arrayBuffer())).toEqual(jpg)
  expect(head.headers.get('Content-Length')).toBe(String(jpg.length))
  expect(head.body).toBeNull()
  const picture = await serve(tracks[1].artworkUrl!)
  expect(picture.headers.get('Content-Type')).toBe('image/png')
  expect(Buffer.from(await picture.arrayBuffer())).toEqual(png)
  expect(await readFile(mp3Path)).toEqual(mp3Bytes)

  await rm(mp3Path)
  expect((await serve(url)).status).toBe(404)
  await writeFile(mp3Path, mp3WithArtwork(mp3, png, 'image/png'))
  expect((await serve(url)).status).toBe(404)
  const [updated] = (await library.importFolder(folder)).tracks
  expect(updated.id).toBe(tracks[0].id)
  expect(updated.artworkUrl).not.toBe(url)
  expect((await serve(updated.artworkUrl!)).headers.get('Content-Type')).toBe('image/png')
  expect((await serve(url)).status).toBe(404)
})

it('keeps playable tracks with missing, corrupt, unsupported and oversized artwork', async () => {
  const [mp3, flac, jpg, png] = await Promise.all(['01-tone.mp3', '02-tone.flac', 'cover.jpg', 'cover.png'].map(fixture))
  const oversizedDimensions = Buffer.from(png)
  oversizedDimensions.writeUInt32BE(30_000, 16)
  const fixtures = {
    '01.mp3': mp3,
    '02.mp3': mp3WithArtwork(mp3, jpg.subarray(0, 80)),
    '03.mp3': mp3WithArtwork(mp3, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    '04.flac': flacWithArtwork(flac, oversizedDimensions),
    '05.mp3': mp3WithArtwork(mp3, Buffer.concat([jpg, Buffer.alloc(2 * 1024 * 1024)])),
    '06.mp3': mp3WithArtwork(mp3, Buffer.concat([jpg, Buffer.alloc(8 * 1024 * 1024)])),
  }
  await Promise.all(Object.entries(fixtures).map(([name, bytes]) => writeFile(join(folder, name), bytes)))
  const result = await library.importFolder(folder)
  expect(result.issues).toEqual([])
  expect(result.tracks).toHaveLength(6)
  expect(result.tracks[5].title).toBe('06')
  for (const track of result.tracks) {
    expect(await library.getAvailableSource(library.getSourceId(track.id)!)).toBeDefined()
    expect((await serve(track.artworkUrl!)).status).toBe(404)
  }
  expect((await serve('music-player://app/artwork/00000000-0000-0000-0000-000000000000')).status).toBe(404)
})
