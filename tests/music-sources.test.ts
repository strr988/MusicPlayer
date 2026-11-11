import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { Library } from '../src/main/library'
import { archiveLink, normalizeArchive } from '../src/main/music-sources/archive'
import type { MusicSourceProvider } from '../src/main/music-sources/archive'
import { DownloadManager, metadataEdits } from '../src/main/music-sources/download-manager'
import { publicAddress, validateArchiveEndpoint, withArchiveProxy } from '../src/main/music-sources/network'
import { checkVersion, verifiedYtDlp, ytDlpVersion } from '../src/main/music-sources/yt-dlp'
import { request } from 'node:http'
import { createHash } from 'node:crypto'

const audio = new URL('./fixtures/01-tone.mp3', import.meta.url)
const item = 'example'
const name = 'Original Tone.mp3'
const url = `https://archive.org/details/${item}`
const link = archiveLink(url)
const fileUrl = 'https://archive.org/download/example/Original%20Tone.mp3'
const audioBytes = await readFile(audio)
const sha1 = createHash('sha1').update(audioBytes).digest('hex')
const license = 'https://creativecommons.org/publicdomain/zero/1.0/'
const cli = {
  id: item, display_id: name, extractor: 'archive.org', track: 'Tone', duration: 1,
  uploader: 'Account name', formats: [{ url: fileUrl, ext: 'mp3' }],
}
const archive = {
  metadata: { identifier: item, mediatype: 'audio', licenseurl: license },
  files: [{ name, format: 'VBR MP3', source: 'original', size: String(audioBytes.length), sha1 }],
}
const json = JSON.stringify
const analysis = normalizeArchive(link, json(cli), json(archive))
const directories: string[] = []

async function profile() {
  const root = await realpath(tmpdir())
  const path = await mkdtemp(join(root, 'music-sources-test-'))
  directories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5 })))
})

test('recognizes only canonical HTTPS recording links and rejects traversal', () => {
  expect(archiveLink(' https://www.archive.org/details/example/Original%20Tone.mp3 ')).toEqual({
    url: `${url}/Original%20Tone.mp3`, item, file: name,
  })
  for (const rejected of [
    'https://youtu.be/track', 'http://archive.org/details/example', 'https://user@archive.org/details/example',
    'https://archive.org.evil.test/details/example', 'https://archive.org:444/details/example',
    `${url}/../track`, `${url}/%2e%2e/track`, `${url}/%252ftrack`, `${url}/%5Ctrack`, `${url}/a//b`, `${url}?token=x`,
  ]) expect(() => archiveLink(rejected)).toThrow()
})

test('normalizes track metadata, omits unknown tags and ignores uploader identity', () => {
  expect(analysis.metadata).toMatchObject({
    title: 'Tone', artist: null, album: null, durationSeconds: 1, sourceId: `${item}/${name}`,
    originalUrl: `${url}/Original%20Tone.mp3`, audioFormats: ['mp3'], licenseUrl: license, downloadFormat: 'mp3',
  })
  expect(normalizeArchive(link, json({ ...cli, track: null, title: name, duration: null }),
    json(archive)).metadata).toMatchObject({ title: null, durationSeconds: null })
  expect(() => normalizeArchive(link, '<html>', json(archive))).toThrow('JSON')
  expect(() => normalizeArchive(link, json({ _type: 'playlist', entries: [cli, cli] }), json(archive))).toThrow('несколько')
  expect(() => normalizeArchive(link, json({ ...cli, id: 'different' }), json(archive))).toThrow('другой')
})

test('allows only a licensed, unrestricted original with the exact media identity', () => {
  const variants = [
    { ...archive, metadata: { ...archive.metadata, licenseurl: 'https://creativecommons.org/licenses/by-nc/4.0/' } },
    { ...archive, metadata: { ...archive.metadata, 'access-restricted-item': 'true' } },
    { ...archive, files: [{ ...archive.files[0], private: 'true' }] },
    { ...archive, files: [{ ...archive.files[0], source: 'derivative' }] },
    { ...archive, files: [{ ...archive.files[0], size: String(151 * 1024 * 1024) }] },
  ]
  for (const variant of variants) expect(normalizeArchive(link, json(cli), json(variant)).original).toBeNull()
  for (const format of [{ url: 'https://127.0.0.1/file', ext: 'mp3' }, { url: fileUrl, ext: 'mp3', has_drm: true }]) {
    expect(normalizeArchive(link, json({ ...cli, formats: [format] }), json(archive)).original).toBeNull()
  }
  const flac = 'Original Tone.flac'
  expect(normalizeArchive(link, json({
    ...cli, display_id: flac, formats: [{ url: fileUrl.replace('.mp3', '.flac'), ext: 'flac' }],
  }), json({
    ...archive, files: [{ ...archive.files[0], name: flac, format: 'Flac' }],
  })).metadata.downloadFormat).toBe('flac')
})

