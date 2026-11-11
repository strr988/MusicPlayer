import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { playerOrigin } from '../../shared/contracts'
import type { DownloadJob, MetadataEdits } from '../../shared/music-sources'
import { artworkMime, maxImageBytes } from '../artwork'
import type { DownloadIntegrity, Library } from '../library'
import { maxAudioBytes } from './archive'
import type { MusicSourceProvider } from './archive'

type Analysis = Awaited<ReturnType<MusicSourceProvider['analyze']>>
type Link = ReturnType<MusicSourceProvider['recognize']>
export const downloadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const maxActive = 8
const maxJobs = 100
const maxStorage = 2 * 1024 * 1024 * 1024
const manifestLimit = 24 * 1024

interface Job {
  snapshot: DownloadJob
  link: Link
  analysis?: Analysis
  customCover?: Buffer
  selectedCover?: Buffer | null
  controller: AbortController
  path?: string
  importing?: { controller: AbortController; completion: Promise<boolean> }
  integrity?: DownloadIntegrity
  size?: number
  committing?: boolean
}

export function metadataEdits(value: unknown): MetadataEdits {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректные изменения.')
  const input = value as Record<string, unknown>
  const result: MetadataEdits = {}
  for (const [key, text] of Object.entries(input)) {
    switch (key) {
      case 'title': case 'artist': case 'album':
        if (text === null) result[key] = null
        else if (typeof text === 'string' && text.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(text)) {
          result[key] = text.trim() || null
        } else throw new Error('Проверьте текст метаданных (до 240 символов).')
        break
      case 'durationSeconds':
        if (text !== null && (typeof text !== 'number' || !Number.isFinite(text) || text <= 0 || text > 86400)) {
          throw new Error('Проверьте длительность записи.')
        }
        result.durationSeconds = text
        break
      case 'artwork':
        if (text !== 'remove' && text !== 'custom') throw new Error('Некорректная обложка.')
        result.artwork = text
        break
      default: throw new Error('Неизвестное поле метаданных.')
    }
  }
  return result
}

async function ownedDirectory(path: string): Promise<boolean> {
  return (await lstat(path)).isDirectory() && await realpath(path) === path
}

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  if (!(await lstat(path)).isFile() || await realpath(path) !== path) throw new Error('Файл недоступен.')
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > limit) throw new Error('Файл слишком большой.')
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

function message(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'Недостаточно места для сохранения файла.'
  if (code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ECONNREFUSED') {
    return 'Ошибка сети. Проверьте подключение к Archive.org.'
  }
  if (code) return 'Не удалось прочитать или сохранить данные загрузки.'
  if (error instanceof Error && /^[А-ЯЁ]/u.test(error.message)) return error.message
  return 'Не удалось обработать запись.'
}

export class DownloadManager {
  private readonly jobs = new Map<string, Job>()
  private pending = Promise.resolve()
  private active = 0
  private stopped = false
  private root = ''
  private readonly prepared: Promise<boolean>

  constructor(private readonly profile: string, private readonly provider: MusicSourceProvider,
    private readonly library: Pick<Library, 'getExternalTrackId' | 'validateDownloadedAudio' | 'importDownload'>) {
    this.prepared = this.prepare().then(() => true, () => false)
  }

  private async prepare(): Promise<void> {
    const path = join(await realpath(this.profile), 'music-downloads')
    await mkdir(path, { recursive: true })
    if (!await ownedDirectory(path)) throw new Error('Каталог загрузок недоступен.')
    this.root = path
    const directory = await readdir(path, { withFileTypes: true })
    for (const entry of directory) {
      if (!entry.isDirectory()) continue
      const folder = join(path, entry.name)
      if (/^\.stage-[a-zA-Z0-9]{6}$/.test(entry.name)) {
        await this.cleanStage(folder).catch(() => undefined)
      } else if (downloadIdPattern.test(entry.name) && this.jobs.size < maxJobs) {
        await this.restore(entry.name, folder).catch(() => undefined)
      }
    }
  }

