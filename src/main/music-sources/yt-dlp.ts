import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const ytDlpVersion = '2026.10.26'
const digest = 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d'

export function checkVersion(value: string): void {
  if (value.trim() !== ytDlpVersion) throw new Error(`Требуется yt-dlp ${ytDlpVersion}.`)
}

function processError(stderr: string): Error {
  if (/404|not found|not available|removed/i.test(stderr)) return new Error('Материал недоступен или удалён.')
  if (/403|429|login|private|restricted/i.test(stderr)) return new Error('Источник ограничил доступ к записи.')
  if (/ffmpeg|ffprobe/i.test(stderr)) return new Error('Операции с FFmpeg отключены для этого источника.')
  if (/connection|timed out|network|proxy|ssl|certificate/i.test(stderr)) {
    return new Error('Сетевая ошибка при обращении к Archive.org.')
  }
  return new Error('yt-dlp не смог прочитать метаданные записи.')
}

function run(executable: string, args: string[], directory: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    const child = spawn(executable, args, {
      cwd: directory, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { SystemRoot: root, PATH: join(root, 'System32'), TEMP: directory, TMP: directory, PYTHONUTF8: '1' },
    })
    let failure: Error | undefined
    let size = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    function stop(error: Error) {
      if (failure) return
      failure = error
      // The official one-file executable starts a second PyInstaller process.
      if (child.pid && child.exitCode === null) {
        const killer = spawn(join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore',
        })
        killer.once('error', () => child.kill())
        killer.once('exit', code => { if (code !== 0) child.kill() })
      }
    }
    const abort = () => stop(new Error('Задача отменена.'))
    const timeout = setTimeout(() => stop(new Error('Превышено время ожидания yt-dlp.')), 45_000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    function collect(chunks: Buffer[], chunk: Buffer) {
      if (failure) return
      size += chunk.length
      if (size > 1024 * 1024) stop(new Error('Ответ yt-dlp слишком большой.'))
      else chunks.push(chunk)
    }
    child.stdout.on('data', chunk => collect(stdout, chunk))
    child.stderr.on('data', chunk => collect(stderr, chunk))
    child.once('error', () => { failure ??= new Error('Не удалось запустить проверенный yt-dlp.') })
    child.once('close', code => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(processError(Buffer.concat(stderr).toString('utf8')))
      else resolve(Buffer.concat(stdout).toString('utf8'))
    })
  })
}

export async function verifiedYtDlp(binary: string, directory: string, signal: AbortSignal) {
  const file = await lstat(binary).catch(error => {
    if (error.code === 'ENOENT') throw new Error(`Поместите официальный yt-dlp ${ytDlpVersion} в Music Player\\tools\\yt-dlp.exe.`)
    throw error
  })
  if (!file.isFile() || file.size > 32 * 1024 * 1024) throw new Error('Некорректный файл yt-dlp.exe.')
  const executableFile = await open(binary, 'r')
  const content = Buffer.alloc(file.size)
  try {
    const { bytesRead } = await executableFile.read(content, 0, content.length, 0)
    if (bytesRead !== file.size || (await executableFile.stat()).size !== file.size) {
      throw new Error('Файл yt-dlp изменился при проверке.')
    }
  } finally {
    await executableFile.close()
  }
  if (createHash('sha256').update(content).digest('hex') !== digest) {
    throw new Error(`SHA-256 yt-dlp не совпадает с официальным релизом ${ytDlpVersion}.`)
  }
  const executable = join(directory, 'yt-dlp.exe')
  await writeFile(executable, content, { flag: 'wx', signal })
  const defaults = ['--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-js-runtimes',
    '--no-remote-components', '--no-cookies', '--no-cookies-from-browser', '--encoding', 'utf-8']
  checkVersion(await run(executable, [...defaults, '--version'], directory, signal))
  return (url: string, proxy: string) => run(executable, [
    ...defaults, '--proxy', proxy, '--use-extractors', 'archive.org', '--skip-download', '--dump-single-json',
    '--playlist-items', '1:2', '--no-check-formats', '--retries', '0', '--extractor-retries', '0',
    '--ffmpeg-location', join(directory, 'unused-ffmpeg'), '--socket-timeout', '15', '--', url,
  ], directory, signal)
}
