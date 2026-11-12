import { createReadStream, mkdirSync, writeSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { app } from 'electron'
import { verify } from './electron-smoke.mjs'

const [folder, profile, phase] = process.argv.slice(2)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

function replaceResponses(responseFor) {
  const request = https.request
  https.request = (...args) => {
    const [url, , callback] = args
    const response = url instanceof URL && responseFor(url.href)
    if (!response) return request(...args)
    const stub = new EventEmitter()
    stub.setTimeout = () => stub
    stub.end = () => {
      Object.assign(response, { statusCode: 200, headers: {} })
      queueMicrotask(() => callback(response))
    }
    return stub
  }
  syncBuiltinESMExports()
  return () => {
    https.request = request
    syncBuiltinESMExports()
  }
}

const assets = ['yt-dlp.exe', 'SHA2-256SUMS', 'SHA2-256SUMS.sig']
const baseUrl = 'https://github.com/yt-dlp/yt-dlp/releases/download/'
const api = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'

function simulateFailedUpdate(installedVersion) {
  const tag = installedVersion + '.1'
  const base = baseUrl + tag + '/'
  const payload = JSON.stringify({
    tag_name: tag, draft: false, prerelease: false,
    assets: assets.map(name => ({
      name, size: 6, state: 'uploaded', browser_download_url: base + name, digest: 'sha256:' + '0'.repeat(64),
    })),
  })
  return replaceResponses(url => {
    const body = url === api ? payload : url === base + 'SHA2-256SUMS' ? 'broken' : null
    return body && Readable.from([Buffer.from(body)])
  })
}

// Optional replay of the official asset bytes for slow CI links. Metadata, proof verification,
// native processes and provider requests still use the production code paths.
const replay = process.env.MUSIC_PLAYER_TEST_RELEASE_ASSETS
if (replay) replaceResponses(url => {
  const name = assets.find(asset => url === baseUrl + '2026.10.26/' + asset)
  return name && createReadStream(join(replay, name))
})

await import('../out/main/index.js')
void verify(folder, profile, phase, undefined, simulateFailedUpdate).then(() => {
  if (phase === 'downloads-recovery-commit') {
    writeSync(1, 'download import committed\n')
    process.kill(process.pid, 'SIGKILL')
  } else app.quit()
}, (error) => {
  console.error(error)
  app.exit(1)
})