test('network policy denies private DNS results and unapproved redirect destinations', async () => {
  expect(publicAddress(['207.241.224.2'])).toBe('207.241.224.2')
  for (const ip of ['127.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.0.2', '::ffff:10.0.0.1', '224.0.0.1']) {
    expect(() => publicAddress(['207.241.224.2', ip])).toThrow('заблокирован')
  }
  const pathAllowed = (target: URL) => target.pathname === '/0/items/example/tone.mp3'
  const file = '/0/items/example/tone.mp3'
  expect(() => validateArchiveEndpoint(new URL(`https://dn710100.ca.archive.org${file}`), pathAllowed)).not.toThrow()
  for (const target of [
    `https://127.0.0.1${file}`, `https://archive.org.attacker.test${file}`, `http://archive.org${file}`,
    `https://archive.org:8080${file}`, `https://web.archive.org${file}`, 'https://archive.org/0/items/other/tone.mp3',
  ]) expect(() => validateArchiveEndpoint(new URL(target), pathAllowed)).toThrow('заблокировано')
  await withArchiveProxy(proxy => new Promise<void>((resolve, reject) => {
    const tunnel = request(proxy, { method: 'CONNECT', path: '169.254.169.254:443' })
    tunnel.on('error', reject)
    tunnel.on('connect', (response, socket) => {
      socket.destroy()
      if (response.statusCode === 403) resolve()
      else reject(new Error('Unsafe tunnel was not rejected'))
    })
    tunnel.end()
  }))
})

test('reports a missing executable, rejects other hashes and versions', async () => {
  const dir = await profile()
  const binary = join(dir, 'external.exe')
  const signal = new AbortController().signal
  await expect(verifiedYtDlp(binary, dir, signal)).rejects.toThrow(ytDlpVersion)
  await writeFile(binary, 'wrong bytes')
  await expect(verifiedYtDlp(binary, dir, signal)).rejects.toThrow('SHA-256')
  expect(() => checkVersion(ytDlpVersion + '\n')).not.toThrow()
  expect(() => checkVersion('2026.11.04.232659')).toThrow(ytDlpVersion)
})

function provider(overrides: Partial<MusicSourceProvider> = {}): MusicSourceProvider {
  return {
    id: 'archive.org', recognize: archiveLink,
    async analyze() { return { ...analysis, cover: null } },
    async download(_link, _analysis, path, _signal, progress) {
      progress({ bytes: 0, total: null })
      await copyFile(audio, path)
    },
    ...overrides,
  }
}

test('serializes jobs, applies queue capacity, cancels and removes staging data', async () => {
  const directory = await profile()
  const library = new Library(':memory:')
  const analyze = vi.fn<MusicSourceProvider['analyze']>(async (_link, stage, signal) => {
    await writeFile(join(stage, 'partial'), 'test')
    if (signal.aborted) throw signal.reason
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const manager = new DownloadManager(directory, provider({ analyze }), library)
  try {
    for (let i = 0; i < 8; i++) await manager.analyze(url)
    await expect(manager.analyze(url)).rejects.toThrow('Очередь заполнена')
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1))
    const jobs = await manager.list()
    expect(jobs.filter(job => job.status === 'waiting')).toHaveLength(7)
    for (const job of jobs) manager.cancel(job.id)
    await manager.stop()
    expect(await readdir(join(directory, 'music-downloads'))).toEqual([])
    expect(analyze).toHaveBeenCalledTimes(1)
  } finally {
    await manager.stop()
    library.close()
  }
})

test('reports network and disk errors while keeping the queue usable', async () => {
  const directory = await profile()
  const library = new Library(':memory:')
  const analyze = vi.fn<MusicSourceProvider['analyze']>()
    .mockRejectedValueOnce(Object.assign(new Error('untrusted path'), { code: 'ECONNRESET' }))
    .mockResolvedValue({ ...analysis, cover: null })
  const download = vi.fn<MusicSourceProvider['download']>().mockRejectedValue(
    Object.assign(new Error('untrusted path'), { code: 'ENOSPC' }))
  const manager = new DownloadManager(directory, provider({ analyze, download }), library)
  try {
    await manager.analyze(url)
    await manager.analyze(url)
    await vi.waitFor(async () => expect((await manager.list()).map(job => job.status)).toEqual(['ready', 'failed']))
    const [next, failed] = await manager.list()
    expect(failed.error).toContain('Ошибка сети')
    await manager.confirm(next.id, {})
    await vi.waitFor(async () => expect((await manager.list())[0].error).toContain('Недостаточно места'))
  } finally {
    await manager.stop()
    library.close()
  }
})

