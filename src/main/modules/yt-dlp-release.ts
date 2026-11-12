import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createMessage, readKey, readSignature, verify } from 'openpgp'
import { YtDlpProvider } from '../music-sources/archive'
import { guardedResponse, readBounded, validateHttpsEndpoint } from '../music-sources/network'
import { object, parseJson } from '../music-sources/provider'
import { SoundCloudProvider } from '../music-sources/soundcloud'
import type { ModuleDefinition, ModuleRelease } from './module-manager'
import { ModuleError } from './module-manager'
import { ytDlpPublicKey } from './yt-dlp-key'

const repository = 'yt-dlp/yt-dlp'
const api = `https://api.github.com/repos/${repository}/releases/`
const assets = `https://github.com/${repository}/releases/download/`
const executable = 'yt-dlp.exe'
const checksums = 'SHA2-256SUMS'
const signature = checksums + '.sig'
const maxExecutable = 32 * 1024 * 1024
const maxProofAsset = 8192
const versionPattern = /^\d{4}\.\d{2}\.\d{2}(?:\.\d{1,3})?$/
const fingerprint = 'ac0cbbe6848d6a873464af4e57cf65933b5a7581'

interface Asset {
  url: string
  size: number
  digest: string
}

interface Release extends ModuleRelease {
  binary: Asset
  sums: Asset
  signature: Asset
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export function parseRelease(value: Record<string, unknown>, requested: string | null): Release {
  const version = value.tag_name
  if (typeof version !== 'string' || !versionPattern.test(version) || requested && version !== requested ||
      value.draft !== false || value.prerelease !== false || !Array.isArray(value.assets)) {
    throw new ModuleError('GitHub не вернул официальный выпуск Stable.')
  }
  function asset(name: string, limit: number): Asset {
    const url = `${assets}${version}/${name}`
    const matches = (value.assets as unknown[]).map(object).filter(item => item.name === name)
    const [item] = matches
    if (matches.length !== 1 || item.browser_download_url !== url || item.state !== 'uploaded' ||
        typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > limit ||
        typeof item.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.digest)) {
      throw new ModuleError('В выпуске Stable отсутствуют проверяемые файлы для Windows x64.')
    }
    return { url, size: item.size, digest: item.digest.slice(7) }
  }
  return { version, binary: asset(executable, maxExecutable), sums: asset(checksums, maxProofAsset),
    signature: asset(signature, maxProofAsset) }
}

async function release(version: string | null, signal: AbortSignal) {
  const url = new URL(api + (version ? `tags/${version}` : 'latest'))
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  const bytes = await guardedResponse(url, target => validateHttpsEndpoint(target, endpoint => endpoint.href === url.href), bounded)
    .then(response => readBounded(response, 512 * 1024))
    .catch(() => { throw new ModuleError('Не удалось проверить Stable Release. Проверьте подключение к GitHub.') })
  return parseRelease(parseJson(bytes.toString('utf8')), version)
}

export function validateAssetUrl(target: URL, expected: string) {
  if (target.href === expected) return
  // GitHub uses time-limited signed query parameters on its release CDN.
  if (target.origin !== 'https://release-assets.githubusercontent.com' ||
      target.username || target.password || target.hash ||
      !/^\/github-production-release-asset\/307260205\/[a-f0-9-]{36}$/.test(target.pathname)) {
    throw new ModuleError('GitHub перенаправил загрузку на недопустимый адрес.')
  }
}

async function downloadAsset(asset: Asset, signal: AbortSignal, progress?: (bytes: number, total: number) => void) {
  const response = await guardedResponse(new URL(asset.url), target => validateAssetUrl(target, asset.url), signal)
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of response as AsyncIterable<Buffer>) {
    received += chunk.length
    if (received > asset.size) throw new ModuleError('Размер файла отличается от данных GitHub.')
    chunks.push(chunk)
    progress?.(received, asset.size)
  }
  const bytes = Buffer.concat(chunks, received)
  if (received !== asset.size || sha256(bytes) !== asset.digest) {
    throw new ModuleError('Файл не совпадает с контрольной суммой GitHub.')
  }
  return bytes
}

