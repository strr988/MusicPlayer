import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { artistKey, generateWave, preferenceQueue, randomQueue } from '../src/recommendations/engine.ts'
import { measureQueue } from '../src/recommendations/metrics.ts'

const [snapshotPath, countInput = '8'] = process.argv.slice(2)
const count = Number(countInput)
if (!Number.isSafeInteger(count) || count < 1) throw new Error('Expected a positive integer queue length')

const now = Date.UTC(2026, 10, 11)
const timestamp = new Date(now - 60_000).toISOString()
const example = {
  seed: 42,
  now,
  candidates: Array.from({ length: 14 }, (_, index) => ({
    id: String(index + 1),
    artist: index === 12 ? null : ['A', 'B', 'C', 'D'][index % 4],
    genres: index % 2 === 0 ? ['rock'] : [],
    available: index !== 13,
  })),
  listening: {
    preferences: [{ trackId: '1', liked: true, updatedAt: timestamp }],
    events: [
      { trackId: '2', sessionId: '1', type: 'started', listenedSeconds: 0, timestamp },
      { trackId: '2', sessionId: '1', type: 'skipped', listenedSeconds: 5, timestamp },
      { trackId: '3', sessionId: '2', type: 'started', listenedSeconds: 0, timestamp },
      { trackId: '3', sessionId: '2', type: 'completed', listenedSeconds: 90, timestamp },
    ],
  },
}
const context = snapshotPath ? JSON.parse(await readFile(snapshotPath, 'utf8')) : example
const artistById = new Map(context.candidates.map(track => [track.id, artistKey(track.artist)]))
const available = new Set(context.candidates.filter(track => track.available).map(track => track.id))
const recentStarts = context.listening.events
  .filter(event => event.type === 'started' && available.has(event.trackId) && Date.parse(event.timestamp) <= context.now)
  .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  .reverse()
const recentlyPlayed = new Set([...new Set(recentStarts.map(event => event.trackId))].slice(0, 5))

const results = Object.entries({ random: randomQueue, preferences: preferenceQueue, wave: generateWave })
  .map(([method, engine]) => {
    const ids = engine(context, count)
    for (let i = 0; i < 20; i++) engine(context, count)
    const times = Array.from({ length: 100 }, () => {
      const start = performance.now()
      engine(context, count)
      return performance.now() - start
    }).sort((a, b) => a - b)
    return {
      method, ids,
      ...measureQueue(ids, artistById, recentlyPlayed),
      medianMs: (times[49] + times[50]) / 2,
      p95Ms: times[94],
    }
  })
console.log(JSON.stringify({ seed: context.seed, now: context.now, requestedTracks: count, results }, null, 2))
