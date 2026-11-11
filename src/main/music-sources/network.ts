import { lookup } from 'node:dns/promises'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { request } from 'node:https'
import { BlockList, connect, isIPv4 } from 'node:net'
import type { Socket } from 'node:net'

const nonPublic = new BlockList()
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) nonPublic.addSubnet(address, bits)

export function publicAddress(records: readonly string[]): string {
  if (!records.length || records.some(ip => !isIPv4(ip) || nonPublic.check(ip))) {
    throw new Error('Сетевой адрес заблокирован.')
  }
  return records[0]
}

async function resolveHost(host: string): Promise<string> {
  const records = await lookup(host, { all: true, family: 4 })
  return publicAddress(records.map(record => record.address))
}

export function validateArchiveEndpoint(url: URL, pathAllowed: (url: URL) => boolean): void {
  const host = url.hostname
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.search ||
      (host !== 'archive.org' && !/^(?:ia|dn)[0-9]{5,9}(?:\.[a-z]{2})?\.archive\.org$/.test(host)) || !pathAllowed(url)) {
    throw new Error('Сетевой адрес или перенаправление заблокировано.')
  }
}

export async function archiveResponse(url: URL, pathAllowed: (url: URL) => boolean, signal: AbortSignal) {
  for (let hops = 0; hops <= 4; hops++) {
    signal.throwIfAborted()
    validateArchiveEndpoint(url, pathAllowed)
    const address = await resolveHost(url.hostname)
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      // Connect to the checked address while keeping the original Host and TLS identity.
      const req = request(url, {
        agent: false, family: 4, signal,
        lookup: (_host, _options, callback) => callback(null, address, 4),
        headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'MusicPlayer/0.6.0' },
      }, resolve)
      req.on('error', reject)
      req.setTimeout(20_000, () => req.destroy(new Error('Источник не отвечает.')))
      req.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
      response.destroy()
      url = new URL(response.headers.location, url)
      continue
    }
    if (response.statusCode !== 200 || ![undefined, 'identity'].includes(response.headers['content-encoding'])) {
      response.destroy()
      throw new Error(`Источник вернул HTTP ${response.statusCode ?? '?'} или неподдерживаемый ответ.`)
    }
    return response
  }
  throw new Error('Слишком много перенаправлений.')
}

export async function readBounded(response: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new Error('Ответ источника слишком большой.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function withArchiveProxy<T>(operation: (proxy: string) => Promise<T>): Promise<T> {
  const sockets = new Set<Socket>()
  let bytes = 0
  function track(socket: Socket) {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(20_000, () => socket.destroy())
  }
  const server = createServer({ maxHeaderSize: 4096 }, (_req, res) => res.writeHead(403).end())
  server.maxConnections = 4
  server.on('connection', track)
  server.on('connect', (req, client: Socket, head) => {
    if (req.url !== 'archive.org:443') {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    void resolveHost('archive.org').then(address => {
      if (client.destroyed) return
      const remote = connect({ host: address, port: 443, family: 4 })
      track(remote)
      client.once('close', () => remote.destroy())
      remote.once('close', () => client.destroy())
      remote.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) remote.write(head)
        remote.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 8 * 1024 * 1024) {
            for (const socket of sockets) socket.destroy()
          }
        })
        client.pipe(remote).pipe(client)
      })
    }).catch(() => client.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Не удалось запустить сетевой фильтр.')
    return await operation(`http://127.0.0.1:${address.port}`)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
