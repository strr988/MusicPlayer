import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { parseFile } from 'music-metadata'
import type { ImportIssue, ImportResult, Track } from '../shared/contracts'

interface LocalSource {
  id: string
  trackId: string
  path: string
  format: Track['format']
  identity: BigIntStats
}

export function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

function isWithin(root: string, file: string): boolean {
  const name = relative(root, file)
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name)
}

export class Library {
  private readonly tracks = new Map<string, Track>()
  private readonly sources = new Map<string, LocalSource>()
  private readonly sourceIdsByPath = new Map<string, string>()
  private readonly sourceIdsByTrack = new Map<string, string>()

  getTracks(): Track[] {
    return [...this.tracks.values()]
  }

  async getAvailableSource(id: string): Promise<LocalSource | undefined> {
    const source = this.sources.get(id)
    if (!source) return undefined
    try {
      if (await realpath(source.path) === source.path &&
          sameFile(source.identity, await lstat(source.path, { bigint: true })) &&
          this.sources.get(id) === source) return source
    } catch {
      return undefined
    }
  }

  getSourceId(trackId: string): string | undefined {
    return this.sourceIdsByTrack.get(trackId)
  }

  async importFolder(folder: string): Promise<Extract<ImportResult, { status: 'complete' }>> {
    const root = await realpath(folder)
    const issues: ImportIssue[] = []
    let processed = 0

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
          await this.importFile(canonical, extension === '.mp3' ? 'mp3' : 'flac')
          processed++
        } catch {
          issues.push({ entry: relative(root, path), reason: 'file-unreadable' })
        }
      }
    }

    await scan(root)
    return { status: 'complete', tracks: this.getTracks(), processed, issues }
  }

  private async importFile(path: string, format: Track['format']): Promise<void> {
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

    const previousId = this.sourceIdsByPath.get(path)
    const previous = previousId && this.sources.get(previousId)
    const trackId = previous ? previous.trackId : randomUUID()
    const sourceId = previous && sameFile(previous.identity, identity) ? previous.id : randomUUID()
    const { title, artist, album, genre } = tags.common
    const { duration } = tags.format

    this.tracks.set(trackId, {
      id: trackId,
      title: title?.trim() || basename(path, extname(path)),
      artist: artist?.trim() || null,
      album: album?.trim() || null,
      genres: genre ?? [],
      durationSeconds: duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : null,
      format,
    })
    // A replaced file needs a fresh media URL so Chromium drops its previous buffer.
    if (previous && previous.id !== sourceId) this.sources.delete(previous.id)
    this.sources.set(sourceId, { id: sourceId, trackId, path, format, identity })
    this.sourceIdsByPath.set(path, sourceId)
    this.sourceIdsByTrack.set(trackId, sourceId)
  }
}
