import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { algorithmVersions, artistKey, generateWave, preferenceQueue, randomQueue } from '../src/recommendations/engine.ts'
import { measureQueue } from '../src/recommendations/metrics.ts'
import { waveModes } from '../src/shared/contracts.ts'

export const methods = ['random', 'preferences', 'wave']
export { algorithmVersions }
const engines = { random: randomQueue, preferences: preferenceQueue, wave: generateWave }
export const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

export function check(condition, message) {
  if (!condition) throw new Error(message)
}

export function hasFields(value, required, optional = []) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

export const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const isId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
const isTimestamp = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value))

export function validateSnapshot(input) {
  check(hasFields(input, ['now', 'seed', 'candidates', 'listening'], ['mode']), 'Invalid snapshot fields')
  check(integer(input.now, 0, 8.64e15) && integer(input.seed, 0, 0xffffffff) &&
    (input.mode === undefined || waveModes.includes(input.mode)), 'Invalid now, seed or mode')
  check(Array.isArray(input.candidates), 'Expected an array of candidates')
  const ids = new Set()
  for (const item of input.candidates) {
    check(hasFields(item, ['id', 'artist', 'genres', 'available']) && isId(item.id) && !ids.has(item.id) &&
      (item.artist === null || typeof item.artist === 'string') && Array.isArray(item.genres) &&
      item.genres.every(genre => typeof genre === 'string') && typeof item.available === 'boolean',
    'Invalid candidate or duplicate track ID')
    ids.add(item.id)
  }
  const listening = input.listening
  check(hasFields(listening, ['preferences', 'events']) && Array.isArray(listening.preferences) &&
    Array.isArray(listening.events), 'Invalid listening data')
  const preferences = new Set()
  for (const item of listening.preferences) {
    check(hasFields(item, ['trackId', 'liked', 'updatedAt']) && ids.has(item.trackId) &&
      !preferences.has(item.trackId) && typeof item.liked === 'boolean' && isTimestamp(item.updatedAt) &&
      Date.parse(item.updatedAt) <= input.now, 'Invalid preference, duplicate or future update')
    preferences.add(item.trackId)
  }
  for (const item of listening.events) {
    check(hasFields(item, ['trackId', 'type', 'timestamp', 'sessionId', 'listenedSeconds']) &&
      ids.has(item.trackId) && isId(item.sessionId) && isTimestamp(item.timestamp) &&
      Date.parse(item.timestamp) <= input.now &&
      ['started', 'skipped', 'completed', 'ended', 'error'].includes(item.type) &&
      Number.isFinite(item.listenedSeconds) && item.listenedSeconds >= 0, 'Invalid playback event')
  }
  return { ...input, mode: input.mode ?? 'balance' }
}

export function catalogSize({ candidates }) {
  return { total: candidates.length, available: candidates.filter(track => track.available).length }
}

export function compareRun(context, count, { timingSamples = 100, warmup = 20 } = {}) {
  const artistById = new Map(context.candidates.map(track => [track.id, artistKey(track.artist)]))
  const available = new Set(context.candidates.filter(track => track.available).map(track => track.id))
  const starts = context.listening.events
    .filter(event => event.type === 'started' && Date.parse(event.timestamp) <= context.now)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .reverse()
  const heard = new Set(starts.map(event => event.trackId))
  const recent = new Set([...heard].filter(id => available.has(id)).slice(0, Math.max(0, Math.min(5, available.size - 1))))

  return Object.fromEntries(methods.map(method => {
    const engine = engines[method]
    const ids = engine(context, count)
    for (let i = 0; i < warmup; i++) engine(context, count)
    const times = Array.from({ length: timingSamples }, () => {
      const start = performance.now()
      engine(context, count)
      return performance.now() - start
    }).sort((a, b) => a - b)
    const middle = Math.floor(times.length / 2)
    return [method, {
      ids, metrics: {
        ...measureQueue(ids, artistById, recent, heard),
        medianMs: times.length % 2 ? times[middle] : mean(times.slice(middle - 1, middle + 1)),
        p95Ms: times[Math.ceil(times.length * 0.95) - 1] ?? null,
      },
    }]
  }))
}

export function metricsOnly(run) {
  return Object.fromEntries(methods.map(method => [method, run[method].metrics]))
}

export function aggregateRuns(runs) {
  return Object.fromEntries(methods.map(method => {
    const rows = runs.map(run => run[method])
    return [method, Object.fromEntries(Object.keys(rows[0]).map(key => [
      key, mean(rows.map(row => row[key]).filter(value => value !== null)),
    ]))]
  }))
}