  private async restore(id: string, directory: string): Promise<void> {
    if (!await ownedDirectory(directory)) return
    const saved = JSON.parse((await boundedFile(join(directory, 'download.json'), manifestLimit)).toString()) as
      Pick<DownloadJob, 'metadata' | 'edits'> & { sha1: string; size: number }
    const metadata = saved.metadata
    const format = metadata?.downloadFormat
    if (!metadata || metadata.provider !== this.provider.id || (format !== 'mp3' && format !== 'flac') ||
        !/^[a-f0-9]{40}$/.test(saved.sha1) || !Number.isSafeInteger(saved.size) ||
        saved.size <= 0 || saved.size > maxAudioBytes) return
    const link = this.provider.recognize(metadata.originalUrl)
    if (metadata.sourceId !== `${link.item}/${link.file}`) return
    const path = join(directory, `audio.${format}`)
    const stat = await lstat(path).catch(() => undefined)
    const available = stat?.isFile() && stat.size === saved.size && await realpath(path).catch(() => undefined) === path
    const edits = metadataEdits(saved.edits ?? {})
    const cover = await boundedFile(join(directory, 'cover.img'), maxImageBytes).catch(() => null)
    const selectedCover = cover && artworkMime(cover) ? cover : null
    const snapshot: DownloadJob = {
      id, url: link.url, status: available ? 'completed' : 'failed', metadata, edits,
      trackId: this.library.getExternalTrackId(metadata),
      coverUrl: selectedCover ? `${playerOrigin}/download-artwork/${id}` : undefined,
      error: available ? undefined : 'Загруженный файл отсутствует или его размер изменился.',
      canDismiss: false,
    }
    this.jobs.set(id, {
      snapshot, link, selectedCover, path, size: stat?.isFile() ? stat.size : undefined,
      integrity: { size: saved.size, sha1: saved.sha1 }, controller: new AbortController(),
    })
  }

  private async ready(): Promise<void> {
    if (!await this.prepared) throw new Error('Каталог загрузок недоступен.')
    if (this.stopped) throw new Error('Приложение закрывается.')
  }

  async list(): Promise<DownloadJob[]> {
    await this.ready()
    return [...this.jobs.values()].reverse().map(job => {
      const { status, metadata } = job.snapshot
      if (status !== 'ready' || !metadata) return { ...job.snapshot, importing: !!job.importing }
      const trackId = this.library.getExternalTrackId(metadata)
      return { ...job.snapshot, trackId, duplicate: trackId !== undefined || this.hasDownload(job, metadata.sourceId) }
    })
  }

  private enqueue(job: Job, operation: () => Promise<void>): void {
    this.active++
    this.pending = this.pending.then(async () => {
      try {
        job.controller.signal.throwIfAborted()
        await operation()
      } catch (error) {
        job.snapshot.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
        job.snapshot.progress = undefined
        if (job.snapshot.status === 'failed') job.snapshot.error = message(error)
      } finally {
        this.active--
      }
    })
  }

  private assertCapacity(): void {
    if (this.active >= maxActive) throw new Error('Очередь заполнена. Дождитесь выполнения задач.')
  }

  private async stage(operation: (directory: string) => Promise<void>): Promise<void> {
    if (!await ownedDirectory(this.root)) throw new Error('Каталог загрузок недоступен.')
    const directory = await mkdtemp(join(this.root, '.stage-'))
    try { await operation(directory) } finally {
      await this.cleanStage(directory).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  private async cleanStage(directory: string): Promise<void> {
    if (dirname(directory) === this.root && /^\.stage-[a-zA-Z0-9]{6}$/.test(basename(directory)) &&
        await ownedDirectory(directory)) await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  }

  async analyze(value: unknown): Promise<void> {
    const link = this.provider.recognize(value)
    await this.ready()
    this.assertCapacity()
    if (this.jobs.size >= maxJobs) throw new Error('Достигнут предел журнала загрузок. Закройте ненужные задачи.')
    const id = randomUUID()
    const job: Job = { snapshot: { id, url: link.url, status: 'waiting' }, link, controller: new AbortController() }
    this.jobs.set(id, job)
    this.enqueue(job, async () => {
      job.snapshot.status = 'analyzing'
      const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(75_000)])
      await this.stage(async directory => {
        job.analysis = await this.provider.analyze(link, directory, signal)
      })
      signal.throwIfAborted()
      const { metadata, cover } = job.analysis!
      Object.assign(job.snapshot, {
        metadata, status: 'ready',
        coverUrl: cover ? `${playerOrigin}/download-artwork/${id}` : undefined,
      })
    })
  }

  private hasDownload(job: Job, sourceId: string): boolean {
    return [...this.jobs.values()].some(other => other !== job && other.snapshot.metadata?.sourceId === sourceId &&
      (other.snapshot.status === 'completed' || other.snapshot.edits !== undefined &&
        ['waiting', 'downloading', 'processing'].includes(other.snapshot.status)))
  }

  async confirm(id: string, value: unknown): Promise<void> {
    const edits = metadataEdits(value)
    await this.ready()
    this.assertCapacity()
    const job = this.get(id)
    const analysis = job.analysis
    if (job.snapshot.status !== 'ready' || !analysis?.original || !analysis.metadata.downloadFormat) {
      throw new Error('Запись недоступна для загрузки.')
    }
    if (this.library.getExternalTrackId(analysis.metadata) || this.hasDownload(job, analysis.metadata.sourceId)) {
      throw new Error('Эта запись уже есть в библиотеке или менеджере загрузок.')
    }
    if (edits.artwork === 'custom' && !job.customCover) throw new Error('Выберите файл обложки.')
    job.selectedCover = edits.artwork === 'remove' ? null : edits.artwork === 'custom' ? job.customCover! : analysis.cover
    job.snapshot.edits = edits
    job.snapshot.status = 'waiting'
    this.enqueue(job, () => this.download(job, analysis))
  }

