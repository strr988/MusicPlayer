import { randomUUID } from 'node:crypto'
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
import type { RescanResult, ShortcutAction } from '../shared/contracts'

interface ScannedFile {
  path: string
  tags: Omit<Track, 'id'>
  identity: FileIdentity
}

type CompletedImport = Extract<ImportResult, { status: 'complete' }>
class FormatMismatch extends Error {}
const metadataLimit = 8 * 1024 * 1024
const metadataOptions = { skipCovers: true, maxMemoryAllocation: metadataLimit, maxMetadataEntries: 10_000 }

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

  constructor(databasePath: string) {
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
  getWavePulse(): number { return this.store.getWavePulse() }
  setWavePulse(intensity: number): void { this.store.setWavePulse(intensity) }
  getMiniPinned(): boolean { return this.store.getMiniPinned() }
  setMiniPinned(pinned: boolean): void { this.store.setMiniPinned(pinned) }
  getShortcuts() { return this.store.getShortcuts() }
  setShortcut(action: ShortcutAction, accelerator: string | null): void { this.store.setShortcut(action, accelerator) }
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
    return this.enqueueScan(async () => {
      const root = await realpath(folder)
      if (!(await lstat(root)).isDirectory()) throw new Error('Expected an import folder')
      const { processed, issues } = await this.scanFolder(root)
      return { status: 'complete', tracks: this.getTracks(), processed, issues }
    })
  }

  rescanLibrary(): Promise<RescanResult> {
    return this.enqueueScan(async () => {
      const folders = this.store.getImportedFolders()
      if (!folders.length) return { status: 'no-folders' }
      let processed = 0
      const issues: ImportIssue[] = []
      for (const root of folders) {
        const name = basename(root) || 'Корневая папка'
        const result = await this.scanFolder(root)
        processed += result.processed
        for (const issue of result.issues) {
          issues.push({ ...issue, entry: issue.entry === '.' ? name : `${name}/${issue.entry}` })
        }
      }
      return { status: 'complete', tracks: this.getTracks(), processed, issues }
    })
  }

  private enqueueScan<T>(operation: () => Promise<T>): Promise<T> {
    const scan = this.pendingScan.then(operation)
    this.pendingScan = scan.then(() => undefined, () => undefined)
    return scan
  }

  private async scanFolder(root: string): Promise<Pick<CompletedImport, 'processed' | 'issues'>> {
    const issues: ImportIssue[] = []
    const files: ScannedFile[] = []

    const scan = async (directory: string): Promise<void> => {
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
        } catch (error) {
          issues.push({ entry: relative(root, path), reason: error instanceof FormatMismatch ? 'format-mismatch' : 'file-unreadable' })
        }
      }
    }

    await scan(root)
    await this.saveScan(root, files)
    return { processed: files.length, issues }
  }

  private async saveScan(root: string, files: ScannedFile[]): Promise<void> {
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

  private async readFile(path: string, format: Track['format']): Promise<ScannedFile> {
    const identity = await lstat(path, { bigint: true })
    if (!identity.isFile() || identity.size === 0n) throw new Error('Invalid file')

    const tags = await parseFile(path, metadataOptions).catch(async error => {
      const withoutTag = format === 'mp3' && await readOversizedId3(path, identity)
      if (withoutTag) return withoutTag
      throw error
    })
    const container = tags.format.container?.toLowerCase()
    if (!container) throw new Error('Unrecognized audio')
    if (format === 'flac' ? container !== 'flac' : container !== 'mpeg' || !tags.format.codec?.endsWith('Layer 3')) {
      throw new FormatMismatch('Audio format does not match the file extension')
    }
    if (await realpath(path) !== path || !sameFile(identity, await lstat(path, { bigint: true }))) {
      throw new Error('File changed during import')
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
