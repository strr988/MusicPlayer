import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { algorithmVersions, catalogSize, check, compareRun, hasFields, integer, methods, readJson, validateSnapshot } from './recommendation-research.mjs'

const orders = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
]

export const presentationOrder = slot => orders[(slot - 1) % orders.length].map(index => methods[index])
export const isSessionId = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)

export function validateKey(key) {
  check(hasFields(key, ['kind', 'schemaVersion', 'sessionId', 'slot', 'count', 'excerptSeconds', 'algorithmVersions', 'snapshot']) &&
    key.kind === 'pilot-organizer-key' && key.schemaVersion === 2 && isSessionId(key.sessionId) &&
    integer(key.slot, 1, Number.MAX_SAFE_INTEGER) && integer(key.count, 1, 30) && integer(key.excerptSeconds, 5, 120),
  'Invalid organizer key')
  check(hasFields(key.algorithmVersions, methods) && methods.every(method => key.algorithmVersions[method] === algorithmVersions[method]),
    'Organizer key uses a different algorithm version')
  const snapshot = validateSnapshot(key.snapshot)
  check(catalogSize(snapshot).available >= key.count, 'Pilot requires enough available tracks for a full queue')
  return { ...key, snapshot }
}

export async function prepareSession({ snapshot, manifestPath, output, slot, count, excerptSeconds }) {
  const key = validateKey({
    kind: 'pilot-organizer-key', schemaVersion: 2, sessionId: randomUUID(),
    slot, count, excerptSeconds, algorithmVersions, snapshot,
  })
  const manifest = await readJson(manifestPath)
  const available = key.snapshot.candidates.filter(track => track.available)
  check(hasFields(manifest, available.map(track => track.id)), 'Audio map must cover exactly the available track IDs')
  const audio = new Map()
  for (const { id } of available) {
    const filename = manifest[id]
    check(typeof filename === 'string' && !isAbsolute(filename) && !filename.includes(':') && /\.(mp3|flac)$/i.test(extname(filename)),
      'Expected relative MP3 or FLAC paths in audio map')
    const absolute = resolve(dirname(manifestPath), filename)
    const file = await stat(absolute)
    check(file.isFile() && file.size > 0, 'An audio source is empty or unavailable')
    audio.set(id, pathToFileURL(absolute).href)
  }
  const run = compareRun(key.snapshot, count, { timingSamples: 0, warmup: 0 })
  const queues = presentationOrder(slot).map(method => run[method].ids.map(id => audio.get(id)))
  const data = JSON.stringify({ sessionId: key.sessionId, excerptSeconds, queues }).replaceAll('<', '\\u003c')
  const template = await readFile(new URL('./pilot-listen.html', import.meta.url), 'utf8')
  await mkdir(output)
  await mkdir(join(output, 'participant'))
  await writeFile(join(output, 'organizer-key.json'), JSON.stringify(key, null, 2) + '\n', { flag: 'wx' })
  await writeFile(join(output, 'participant', 'listen.html'), template.replace('<!--SESSION_DATA-->', () => data), { flag: 'wx' })
  return key
}