async function download(release: Release, signal: AbortSignal, progress: (bytes: number, total: number) => void) {
  const timeout = AbortSignal.timeout(480_000)
  const bounded = AbortSignal.any([signal, timeout])
  try {
    const sums = await downloadAsset(release.sums, bounded)
    const signature = await downloadAsset(release.signature, bounded)
    const proof = JSON.stringify({ scheme: 'yt-dlp-openpgp-v1', sums: sums.toString('base64'),
      signature: signature.toString('base64') })
    if (await signedDigest(proof) !== release.binary.digest) {
      throw new ModuleError('Подписанная контрольная сумма отличается от данных GitHub.')
    }
    progress(0, release.binary.size)
    return { content: await downloadAsset(release.binary, bounded, progress), proof }
  } catch (error) {
    if (error instanceof ModuleError) throw error
    if (timeout.aborted) throw new ModuleError('Скачивание заняло слишком много времени. Повторите попытку.')
    throw new ModuleError('Не удалось скачать модуль. Проверьте подключение к GitHub.')
  }
}

async function signedDigest(proof: string): Promise<string> {
  try {
    const value = parseJson(proof)
    if (value.scheme !== 'yt-dlp-openpgp-v1' || typeof value.sums !== 'string' ||
        typeof value.signature !== 'string') throw new Error()
    const data = Buffer.from(value.sums, 'base64')
    const detached = Buffer.from(value.signature, 'base64')
    if (data.length > maxProofAsset || detached.length > maxProofAsset) throw new Error()
    const key = await readKey({ armoredKey: ytDlpPublicKey })
    if (key.getFingerprint() !== fingerprint) throw new Error()
    const result = await verify({ message: await createMessage({ binary: data }),
      signature: await readSignature({ binarySignature: detached }), verificationKeys: key, expectSigned: true })
    await Promise.all(result.signatures.map(entry => entry.verified))
    const matches = [...data.toString('utf8').matchAll(/^([a-f0-9]{64}) [ *]yt-dlp\.exe\r?$/gm)]
    if (matches.length === 1) return matches[0][1]
  } catch {
    throw new ModuleError('Не удалось проверить подпись выпуска yt-dlp.')
  }
  throw new ModuleError('Подписанная контрольная сумма yt-dlp.exe отсутствует.')
}

export async function verifyYtDlp(content: Buffer, proof: string) {
  if (sha256(content) !== await signedDigest(proof)) throw new ModuleError('Контрольная сумма yt-dlp не совпадает.')
  const offset = content.length >= 64 && content.readUInt16LE(0) === 0x5a4d ? content.readUInt32LE(0x3c) : -1
  if (offset < 64 || offset > content.length - 6 ||
      content.readUInt32LE(offset) !== 0x4550 || content.readUInt16LE(offset + 4) !== 0x8664) {
    throw new ModuleError('Файл yt-dlp не предназначен для Windows x64.')
  }
}

async function testProviders(content: Buffer, version: string, directory: string, signal: AbortSignal) {
  const load = async () => ({ content, version })
  const probes = [
    { provider: new YtDlpProvider(load), name: 'Archive.org', url: 'https://archive.org/details/jamendo-184210',
      matches: (id: string) => id.startsWith('jamendo-184210/') },
    { provider: new SoundCloudProvider(load), name: 'SoundCloud', url: 'https://soundcloud.com/the80m/the-following',
      matches: (id: string) => id === '343609555' },
  ]
  for (const { provider, name, url, matches } of probes) {
    const workspace = join(directory, 'probe-' + provider.id)
    await mkdir(workspace)
    try {
      const analysis = await provider.analyze(provider.recognize(url), workspace,
        AbortSignal.any([signal, AbortSignal.timeout(65_000)]))
      if (!matches(analysis.metadata.sourceId) || !analysis.metadata.title ||
          provider.id === 'archive.org' && !analysis.original) throw new Error('Контрольная запись недоступна.')
    } catch (error) {
      const detail = error instanceof Error && !('code' in error) ? ` ${error.message}` : ''
      throw new ModuleError(`Совместимость с ${name} не подтверждена.${detail}`)
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 5 })
    }
  }
}

export const ytDlpModule: ModuleDefinition<Release> = {
  id: 'yt-dlp', executable, versionPattern, maxBytes: maxExecutable,
  supported: process.platform === 'win32' && process.arch === 'x64',
  release, download, verify: verifyYtDlp, test: testProviders,
}
