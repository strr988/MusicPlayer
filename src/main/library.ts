import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { parseFile, parseStream } from 'music-metadata'
import type { ImportIssue, ImportResult, LibraryTrack, Track, ListeningDataReader, PlaybackEventInput, PlaybackSession, VolumePreference, WaveMode } from '../shared/contracts'
import type { RecommendationCandidate } from '../recommendations/engine'
import { LibraryStore } from './library-store'
import type { LocalSource, ScanEntry } from './library-store'
import { fileIdentity, moveKey, sameFile, sameIdentity } from './local-file'
import type { FileIdentity } from './local-file'
import type { AudioFormat, MetadataEdits, SourceMetadata } from '../shared/music-sources'

interface ScannedFile {
  path: string
  tags: Omit<Track, 'id'>
  identity: FileIdentity
}

export interface DownloadIntegrity {
  size: number
  sha1: string
}

type CompletedImport = Extract<ImportResult, { status: 'complete' }>
const metadataLimit = 8 * 1024 * 1024
const metadataOptions = { skipCovers: true, maxMemoryAllocation: metadataLimit, maxMetadataEntries: 10_000 }
const changedDownload = 'Содержимое загруженного файла изменилось.'

function isWithin(root: string, file: string): boolean {
  const name = relative(root, file)
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name)
}

async function openVerifiedFile(source: Pick<LocalSource, 'path' | 'identity'>): Promise<FileHandle | undefined> {
  let file: FileHandle | undefined
  try {
    if (await realpath(source.path) !== source.path ||
        !sameFile(source.identity, await lstat(source.path, { bigint: true }))) return undefined
    file = await open(source.path, 'r')
    if (sameFile(source.identity, await file.stat({ bigint: true }))) return file
  } catch {
    // Missing, unreadable or replaced since import.
  }
  await file?.close()
}

async function readOversizedId3(path: string, identity: FileIdentity) {
  const file = await openVerifiedFile({ path, identity })
  if (!file) return
  try {
    const header = Buffer.alloc(10)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    const version = header[3]
    const lengthBytes = header.subarray(6)
    if (bytesRead !== 10 || header.toString('ascii', 0, 3) !== 'ID3' || version < 2 || version > 4 ||
        lengthBytes.some(byte => byte > 0x7f)) return
    const length = lengthBytes.reduce((size, byte) => size * 128 + byte, 0)
    const start = 10 + length + (version === 4 && (header[5] & 0x10) ? 10 : 0)
    const size = Number(identity.size)
    if (length <= metadataLimit || !Number.isSafeInteger(size) || start >= size) return
    // Import the MPEG audio even if its leading tag exceeds the metadata allocation limit.
    const stream = file.createReadStream({ start, end: Math.min(size, start + metadataLimit) - 1, autoClose: false })
    try {
      return await parseStream(stream, { mimeType: 'audio/mpeg', size: size - start }, metadataOptions)
    } finally {
      stream.destroy()
    }
  } finally {
    await file.close()
  }
}

async function isAvailable(source: LocalSource): Promise<boolean> {
  const file = await openVerifiedFile(source)
  await file?.close()
  return file !== undefined
}

