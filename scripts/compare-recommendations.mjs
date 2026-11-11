import { aggregateRuns, algorithmVersions, catalogSize, check, compareRun, integer, metricsOnly, readJson, validateSnapshot } from './recommendation-research.mjs'

const [snapshotPath = '--example', countInput = '8', seedList, ...extra] = process.argv.slice(2)
const count = Number(countInput)
check(!extra.length && integer(count, 1, 50_000), 'Expected snapshot path or --example, queue length and optional comma-separated seeds')

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
const synthetic = snapshotPath === '--example'
const context = validateSnapshot(synthetic ? example : await readJson(snapshotPath))
const seeds = seedList === undefined ? (synthetic ? [42, 43, 44, 45, 46, 47] : [context.seed]) :
  seedList.split(',').map(item => item.trim() ? Number(item) : NaN)
check(seeds.every(seed => integer(seed, 0, 0xffffffff)) && new Set(seeds).size === seeds.length,
  'Expected unique unsigned 32-bit seeds')
const runs = seeds.map(seed => ({ seed, methods: metricsOnly(compareRun({ ...context, seed }, count)) }))
console.log(JSON.stringify({
  schemaVersion: 2,
  kind: 'algorithm-benchmark',
  input: synthetic ? 'synthetic-example' : 'provided-snapshot',
  userExperiment: 'no-user-ratings',
  algorithmVersions,
  parameters: { now: context.now, mode: context.mode, count, timingSamples: 100, warmup: 20 },
  catalog: catalogSize(context),
  runs,
  aggregate: aggregateRuns(runs.map(run => run.methods)),
}, null, 2))
