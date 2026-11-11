import { randomUUID } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { parseFile } from 'music-metadata'
import type { ImportIssue, ImportResult, Track } from '../shared/contracts'
import { LibraryStore } from './library-store'
import type { LocalSource, ScanEntry } from './library-store'
import { fileIdentity, moveKey, sameFile, sameIdentity } from './local-file'
import type { FileIdentity } from './local-file'

interface ScannedFile {
  path: string
  tags: Omit<Track, 'id'>
  identity: FileIdentity
}

type CompletedImport = Extract<ImportResult, { status: 'complete' }>

function isWithin(root: string, file: string): boolean {
  const name = relative(root, file)
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name)
}

async function openVerifiedFile(source: LocalSource): Promise<FileHandle | undefined> {
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

export class Library {
  private readonly store: LibraryStore
  private pendingScan = Promise.resolve()

  constructor(databasePath: string) {
    this.store = new LibraryStore(databasePath)
  }

  close(): void {
    this.store.close()
  }

  getTracks(): Track[] {
    return this.store.getTracks()
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
        } catch {
          issues.push({ entry: relative(root, path), reason: 'file-unreadable' })
        }
      }
    }

    await scan(root)
    await this.saveScan(root, files)
    return { status: 'complete', tracks: this.getTracks(), processed: files.length, issues }
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

    const tags = await parseFile(path, {
      skipCovers: true,
      maxMemoryAllocation: 8 * 1024 * 1024,
      maxMetadataEntries: 10_000,
    })
    const container = tags.format.container?.toLowerCase()
    if (format === 'flac' ? container !== 'flac' : container !== 'mpeg' || !tags.format.codec?.endsWith('Layer 3')) {
      throw new Error('Unexpected audio format')
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
