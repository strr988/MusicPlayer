import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { ModuleManager } from '../src/main/modules/module-manager'
import { parseRelease, validateAssetUrl, verifyYtDlp } from '../src/main/modules/yt-dlp-release'

const old = '2026.10.26'
const next = '2026.11.13'
const profiles: string[] = []
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const idle = () => false
const confirm = async () => true

afterEach(async () => {
  await Promise.all(profiles.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5 })))
})

async function setup() {
  const profile = await mkdtemp(join(tmpdir(), 'music-player-modules-'))
  profiles.push(profile)
  const definition = {
    id: 'yt-dlp', executable: 'yt-dlp.exe', supported: true, maxBytes: 1024, versionPattern: /^\d{4}\.\d{2}\.\d{2}$/,
    release: vi.fn(async (version: string | null) => ({ version: version ?? old })),
    download: vi.fn(async ({ version }: { version: string }, _signal: AbortSignal,
      progress: (bytes: number, total: number) => void) => {
      const content = Buffer.from(version)
      progress(content.length, content.length)
      return { content, proof: sha256(content) }
    }),
    verify: vi.fn(async (content: Buffer, proof: string) => {
      if (sha256(content) !== proof) throw new Error('Контрольная сумма не совпадает.')
    }),
    test: vi.fn(async (content: Buffer, version: string, _directory: string, _signal: AbortSignal) => {
      if (content.toString() !== version) throw new Error('Версия не совпадает.')
    }),
  }
  const manager = new ModuleManager(profile, definition)
  const root = join(profile, 'modules', 'yt-dlp')
  return { manager, definition, profile, root }
}

test('checks separately from installation and persists the version and last result', async () => {
  const { manager, definition, profile } = await setup()
  expect((await manager.status()).state).toBe('missing')
  await manager.check()
  expect(await manager.status()).toMatchObject({
    state: 'missing', latestVersion: old, lastChecked: { date: expect.any(String), ok: true },
  })
  expect(definition.download).not.toHaveBeenCalled()
  const confirmation = vi.fn(async () => false)
  await manager.change('install', idle, confirmation)
  expect(confirmation).toHaveBeenCalledWith(old, expect.any(AbortSignal))
  expect(definition.download).not.toHaveBeenCalled()
  await manager.change('install', idle, confirm)
  expect(definition.test).toHaveBeenCalledOnce()
  expect(await new ModuleManager(profile, definition).status()).toMatchObject({
    state: 'installed', installedVersion: old, latestVersion: old, lastChecked: { ok: true },
  })
})

test('reports an offline check and preserves the usable release', async () => {
  const { manager, definition } = await setup()
  await manager.change('install', idle, confirm)
  definition.release.mockRejectedValueOnce(new Error('Нет сети.'))
  await manager.check()
  expect(await manager.status()).toMatchObject({
    state: 'installed', installedVersion: old, latestVersion: old, lastChecked: { ok: false },
    message: { text: 'Нет сети.', error: true },
  })
  expect((await manager.binary()).version).toBe(old)
})

test('rejects bad bytes and incompatible versions without replacing the working module', async () => {
  const { manager, definition, root } = await setup()
  await manager.change('install', idle, confirm)
  const files = await readdir(root)
  definition.release.mockResolvedValue({ version: next })
  await manager.check()
  expect(await manager.status()).toMatchObject({ installedVersion: old, latestVersion: next, updateAvailable: true })
  const confirmation = vi.fn(confirm)
  await manager.change('update', () => true, confirmation)
  expect(confirmation).not.toHaveBeenCalled()
  definition.download.mockResolvedValueOnce({ content: Buffer.from(next), proof: 'wrong checksum' })
  await manager.change('update', idle, confirm)
  expect(await manager.status()).toMatchObject({ installedVersion: old, message: { error: true } })
  expect(definition.test).toHaveBeenCalledOnce()
  const wrongVersion = Buffer.from('2026.11.12')
  definition.download.mockResolvedValueOnce({ content: wrongVersion, proof: sha256(wrongVersion) })
  await manager.change('update', idle, confirm)
  expect(await manager.status()).toMatchObject({
    state: 'installed', installedVersion: old, previousVersion: null,
    message: { text: 'Не удалось обновить модуль. Версия не совпадает. Активна версия 2026.10.26.', error: true },
  })
  expect(await readdir(root)).toEqual(files)
  expect((await manager.binary()).content.toString()).toBe(old)
})

