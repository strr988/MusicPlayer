import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareRun, metricsOnly, validateSnapshot } from '../scripts/recommendation-research.mjs'
import { prepareSession, presentationOrder } from '../scripts/pilot-session.mjs'

const now = Date.UTC(2026, 10, 11)
const snapshot = {
  now, seed: 42, mode: 'familiar',
  candidates: [
    { id: 'track-a', artist: 'PRIVATE artist', genres: ['PRIVATE genre'], available: true },
    { id: 'track-b', artist: null, genres: [], available: true },
  ],
  listening: {
    preferences: [{ trackId: 'track-a', liked: true, updatedAt: new Date(now).toISOString() }],
    events: [{ trackId: 'track-a', type: 'started', timestamp: new Date(now).toISOString(), sessionId: 'private-session', listenedSeconds: 0 }],
  },
}
let directory
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

const script = (name, ...args) => execFileSync(process.execPath, ['scripts/' + name + '.mjs', ...args], { encoding: 'utf8', stdio: 'pipe' })

it('compares all three algorithms with common inputs and correct novelty and repeat counts', () => {
  const validated = validateSnapshot(snapshot)
  const run = () => compareRun(validated, 1, { timingSamples: 0, warmup: 0 })
  const result = run()
  expect(run()).toEqual(result)
  expect(result.preferences.ids).toEqual(['track-a'])
  expect(result.wave.ids).toEqual(['track-b'])
  expect(metricsOnly(result).preferences).toMatchObject({ unheardShare: 0, historyRepeats: 1, repeatedTracks: 0, artistDiversity: 1 })
  expect(metricsOnly(result).wave).toMatchObject({ unheardShare: 1, historyRepeats: 0, repeatedTracks: 0, artistDiversity: null })
  expect(() => validateSnapshot({ ...snapshot, candidates: [...snapshot.candidates, snapshot.candidates[0]] })).toThrow(/duplicate track ID/)
  const localDate = structuredClone(snapshot)
  localDate.listening.events[0].timestamp = '2026-11-10T12:00:00'
  expect(() => validateSnapshot(localDate)).toThrow(/Invalid playback event/)
})

it('uses all six balanced orders in each block of slots', () => {
  const block = Array.from({ length: 6 }, (_, index) => presentationOrder(index + 1).join(','))
  expect(new Set(block).size).toBe(6)
  expect(presentationOrder(7)).toEqual(presentationOrder(1))
})

it('prepares blind playback, validates manual ratings and exports only allowlisted fields', async () => {
  directory = await mkdtemp(join(tmpdir(), 'music-player-research-'))
  const audio = await readFile(new URL('./fixtures/01-tone.mp3', import.meta.url))
  await writeFile(join(directory, 'PRIVATE audio.mp3'), audio)
  const manifestPath = join(directory, 'map.json')
  await writeFile(manifestPath, JSON.stringify({ 'track-a': 'PRIVATE audio.mp3', 'track-b': 'PRIVATE audio.mp3' }))
  const output = join(directory, 'session')
  const key = await prepareSession({ snapshot, manifestPath, output, slot: 2, count: 2, excerptSeconds: 30 })
  const html = await readFile(join(output, 'participant', 'listen.html'), 'utf8')
  expect(html).toContain('PRIVATE%20audio.mp3')
  expect(html).not.toMatch(/Preference Baseline|Personal Wave|organizer-key|private-session/)
  const keyPath = join(output, 'organizer-key.json')
  const ratingsPath = join(directory, 'ratings.json')
  // Test fixtures exercise the format only. These numbers are never reported as study data.
  const rated = (rating, familiarity = null) => ({ status: 'rated', rating, familiarity })
  const ratings = {
    kind: 'pilot-ratings', schemaVersion: 2, sessionId: key.sessionId,
    blocks: [[rated(2), { status: 'missing' }], [rated(5, 'no'), rated(3)], [{ status: 'audio-error' }, rated(1)]],
  }
  const writeRatings = value => writeFile(ratingsPath, JSON.stringify(value))
  await writeRatings(ratings)
  expect(JSON.parse(script('export-pilot-results', '--check', keyPath, ratingsPath)).validSessions).toBe(1)
  expect(() => script('export-pilot-results', '--check', keyPath, ratingsPath, keyPath, ratingsPath)).toThrow(/Duplicate session/)
  const result = join(directory, 'report.json')
  script('export-pilot-results', result, keyPath, ratingsPath)
  const content = await readFile(result, 'utf8')
  expect(content).not.toContain(key.sessionId)
  expect(content).not.toMatch(/PRIVATE|file:|\.mp3|track-a|track-b|private-session/)
  const report = JSON.parse(content)
  expect(report.userExperiment).toMatchObject({
    participants: 1, incompleteSessions: 1, ratedRecommendations: 4,
    methods: { wave: { meanRating: 4, rated: 2 }, preferences: { meanRating: 1, audioErrors: 1 } },
    paired: { random: { participants: 1, differences: [2] }, preferences: { participants: 1, differences: [3] } },
  })
  expect(report.technical.sessions[0].catalog).toEqual({ total: 2, available: 2 })
  const chart = join(directory, 'plot.svg')
  script('plot-pilot-results', result, chart)
  expect(await readFile(chart, 'utf8')).toContain('n=1, оценок=2')
  await writeRatings({ ...ratings, blocks: ratings.blocks.map(block => block.map(() => ({ status: 'missing' }))) })
  const noRatings = join(directory, 'no-ratings.json')
  script('export-pilot-results', noRatings, keyPath, ratingsPath)
  expect(JSON.parse(await readFile(noRatings, 'utf8'))).toMatchObject({ kind: 'algorithm-benchmark', userExperiment: 'no-user-ratings' })
  expect(() => script('plot-pilot-results', noRatings, chart)).toThrow(/with participant ratings/)
  await writeRatings({ ...ratings, blocks: [[rated(7), rated(2)], ...ratings.blocks.slice(1)] })
  expect(() => script('export-pilot-results', '--check', keyPath, ratingsPath)).toThrow(/Invalid rating/)
  await writeRatings({ ...ratings, name: 'Unexpected field' })
  expect(() => script('export-pilot-results', '--check', keyPath, ratingsPath)).toThrow(/Invalid ratings document/)
  await writeRatings({ ...ratings, kind: 'algorithm-benchmark' })
  expect(() => script('export-pilot-results', '--check', keyPath, ratingsPath)).toThrow(/Invalid ratings document/)
})
