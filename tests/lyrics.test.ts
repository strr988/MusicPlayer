import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Library } from '../src/main/library'
import { parseLrc } from '../src/main/lyric-text'
import { readTrackLyrics } from '../src/main/lyrics'
import { activeLyric } from '../src/renderer/src/active-lyric'

it('sorts repeated LRC timestamps and applies the offset to tenths, centiseconds and milliseconds', () => {
  expect(parseLrc('\uFEFF[ar:Исполнитель]\r\n[00:02.1][00:01.50] Припев\r\n[00:02.201]\r\n[00:03] <00:03.20>Куплет\r\n[offset:+200]'))
    .toEqual({ kind: 'timed', lines: [
      { seconds: 1.3, text: 'Припев' }, { seconds: 1.9, text: 'Припев' },
      { seconds: 2.001, text: '' }, { seconds: 2.8, text: 'Куплет' },
    ] })
  expect(parseLrc('[00:00.10]Начало\n[offset:300]')).toEqual({ kind: 'timed', lines: [{ seconds: 0, text: 'Начало' }] })
  expect(parseLrc('[00:00]Начало\n[offset:-200]')).toEqual({ kind: 'timed', lines: [{ seconds: 0.2, text: 'Начало' }] })
})

it('handles plain lyrics and discards empty, malformed and oversized LRC data', () => {
  expect(parseLrc('[ti:Заголовок]\r\nСтрока\r\n\r\nПрипев')).toEqual({ kind: 'plain', text: 'Строка\n\nПрипев' })
  for (const text of ['', '\n[ar:Artist]', '[00:67.20]bad', '[00:01]  ', 'a\u0000b', 'z'.repeat(262_145),
    '[00:01]line\n'.repeat(2_001), '[00:01]'.repeat(100) + 'long'.repeat(1000)]) {
    expect(parseLrc(text)).toBeNull()
  }
})

it('finds the last cue at or before the position, including backwards seeks and simultaneous cues', () => {
  const lines = [1, 1.5, 1.5, 2].map(seconds => ({ seconds, text: '' }))
  expect([0.9, 1, 1.49, 1.5, 10, 1.2].map(time => activeLyric(lines, time))).toEqual([-1, 0, 0, 2, 3, 0])
  expect(activeLyric([], 0)).toBe(-1)
})

const fixture = (name: string) => new URL('./fixtures/' + name, import.meta.url)
let root: string
let folder: string
let library: Library

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'player-lyrics-'))
  folder = join(root, 'Музыка')
  await mkdir(folder)
  library = new Library(':memory:')
})
afterEach(async () => {
  library.close()
  await rm(root, { recursive: true, force: true })
})

async function importTrack() {
  const result = await library.importFolder(folder)
  expect(result.tracks).toHaveLength(1)
  return result.tracks[0].id
}

it('looks up same-stem sidecars by imported ID and falls back from corrupt LRC to BOM-marked TXT', async () => {
  const stem = join(folder, 'Песня')
  await copyFile(fixture('01-tone.mp3'), stem + '.mp3')
  await writeFile(stem + '.LRC', '[00:01.000] Синхронизация')
  await writeFile(stem + '.txt', Buffer.from('\uFEFFОбычный\nтекст', 'utf16le'))
  const id = await importTrack()
  expect(await readTrackLyrics(library, id)).toEqual({ kind: 'timed', lines: [{ seconds: 1, text: 'Синхронизация' }] })
  await writeFile(stem + '.LRC', Buffer.from([0xff, 0xfa, 0x81]))
  expect(await readTrackLyrics(library, id)).toEqual({ kind: 'plain', text: 'Обычный\nтекст' })
  await writeFile(stem + '.txt', '')
  expect(await readTrackLyrics(library, id)).toBeNull()
  expect(await readTrackLyrics(library, randomUUID())).toBeNull()
  await rm(stem + '.mp3')
  await writeFile(stem + '.txt', 'Still here')
  expect(await readTrackLyrics(library, id)).toBeNull()
})

function id3Frame(id: string, bytes: Buffer): Buffer {
  const size = Buffer.from([0, 0, bytes.length >> 7, bytes.length & 0x7f])
  return Buffer.concat([Buffer.from(id), size, Buffer.alloc(2), bytes])
}

async function mp3WithLyric(tag: Buffer): Promise<Buffer> {
  const audio = await readFile(fixture('01-tone.mp3'))
  const size = audio.subarray(6, 10).reduce((sum, byte) => sum * 128 + byte, 0)
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, tag.length >> 7, tag.length & 0x7f]),
    tag, audio.subarray(10 + size)])
}

it('uses millisecond SYLT in MP3 and reads plain USLT when synchronization is absent', async () => {
  const plain = id3Frame('USLT', Buffer.from('\x03rus\x00Обычный текст'))
  const synced = id3Frame('SYLT', Buffer.concat([
    Buffer.from('\x03rus\x02\x01\x00Куплет\x00'), Buffer.from([0, 0, 1, 244]),
    Buffer.from('Припев\x00'), Buffer.from([0, 0, 3, 232]),
  ]))
  const path = join(folder, 'tag.mp3')
  await writeFile(path, await mp3WithLyric(Buffer.concat([plain, synced])))
  const id = await importTrack()
  expect(await readTrackLyrics(library, id)).toEqual({ kind: 'timed', lines: [
    { seconds: 0.5, text: 'Куплет' }, { seconds: 1, text: 'Припев' },
  ] })
  await writeFile(path, await mp3WithLyric(plain))
  expect(await importTrack()).toBe(id)
  expect(await readTrackLyrics(library, id)).toEqual({ kind: 'plain', text: 'Обычный текст' })
})

it('preserves multiple timestamps and offsets in a FLAC Vorbis lyric tag', async () => {
  const original = await readFile(fixture('02-tone.flac'))
  const value = Buffer.from('LYRICS=[00:01.00][00:02.00]Строка\n[offset:200]')
  const comment = Buffer.alloc(12)
  comment.writeUInt32LE(1, 4)
  comment.writeUInt32LE(value.length, 8)
  const block = Buffer.from([4, 0, 0, comment.length + value.length])
  const streamInfoEnd = 8 + original.readUIntBE(5, 3)
  await writeFile(join(folder, 'tag.flac'), Buffer.concat([
    original.subarray(0, streamInfoEnd), block, comment, value, original.subarray(streamInfoEnd),
  ]))
  const id = await importTrack()
  expect(await readTrackLyrics(library, id)).toEqual({ kind: 'timed', lines: [
    { seconds: 0.8, text: 'Строка' }, { seconds: 1.8, text: 'Строка' },
  ] })
})