test('blocks downloads during update, cancels staged changes and rolls back a damaged new release', async () => {
  const { manager, definition, profile, root } = await setup()
  await manager.change('install', idle, confirm)
  const files = await readdir(root)
  definition.release.mockResolvedValueOnce({ version: next })
  let started!: () => void
  const staging = new Promise<void>(resolve => { started = resolve })
  definition.test.mockImplementationOnce(async (_content, _version, _directory, signal: AbortSignal) => {
    started()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const update = manager.change('update', idle, confirm)
  await staging
  expect(() => manager.assertAvailableForDownloads()).toThrow('Дождитесь')
  manager.cancel()
  await update
  expect(await readdir(root)).toEqual(files)
  expect(await manager.status()).toMatchObject({ installedVersion: old, message: { error: false, text: 'Операция отменена.' } })
  definition.release.mockResolvedValueOnce({ version: next })
  await manager.change('update', idle, confirm)
  expect(await manager.status()).toMatchObject({ installedVersion: next, previousVersion: old, updateAvailable: false })
  const { current } = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))
  await writeFile(join(root, current.slot, 'yt-dlp.exe'), 'wrong file')
  expect(await manager.status()).toMatchObject({ state: 'damaged', installedVersion: next })
  await expect(manager.binary()).rejects.toThrow('повреждён')
  await mkdir(join(root, 'release-' + randomUUID()))
  await writeFile(join(root, 'registry.next'), 'interrupted write')
  const restarted = new ModuleManager(profile, definition)
  expect((await restarted.status()).previousVersion).toBe(old)
  expect(await readdir(root)).toHaveLength(3)
  await restarted.change('rollback', idle, confirm)
  expect((await restarted.binary()).version).toBe(old)
  await restarted.change('remove', idle, confirm)
  expect(await readdir(root)).toEqual(['registry.json'])
  expect((await restarted.status()).state).toBe('missing')
})

test('repairs a damaged installation through reinstall', async () => {
  const { manager, definition, profile, root } = await setup()
  await manager.change('install', idle, confirm)
  await writeFile(join(root, 'registry.json'), '{broken')
  const restarted = new ModuleManager(profile, definition)
  expect((await restarted.status()).state).toBe('damaged')
  await restarted.change('reinstall', idle, confirm)
  expect(await restarted.status()).toMatchObject({ state: 'installed', installedVersion: old })
  expect(await readdir(root)).toHaveLength(2)
})

test('accepts signed release sums and rejects an altered signature, checksum or executable', async () => {
  const read = (name: string) => readFile(new URL('./fixtures/yt-dlp/' + name, import.meta.url))
  const [sums, signature] = await Promise.all([read('SHA2-256SUMS'), read('SHA2-256SUMS.sig')])
  const proof = () => JSON.stringify({
    scheme: 'yt-dlp-openpgp-v1', sums: sums.toString('base64'), signature: signature.toString('base64'),
  })
  const wrongBinary = Buffer.from('bad executable')
  await expect(verifyYtDlp(wrongBinary, proof())).rejects.toThrow('Контрольная сумма yt-dlp')
  if (process.env.MUSIC_PLAYER_SIGNED_EXE) {
    await expect(verifyYtDlp(await readFile(process.env.MUSIC_PLAYER_SIGNED_EXE), proof())).resolves.toBeUndefined()
  }
  sums[0] ^= 1
  await expect(verifyYtDlp(wrongBinary, proof())).rejects.toThrow('подпись')
  sums[0] ^= 1
  signature[signature.length - 1] ^= 1
  await expect(verifyYtDlp(wrongBinary, proof())).rejects.toThrow('подпись')
})

test('requires matching Stable assets and accepts redirects only to the official release repository', () => {
  const assetBase = `https://github.com/yt-dlp/yt-dlp/releases/download/${old}/`
  const metadata = {
    tag_name: old, draft: false, prerelease: false,
    assets: ['yt-dlp.exe', 'SHA2-256SUMS', 'SHA2-256SUMS.sig'].map(name => ({
      name, state: 'uploaded', size: 10, digest: 'sha256:' + '0'.repeat(64), browser_download_url: assetBase + name,
    })),
  }
  expect(parseRelease(metadata, null).version).toBe(old)
  expect(() => parseRelease({ ...metadata, prerelease: true }, null)).toThrow('Stable')
  expect(() => parseRelease(metadata, next)).toThrow('Stable')
  expect(() => parseRelease({ ...metadata, assets: metadata.assets.slice(0, 2) }, null)).toThrow('Windows x64')
  const executable = assetBase + 'yt-dlp.exe'
  expect(() => validateAssetUrl(new URL(executable), executable)).not.toThrow()
  const assetPath = '/github-production-release-asset/307260205/f116afaa-741f-4c8c-9767-a3ae137fbae6'
  const cdn = 'https://release-assets.githubusercontent.com'
  expect(() => validateAssetUrl(new URL(cdn + assetPath + '?token=sample'), executable)).not.toThrow()
  expect(() => validateAssetUrl(new URL(cdn + assetPath.replace('307260205', '1234')), executable)).toThrow()
  expect(() => validateAssetUrl(new URL(cdn + '.example.com' + assetPath), executable)).toThrow()
})
