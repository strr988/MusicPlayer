import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModuleChange, ModulePhase, ModuleStatus } from '../../shared/modules'

export interface ModuleRelease {
  version: string
}

export interface ModuleDefinition<Release extends ModuleRelease> {
  id: string
  executable: string
  supported: boolean
  maxBytes: number
  versionPattern: RegExp
  release(version: string | null, signal: AbortSignal): Promise<Release>
  download(release: Release, signal: AbortSignal, progress: (bytes: number, total: number) => void):
    Promise<{ content: Buffer; proof: string }>
  verify(content: Buffer, proof: string): Promise<void>
  test(content: Buffer, version: string, directory: string, signal: AbortSignal): Promise<void>
}

interface Installed {
  slot: string
  version: string
  proof: string
}

interface Registry {
  schema: 1
  current: Installed | null
  previous: Installed | null
  latest: string | null
  checked: ModuleStatus['lastChecked']
}

type Confirm = (version: string, signal: AbortSignal) => Promise<boolean>
const slotPattern = /^release-[a-f0-9-]{36}$/
const empty = (): Registry => ({ schema: 1, current: null, previous: null, latest: null, checked: null })

function newer(candidate: string, current: string): boolean {
  const parts = current.split('.').map(Number)
  for (const [index, value] of candidate.split('.').map(Number).entries()) {
    const difference = value - (parts[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

async function exists(path: string) {
  return lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
}

async function ownedDirectory(path: string) {
  return (await lstat(path)).isDirectory() && await realpath(path) === path
}

export class ModuleManager<Release extends ModuleRelease> {
  private registry = empty()
  private readonly ready: Promise<void>
  private root = ''
  private storageError = false
  private registryDamaged = false
  private health?: { fingerprint: string; diagnostic: string | null }
  private failedSlot?: string
  private phase: ModulePhase | null = null
  private progress: ModuleStatus['progress'] = null
  private message: ModuleStatus['message'] = null
  private operation?: { controller: AbortController; completion: Promise<void>; exclusive: boolean }
  private stopped = false

  constructor(profile: string, private readonly definition: ModuleDefinition<Release>) {
    this.ready = this.prepare(profile).catch(() => { this.storageError = true })
  }

  private async prepare(profile: string) {
    if (!this.definition.supported) return
    const modules = join(await realpath(profile), 'modules')
    await mkdir(modules, { recursive: true })
    if (!await ownedDirectory(modules)) throw new Error()
    this.root = join(modules, this.definition.id)
    await mkdir(this.root, { recursive: true })
    if (!await ownedDirectory(this.root)) throw new Error()
    const next = join(this.root, 'registry.next')
    if ((await exists(next))?.isFile()) await rm(next, { force: true })
    const path = join(this.root, 'registry.json')
    const stat = await exists(path)
    if (stat) {
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error()
      const content = await readFile(path, 'utf8')
      try { this.registry = this.parseRegistry(JSON.parse(content)) }
      catch { this.registryDamaged = true }
    }
    if (!this.registryDamaged) await this.clean().catch(() => undefined)
  }

  private parseRegistry(value: Registry): Registry {
    const version = (input: unknown) => typeof input === 'string' && this.definition.versionPattern.test(input)
    const installed = (input: Installed | null) => input === null || (input &&
      typeof input.slot === 'string' && slotPattern.test(input.slot) && version(input.version) &&
      typeof input.proof === 'string' && input.proof.length > 0 && input.proof.length <= 24 * 1024)
    if (value?.schema !== 1 || !installed(value.current) || !installed(value.previous) ||
        value.previous && (!value.current || value.previous.slot === value.current.slot) ||
        value.latest !== null && !version(value.latest) ||
        value.checked !== null && (!value.checked || typeof value.checked.date !== 'string' ||
          !Number.isFinite(Date.parse(value.checked.date)) || typeof value.checked.ok !== 'boolean')) {
      throw new Error('Некорректные данные установки.')
    }
    return value
  }

  private async clean() {
    if (!await ownedDirectory(this.root)) return
    const kept = [this.registry.current?.slot, this.registry.previous?.slot]
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && slotPattern.test(entry.name) && !kept.includes(entry.name)) {
        const path = join(this.root, entry.name)
        if (await ownedDirectory(path)) await rm(path, { recursive: true, force: true, maxRetries: 5 })
      }
    }
  }

  private async save(registry: Registry) {
    if (!await ownedDirectory(this.root)) throw new Error('Хранилище модуля недоступно.')
    const temporary = join(this.root, 'registry.next')
    const handle = await open(temporary, 'wx')
    try {
      try {
        await handle.writeFile(JSON.stringify(registry))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, join(this.root, 'registry.json'))
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new Error('Не удалось сохранить изменения модуля.')
    }
    this.registry = registry
  }

  private async file(entry: Installed) {
    const directory = join(this.root, entry.slot)
    if (!await ownedDirectory(this.root) || !await ownedDirectory(directory)) throw new Error()
    const path = join(directory, this.definition.executable)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size === 0 || stat.size > this.definition.maxBytes) throw new Error()
    return { path, stat }
  }

  private async verified(entry: Installed): Promise<Buffer> {
    const { path, stat } = await this.file(entry)
    const handle = await open(path, 'r')
    try {
      const content = Buffer.alloc(stat.size)
      const { bytesRead } = await handle.read(content, 0, content.length, 0)
      if (bytesRead !== stat.size || (await handle.stat()).size !== stat.size) throw new Error()
      await this.definition.verify(content, entry.proof)
      return content
    } finally {
      await handle.close()
    }
  }

  private async diagnose(entry: Installed) {
    try {
      const { stat } = await this.file(entry)
      const fingerprint = [entry.slot, stat.size, stat.ino, stat.mtimeMs, stat.ctimeMs].join('/')
      if (this.health?.fingerprint === fingerprint) return this.health.diagnostic
      const diagnostic = await this.verified(entry).then(() => null, () => 'Проверка целостности не пройдена. Переустановите модуль.')
      this.health = { fingerprint, diagnostic }
      return diagnostic
    } catch {
      return 'Файл модуля повреждён или недоступен. Переустановите модуль.'
    }
  }

  async status(): Promise<ModuleStatus> {
    await this.ready
    const { current, previous, latest, checked } = this.registry
    const diagnostic = this.storageError ? 'Хранилище модуля недоступно.' :
      this.registryDamaged ? 'Данные установки повреждены. Переустановите модуль.' :
      current && current.slot === this.failedSlot ? 'Модуль не запускается. Попробуйте переустановить его.' :
      current ? await this.diagnose(current) : null
    return {
      state: !this.definition.supported ? 'unsupported' : diagnostic ? 'damaged' : current ? 'installed' : 'missing',
      installedVersion: current?.version ?? null, previousVersion: previous?.version ?? null,
      latestVersion: latest, updateAvailable: !!(current && latest && newer(latest, current.version)),
      lastChecked: checked, phase: this.phase, progress: this.progress, diagnostic, message: this.message,
    }
  }

  assertAvailableForDownloads() {
    if (this.operation?.exclusive) throw new Error('Дождитесь завершения операции с модулем.')
  }

  async binary() {
    await this.ready
    if (!this.definition.supported) throw new Error('Модуль доступен на Windows x64.')
    if (this.storageError || this.registryDamaged) throw new Error('Хранилище модуля недоступно или повреждено.')
    const entry = this.registry.current
    if (!entry) throw new Error('Установите yt-dlp в разделе «Настройки → Модули».')
    try {
      return { content: await this.verified(entry), version: entry.version, reportFailure: () => {
        this.failedSlot = entry.slot
      } }
    } catch {
      this.health = undefined
      throw new Error('yt-dlp повреждён. Переустановите модуль в настройках.')
    }
  }

  check() {
    return this.run(null, async signal => {
      this.phase = 'checking'
      await this.latest(signal)
    })
  }

  change(action: ModuleChange, hasActiveDownloads: () => boolean, confirm: Confirm) {
    return this.run(action, async signal => {
      if (hasActiveDownloads()) throw new Error('Дождитесь завершения активных задач в «Загрузках».')
      const { current, previous } = this.registry
      if (action === 'remove' || action === 'rollback') {
        const target = action === 'remove' ? current : previous
        if (!target) throw new Error('Версия модуля недоступна.')
        this.phase = 'confirming'
        if (!await confirm(target.version, signal)) return this.cancelled()
        signal.throwIfAborted()
        if (action === 'rollback') {
          this.phase = 'verifying'
          await this.verified(target).catch(() => { throw new Error('Предыдущая версия повреждена.') })
          signal.throwIfAborted()
        }
        this.phase = 'applying'
        await this.save({ ...this.registry, current: action === 'remove' ? null : target, previous: null })
        this.message = { text: action === 'remove' ? 'Модуль удалён.' : `Восстановлена версия ${target.version}.`, error: false }
        return
      }

      const repairing = action === 'reinstall' && this.registryDamaged
      if (!repairing && (action === 'install' ? current || this.registryDamaged : !current)) {
        throw new Error('Состояние модуля изменилось. Откройте настройки снова.')
      }
      this.phase = 'checking'
      const release = repairing ? await this.definition.release(null, signal) :
        action === 'reinstall' ? await this.definition.release(current!.version, signal) : await this.latest(signal)
      if (action === 'update' && !newer(release.version, current!.version)) throw new Error('Новая версия недоступна.')
      signal.throwIfAborted()
      this.phase = 'confirming'
      if (!await confirm(release.version, signal)) return this.cancelled()
      signal.throwIfAborted()
      this.phase = 'downloading'
      const { content, proof } = await this.definition.download(release, signal, (bytes, total) => {
        this.progress = { bytes, total }
      })
      this.progress = null
      this.phase = 'verifying'
      await this.definition.verify(content, proof)
      signal.throwIfAborted()
      const slot = 'release-' + randomUUID()
      const directory = join(this.root, slot)
      if (!await ownedDirectory(this.root)) throw new Error('Хранилище модуля недоступно.')
      await mkdir(directory)
      const installed = { slot, version: release.version, proof }
      try {
        await writeFile(join(directory, this.definition.executable), content, { flag: 'wx', flush: true, signal })
        this.phase = 'testing'
        await this.definition.test(content, release.version, directory, signal)
        const backup = action === 'update' && current && current.slot !== this.failedSlot &&
          await this.verified(current).then(() => true, () => false) ? current : previous
        signal.throwIfAborted()
        this.phase = 'applying'
        await this.save({ ...this.registry, current: installed, previous: backup, ...(repairing && {
          latest: release.version, checked: { date: new Date().toISOString(), ok: true },
        }) })
        this.registryDamaged = false
        this.message = { text: `${this.definition.id} ${release.version} готов к работе.`, error: false }
      } finally {
        if (this.registry.current?.slot !== slot && await ownedDirectory(directory).catch(() => false)) {
          await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
        }
      }
    })
  }

  private async latest(signal: AbortSignal) {
    let release: Release
    try {
      release = await this.definition.release(null, signal)
    } catch (error) {
      if (!signal.aborted) await this.recordCheck(this.registry.latest, false)
      throw error
    }
    signal.throwIfAborted()
    await this.recordCheck(release.version, true)
    return release
  }

  private async recordCheck(latest: string | null, ok: boolean) {
    const registry = { ...this.registry, latest, checked: { date: new Date().toISOString(), ok } }
    if (this.registryDamaged) this.registry = registry
    else await this.save(registry)
  }

  private cancelled() {
    this.message = { text: 'Операция отменена.', error: false }
  }

  private run(action: ModuleChange | null, task: (signal: AbortSignal) => Promise<void>) {
    if (this.stopped || this.operation) throw new Error('Другая операция с модулем уже выполняется.')
    const controller = new AbortController()
    const completion = this.ready.then(async () => {
      this.message = null
      if (!this.definition.supported) throw new Error('Модуль доступен на Windows x64.')
      if (this.storageError) throw new Error('Хранилище модуля недоступно.')
      controller.signal.throwIfAborted()
      await task(controller.signal)
    }).catch(error => {
      if (controller.signal.aborted) this.cancelled()
      else {
        const detail = error instanceof ModuleError ? error.message :
          error instanceof Error && !('code' in error) && error.message ? error.message : 'Не удалось выполнить операцию с модулем.'
        const version = this.registry.current?.version
        const text = action === 'update' && version ? `Не удалось обновить модуль. ${detail} Активна версия ${version}.` : detail
        this.message = { text, error: true }
      }
    }).finally(async () => {
      if (action && this.root && !this.storageError && !this.registryDamaged) await this.clean().catch(() => undefined)
      this.operation = undefined
      this.phase = null
      this.progress = null
    })
    this.operation = { controller, completion, exclusive: action !== null }
    return completion
  }

  cancel() {
    if (this.phase !== 'applying') this.operation?.controller.abort()
  }

  async stop() {
    this.stopped = true
    this.cancel()
    await this.operation?.completion
    await this.ready
  }
}

export class ModuleError extends Error {}