test('cancelling an active download discards partial audio and allows a subsequent download', async () => {
  const directory = await profile()
  const library = new Library(':memory:')
  const download = vi.fn(provider().download).mockImplementationOnce(async (_link, _analysis, path, signal, progress) => {
    await writeFile(path, audioBytes.subarray(0, 256))
    progress({ bytes: 256, total: null })
    signal.throwIfAborted()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const manager = new DownloadManager(directory, provider({ download }), library)
  try {
    await manager.analyze(url)
    await manager.analyze(url)
    await vi.waitFor(async () => expect((await manager.list()).map(job => job.status)).toEqual(['ready', 'ready']))
    const [second, first] = await manager.list()
    await manager.confirm(first.id, {})
    await vi.waitFor(async () => expect((await manager.list())[1].progress).toEqual({ bytes: 256, total: null }))
    await expect(manager.confirm(second.id, {})).rejects.toThrow('уже есть')
    manager.cancel(first.id)
    await manager.confirm(second.id, {})
    await vi.waitFor(async () => expect((await manager.list()).map(job => job.status)).toEqual(['completed', 'cancelled']))
    expect(await readdir(join(directory, 'music-downloads'))).toEqual([second.id])
  } finally {
    await manager.stop()
    library.close()
  }
})

test('validates edits and preserves explicit empty values', () => {
  expect(metadataEdits({ title: '  Edited ', artist: '', album: null, durationSeconds: null })).toEqual({
    title: 'Edited', artist: null, album: null, durationSeconds: null,
  })
  expect(() => metadataEdits({ originalUrl: 'https://other.test' })).toThrow()
  expect(() => metadataEdits({ title: 'bad\nname' })).toThrow()
  expect(() => metadataEdits({ durationSeconds: Infinity })).toThrow()
})

test('imports a completed task, survives a restart and deduplicates by source identity', async () => {
  const directory = await profile()
  const dbPath = join(directory, 'library.sqlite3')
  // Open a schema 5 profile with an existing reaction and Track ID.
  const files = join(directory, 'existing')
  await mkdir(files)
  await copyFile(audio, join(files, 'old.mp3'))
  const oldLibrary = new Library(dbPath)
  const { tracks: [oldTrack] } = await oldLibrary.importFolder(files)
  oldLibrary.setTrackPreference(oldTrack.id, true)
  oldLibrary.close()
  {
    using db = new DatabaseSync(dbPath)
    db.exec('DROP TABLE external_recordings; PRAGMA user_version = 5')
  }
  let library = new Library(dbPath)
  const cover = await readFile(new URL('./fixtures/cover.png', import.meta.url))
  const fixture = provider({
    async analyze() { return { ...analysis, cover } },
  })
  let manager = new DownloadManager(directory, fixture, library)
  try {
    expect((await readdir(directory)).some(path => /\.v5-.*\.backup$/.test(path))).toBe(true)
    await manager.analyze(url)
    await vi.waitFor(async () => expect((await manager.list())[0].status).toBe('ready'))
    const [{ id }] = await manager.list()
    await manager.confirm(id, { title: 'Edited title', artist: 'Edited artist', durationSeconds: null })
    await vi.waitFor(async () => expect((await manager.list())[0].status).toBe('completed'))
    const downloaded = await manager.file(id)
    await writeFile(downloaded, Buffer.alloc(audioBytes.length))
    await expect(manager.addToLibrary(id)).rejects.toThrow('Содержимое загруженного файла изменилось')
    await writeFile(downloaded, audioBytes)
    await Promise.all([manager.addToLibrary(id), manager.addToLibrary(id)])
    const trackId = (await manager.list())[0].trackId!
    await library.importFolder(join(directory, 'music-downloads'))
    expect(library.getTracks()).toHaveLength(2)
    await manager.stop()
    library.close()
    library = new Library(dbPath)
    manager = new DownloadManager(directory, fixture, library)
    expect((await manager.list())[0]).toMatchObject({ status: 'completed', trackId })
    expect(library.getTracks().find(track => track.id === trackId)).toMatchObject({
      title: 'Edited title', artist: 'Edited artist', durationSeconds: null, available: true,
    })
    expect(Buffer.from(library.getDownloadCover(trackId)!)).toEqual(cover)
    expect(library.getListeningData().preferences).toMatchObject([{ trackId: oldTrack.id, liked: true }])
    await manager.analyze(url)
    await vi.waitFor(async () => expect((await manager.list())[0].duplicate).toBe(true))
    await expect(manager.confirm((await manager.list())[0].id, {})).rejects.toThrow('уже есть')
    using db = new DatabaseSync(dbPath)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(JSON.parse(String(db.prepare('SELECT edits FROM external_recordings').get()?.edits))).toMatchObject({ title: 'Edited title' })
  } finally {
    await manager.stop()
    library.close()
  }
})