async function previousPathMoved(from: string, to: string): Promise<boolean> {
  try {
    // Windows can still resolve the old spelling after a case-only rename.
    return await realpath(from) === to
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export class Library implements ListeningDataReader {
  private readonly store: LibraryStore
  private pendingScan = Promise.resolve()

  constructor(databasePath: string, private readonly downloadsDirectory?: string) {
    this.store = new LibraryStore(databasePath)
  }

  close(): void {
    this.store.close()
  }

  getListeningData() { return this.store.getListeningData() }
  setTrackPreference(trackId: string, liked: boolean) { return this.store.setTrackPreference(trackId, liked) }
  recordPlaybackEvent(event: PlaybackEventInput): void { this.store.recordPlaybackEvent(event) }

  getVolume(): VolumePreference { return this.store.getVolume() }
  setVolume(volume: VolumePreference): void { this.store.setVolume(volume) }
  getPlaybackSession() { return this.store.getPlaybackSession() }
  setPlaybackSession(session: PlaybackSession): void { this.store.setPlaybackSession(session) }

  getWaveMode() { return this.store.getWaveMode() }
  setWaveMode(mode: WaveMode): void { this.store.setWaveMode(mode) }

  getPlaylists() { return this.store.getPlaylists() }
  createPlaylist(name: string) { return this.store.createPlaylist(name) }
  renamePlaylist(id: string, name: string): void { this.store.renamePlaylist(id, name) }
  deletePlaylist(id: string): void { this.store.deletePlaylist(id) }
  removePlaylistTrack(id: string, trackId: string) { return this.store.removePlaylistTrack(id, trackId) }
  movePlaylistTrack(id: string, trackId: string, offset: -1 | 1) { return this.store.movePlaylistTrack(id, trackId, offset) }

  async addPlaylistTrack(id: string, trackId: string) {
    const sourceId = this.getSourceId(trackId)
    if (!sourceId || !await this.getAvailableSource(sourceId)) throw new Error('Track unavailable')
    return this.store.addPlaylistTrack(id, trackId)
  }

  getTracks(): LibraryTrack[] {
    return this.store.getTracks()
  }

  getExternalTrackId(metadata: SourceMetadata): string | undefined {
    return this.store.getExternalTrackId(metadata.provider, metadata.sourceId)
  }

  getDownloadCover(trackId: string) { return this.store.getDownloadCover(trackId) }

  async validateDownloadedAudio(path: string, format: AudioFormat, integrity: DownloadIntegrity, signal: AbortSignal): Promise<void> {
    await this.readDownloadedFile(path, format, integrity, signal)
  }

  importDownload(path: string, metadata: SourceMetadata, edits: MetadataEdits, cover: Uint8Array | null,
    integrity: DownloadIntegrity, signal: AbortSignal): Promise<string> {
    return this.importRecording(metadata, edits, cover, signal, () => {
      if (!metadata.downloadFormat) throw new Error('Неподдерживаемый формат.')
      return this.readDownloadedFile(path, metadata.downloadFormat, integrity, signal)
    })
  }

  importSoundCloudOriginal(path: string, metadata: SourceMetadata, edits: MetadataEdits, cover: Uint8Array | null,
    signal: AbortSignal): Promise<string> {
    if (metadata.provider !== 'soundcloud') throw new Error('Выберите трек SoundCloud.')
    return this.importRecording(metadata, edits, cover, signal, async () => {
      const format = extname(path).slice(1).toLowerCase()
      if (format !== 'mp3' && format !== 'flac') throw new Error('Выберите оригинал в формате MP3 или FLAC.')
      const identity = await lstat(path, { bigint: true })
      if (!identity.isFile()) throw new Error('Выберите обычный аудиофайл.')
      const canonical = await realpath(path)
      return this.readExternalAudio(canonical, format, identity, true)
    })
  }

  private importRecording(metadata: SourceMetadata, edits: MetadataEdits, cover: Uint8Array | null,
    signal: AbortSignal, read: () => Promise<ScannedFile>): Promise<string> {
    const scan = this.pendingScan.then(async () => {
      signal.throwIfAborted()
      const duplicate = this.getExternalTrackId(metadata)
      if (duplicate) return duplicate
      const file = await read()
      const { path } = file
      const existing = this.store.getLocalSources().find(source => source.path === path)
      if (existing && this.store.isExternalRecording(existing.trackId)) {
        throw new Error('Этот файл уже связан с другой записью внешнего источника.')
      }
      const track: Track = {
        ...file.tags, id: existing?.trackId ?? randomUUID(),
        title: (edits.title === undefined ? metadata.title : edits.title) ??
          (metadata.provider === 'soundcloud' ? file.tags.title : metadata.sourceId.slice(metadata.sourceId.indexOf('/') + 1)),
        artist: edits.artist === undefined ? metadata.artist : edits.artist,
        album: edits.album === undefined ? metadata.album : edits.album,
        durationSeconds: edits.durationSeconds === undefined ? metadata.durationSeconds ?? file.tags.durationSeconds : edits.durationSeconds,
      }
      // The commit is synchronous. Cancellation is honored up to this boundary.
      signal.throwIfAborted()
      return this.store.saveExternalRecording({
        track,
        source: {
          id: existing && sameIdentity(existing.identity, file.identity) ? existing.id : randomUUID(),
          trackId: track.id, path, format: track.format, identity: file.identity,
        },
        previousSourceId: existing?.id,
      }, metadata, edits, cover)
    })
    this.pendingScan = scan.then(() => undefined, () => undefined)
    return scan
  }

  async getRecommendationCandidates(): Promise<RecommendationCandidate[]> {
    await this.refreshAvailability()
    return this.getTracks().map(({ id, artist, genres, available }) => ({ id, artist, genres, available }))
  }

  async refreshAvailability(): Promise<void> {
    const status = new Map<string, boolean>()
    for (const source of this.store.getLocalSources()) {
      const available = await isAvailable(source)
      if (source.available !== available) status.set(source.id, available)
    }
    if (status.size > 0) this.store.setAvailability(status)
  }

  async getAvailableSource(id: string): Promise<LocalSource | undefined> {
    const opened = await this.openAvailableSource(id)
    await opened?.file.close()
    return opened?.source
  }

  async openAvailableSource(id: string): Promise<{ source: LocalSource; file: FileHandle } | undefined> {
    const source = this.store.getLocalSource(id)
    if (!source) return undefined
    const file = await openVerifiedFile(source)
    try {
      const current = this.store.getLocalSource(id)
      if (current) {
        const available = file !== undefined
        if (current.available !== available) this.store.setSourceAvailability(id, available)
        if (file) return { source: { ...current, available: true }, file }
      }
    } catch (error) {
      await file?.close()
      throw error
    }
    await file?.close()
  }

  getSourceId(trackId: string): string | undefined {
    return this.store.getSourceId(trackId)
  }

  importFolder(folder: string): Promise<CompletedImport> {
    const scan = this.pendingScan.then(() => this.scanFolder(folder))
    this.pendingScan = scan.then(() => undefined, () => undefined)
    return scan
  }

  private async scanFolder(folder: string): Promise<CompletedImport> {
    const root = await realpath(folder)
    if (!(await lstat(root)).isDirectory()) throw new Error('Expected an import folder')
    const issues: ImportIssue[] = []
    const files: ScannedFile[] = []
    const downloads = this.downloadsDirectory && await realpath(this.downloadsDirectory).catch(() => undefined)

    const scan = async (directory: string): Promise<void> => {
      if (downloads && /^\.stage-[a-zA-Z0-9]{6}$/.test(relative(downloads, directory).split(sep)[0])) return
      let entries
      try {
        if (await realpath(directory) !== directory) throw new Error('Directory moved')
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        issues.push({ entry: relative(root, directory) || '.', reason: 'directory-unreadable' })
        return
      }

      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          await scan(path)
          continue
        }
        if (!entry.isFile()) continue

        const extension = extname(path).toLowerCase()
        if (extension !== '.mp3' && extension !== '.flac') continue
        try {
          const canonical = await realpath(path)
          if (canonical !== path || !isWithin(root, canonical)) throw new Error('File moved')
          files.push(await this.readFile(canonical, extension === '.mp3' ? 'mp3' : 'flac'))
        } catch {
          issues.push({ entry: relative(root, path), reason: 'file-unreadable' })
        }
      }
    }

    await scan(root)
    await this.saveScan(root, files, issues)
    return { status: 'complete', tracks: this.getTracks(), processed: files.length, issues }
  }

  private async saveScan(root: string, files: ScannedFile[], issues: ImportIssue[]): Promise<void> {
    const previous = this.store.getLocalSources()
    const byPath = new Map(previous.map((source) => [source.path, source]))
    const byMoveKey = new Map<string, LocalSource | null>()
    for (const source of previous) {
      const key = moveKey(source.identity)
      if (key) byMoveKey.set(key, byMoveKey.has(key) ? null : source)
    }
    const fileCounts = new Map<string, number>()
    for (const file of files) {
      const key = moveKey(file.identity)
      if (key) fileCounts.set(key, (fileCounts.get(key) ?? 0) + 1)
    }

    const scannedPaths = new Set(files.map((file) => file.path))
    const refreshedSources = new Set<string>()
    const entries: ScanEntry[] = []
    for (const file of files) {
      let existing = byPath.get(file.path)
      if (!existing) {
        const key = moveKey(file.identity)
        const candidate = key && fileCounts.get(key) === 1 && byMoveKey.get(key)
        if (candidate && !scannedPaths.has(candidate.path) && await previousPathMoved(candidate.path, file.path)) {
          existing = candidate
        }
      }
      if (existing && !sameIdentity(existing.identity, file.identity) && this.store.isExternalRecording(existing.trackId)) {
        issues.push({ entry: relative(root, file.path), reason: 'file-unreadable' })
        continue
      }
      if (existing) refreshedSources.add(existing.id)
      const track = { id: existing?.trackId ?? randomUUID(), ...file.tags }
      const source = {
        // Revoke the old media URL when the bytes, timestamps or path change.
        id: existing?.path === file.path && sameIdentity(existing.identity, file.identity) ? existing.id : randomUUID(),
        trackId: track.id,
        path: file.path,
        format: track.format,
        identity: file.identity,
      }
      entries.push({ track, source, previousSourceId: existing?.id })
    }

    const availability = new Map<string, boolean>()
    for (const source of previous) {
      if (isWithin(root, source.path) && !refreshedSources.has(source.id)) {
        availability.set(source.id, await isAvailable(source))
      }
    }
    this.store.saveScan(root, entries, availability)
  }

  private async readDownloadedFile(path: string, format: AudioFormat, integrity: DownloadIntegrity, signal: AbortSignal) {
    signal.throwIfAborted()
    const identity = await lstat(path, { bigint: true })
    if (identity.size !== BigInt(integrity.size)) throw new Error(changedDownload)
    const file = await openVerifiedFile({ path, identity })
    if (!file) throw new Error(changedDownload)
    try {
      const hash = createHash('sha1')
      let size = 0
      for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
        size += chunk.length
        if (size > integrity.size) throw new Error(changedDownload)
        hash.update(chunk)
      }
      if (size !== integrity.size || hash.digest('hex') !== integrity.sha1 ||
          !sameFile(identity, await file.stat({ bigint: true }))) throw new Error(changedDownload)
    } finally {
      await file.close()
    }
    signal.throwIfAborted()
    const scanned = await this.readExternalAudio(path, format, identity)
    signal.throwIfAborted()
    return scanned
  }

  private readExternalAudio(path: string, format: AudioFormat, identity: FileIdentity, requireAudio = false) {
    return this.readFile(path, format, identity, requireAudio).catch(error => {
      if (error.code || error.message === changedDownload) throw error
      throw new Error('Формат аудио не поддерживается или файл повреждён.')
    })
  }

  private async readFile(path: string, format: Track['format'], expected?: FileIdentity, requireAudio = false): Promise<ScannedFile> {
    const identity = await lstat(path, { bigint: true })
    if (expected && !sameFile(expected, identity)) throw new Error(changedDownload)
    if (!identity.isFile() || identity.size === 0n) throw new Error('Invalid file')

    const tags = await parseFile(path, metadataOptions).catch(async error => {
      const withoutTag = format === 'mp3' && await readOversizedId3(path, identity)
      if (withoutTag) return withoutTag
      throw error
    })
    const container = tags.format.container?.toLowerCase()
    if (format === 'flac' ? container !== 'flac' : container !== 'mpeg' || !tags.format.codec?.endsWith('Layer 3')) {
      throw new Error('Unexpected audio format')
    }
    if (requireAudio && (!((tags.format.sampleRate ?? 0) > 0) || !((tags.format.bitrate ?? 0) > 0))) {
      throw new Error('Missing audio data')
    }
    if (await realpath(path) !== path || !sameFile(identity, await lstat(path, { bigint: true }))) {
      throw new Error(expected ? changedDownload : 'File changed during import')
    }

    const { title, artist, album, genre } = tags.common
    const { duration } = tags.format
    return {
      path,
      identity: fileIdentity(identity),
      tags: {
        title: title?.trim() || basename(path, extname(path)),
        artist: artist?.trim() || null,
        album: album?.trim() || null,
        genres: genre ?? [],
        durationSeconds: duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : null,
        format,
      },
    }
  }
}