  private async download(job: Job, analysis: Analysis): Promise<void> {
    const format = analysis.metadata.downloadFormat!
    const existingBytes = [...this.jobs.values()].reduce((total, entry) => total + (entry.size ?? 0), 0)
    if (existingBytes + analysis.original!.size > maxStorage) throw new Error('Достигнут предел хранилища загрузок (2 ГиБ).')
    job.snapshot.status = 'downloading'
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(10 * 60_000)])
    await this.stage(async directory => {
      const name = `audio.${format}`
      const partial = join(directory, 'audio.part')
      await this.provider.download(job.link, analysis, partial, signal, progress => { job.snapshot.progress = progress })
      signal.throwIfAborted()
      job.snapshot.status = 'processing'
      job.snapshot.progress = undefined
      const { size, sha1 } = analysis.original!
      await this.library.validateDownloadedAudio(partial, format, { size, sha1 }, signal)
      signal.throwIfAborted()
      const { id, metadata, edits } = job.snapshot
      const options = { flag: 'wx', signal, flush: true }
      await writeFile(join(directory, 'download.json'), JSON.stringify({ metadata, edits, size, sha1 }), options)
      if (job.selectedCover) await writeFile(join(directory, 'cover.img'), job.selectedCover, options)
      const destination = join(this.root, id)
      await rename(partial, join(directory, name))
      signal.throwIfAborted()
      job.committing = true
      await rename(directory, destination)
      job.path = join(destination, name)
      job.size = size
      job.integrity = { size, sha1 }
      job.snapshot.status = 'completed'
      job.snapshot.coverUrl = job.selectedCover ? `${playerOrigin}/download-artwork/${id}` : undefined
      job.analysis = undefined
      job.customCover = undefined
    })
  }

  cancel(id: string): void {
    const job = this.get(id)
    if (job.importing) {
      job.importing.controller.abort()
      return
    }
    if (!job.committing && ['waiting', 'analyzing', 'ready', 'downloading', 'processing'].includes(job.snapshot.status)) {
      job.controller.abort()
      job.snapshot.status = 'cancelled'
      job.snapshot.progress = undefined
    }
  }

  dismiss(id: string): void {
    const job = this.get(id)
    if (job.snapshot.canDismiss === false || !['failed', 'cancelled', 'ready'].includes(job.snapshot.status)) {
      throw new Error('Эту задачу нельзя закрыть.')
    }
    this.cancel(id)
    this.jobs.delete(id)
  }

  async setCover(id: string, path: string): Promise<string> {
    const job = this.get(id)
    if (job.snapshot.status !== 'ready') throw new Error('Изменение обложки недоступно.')
    const cover = await boundedFile(await realpath(path), maxImageBytes)
    if (!artworkMime(cover)) throw new Error('Выберите статичный PNG или JPEG до 2 МиБ и 2048 × 2048.')
    if (job.snapshot.status !== 'ready') throw new Error('Изменение обложки недоступно.')
    job.customCover = cover
    return `${playerOrigin}/download-artwork/${id}/custom`
  }

  cover(id: string, custom: boolean): Buffer | null {
    const job = this.jobs.get(id)
    if (!job) return null
    return custom ? job.customCover ?? null : job.snapshot.status === 'completed' ?
      job.selectedCover ?? null : job.analysis?.cover ?? null
  }

  async file(id: string): Promise<string> {
    const { path, snapshot } = this.get(id)
    if (!path || snapshot.status !== 'completed' || !await ownedDirectory(dirname(path)) ||
        !(await lstat(path)).isFile() || await realpath(path) !== path) {
      throw new Error('Загруженный файл недоступен.')
    }
    return path
  }

  addToLibrary(id: string): Promise<boolean> {
    if (this.stopped) throw new Error('Приложение закрывается.')
    const job = this.get(id)
    if (job.importing) return job.importing.completion
    const controller = new AbortController()
    const completion = this.file(id).then(async path => {
      job.snapshot.trackId = await this.library.importDownload(path, job.snapshot.metadata!,
        job.snapshot.edits ?? {}, job.selectedCover ?? null, job.integrity!, controller.signal)
      return true
    }).catch(error => {
      if (controller.signal.aborted) return false
      throw new Error(message(error))
    }).finally(() => { job.importing = undefined })
    job.importing = { controller, completion }
    return completion
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const job of this.jobs.values()) {
      job.controller.abort()
      job.importing?.controller.abort()
    }
    await this.prepared
    await this.pending
    await Promise.allSettled([...this.jobs.values()].map(job => job.importing?.completion))
  }

  private get(id: string): Job {
    const job = this.jobs.get(id)
    if (!job) throw new Error('Задача не найдена.')
    return job
  }
}
