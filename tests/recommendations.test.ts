import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PlaybackEvent, TrackPreference } from '../src/shared/contracts'
import { waveModes } from '../src/shared/contracts'
import { explainWave, generateWave, preferenceQueue, randomQueue } from '../src/recommendations/engine'
import type { RecommendationCandidate, RecommendationContext } from '../src/recommendations/engine'
import { measureQueue } from '../src/recommendations/metrics'

const now = Date.UTC(2026, 10, 11)
const timestamp = new Date(now - 1000).toISOString()
const track = (id: string, artist: string | null = null, available = true): RecommendationCandidate =>
  ({ id, artist, genres: [], available })
const context = (candidates: RecommendationCandidate[]): RecommendationContext =>
  ({ candidates, listening: { preferences: [], events: [] }, now, seed: 42 })
const like = (trackId: string, liked = true): TrackPreference => ({ trackId, liked, updatedAt: timestamp })
const event = (trackId: string, type: PlaybackEvent['type'], sessionId = trackId): PlaybackEvent =>
  ({ trackId, sessionId, type, listenedSeconds: type === 'started' ? 0 : 5, timestamp })
const methods = [randomQueue, preferenceQueue, generateWave]

describe('recommendations', () => {
  it('handles empty, unavailable and singleton libraries in all methods', () => {
    for (const method of methods) {
      expect(method(context([]), 10)).toEqual([])
      expect(method(context([track('x', null, false)]), 10)).toEqual([])
      expect(method(context([track('a'), track('x', null, false)]), 10)).toEqual(['a'])
      expect(method(context([track('a')]), 0)).toEqual([])
    }
  })

  it('produces the same unique queue for the same cold snapshot, seed and time with missing tags', () => {
    const input = context([track('a'), track('b'), track('c', 'A'), track('x', 'A', false), track('a')])
    for (const method of methods) {
      const ids = method(input, 10)
      expect(ids).toHaveLength(3)
      expect([...ids].sort()).toEqual(['a', 'b', 'c'])
      expect(method(structuredClone(input), 10)).toEqual(ids)
    }
    expect(new Set(Array.from({ length: 20 }, (_, seed) =>
      generateWave({ ...input, seed }, 3).join())).size).toBeGreaterThan(1)
  })

  it('uses current likes and artist affinity even if the liked source is unavailable', () => {
    const input = context([track('a', 'Artist', false), track('b', ' artist '), track('c', 'Other')])
    input.listening.preferences = [like('a')]
    expect(generateWave(input, 10)).toEqual(['b', 'c'])
    expect(preferenceQueue(input, 10)).toEqual(['b', 'c'])
    input.listening.preferences = [like('a', false), like('c')]
    expect(generateWave(input, 10)).toEqual(['c', 'b'])
    expect(preferenceQueue(input, 10)).toEqual(['c', 'b'])
  })

  it('uses optional genre affinity', () => {
    const input = context([
      { ...track('a', null, false), genres: [' Rock '] },
      { ...track('b'), genres: ['rock'] },
      track('c'),
    ])
    input.listening.preferences = [like('a')]
    expect(generateWave(input, 1)).toEqual(['b'])
    expect(preferenceQueue(input, 1)).toEqual(['b'])
  })

  it('distinguishes a skip and completion from an unfinished or failed session', () => {
    const recent = ['c', 'd', 'e', 'f', 'g']
    const input = context(['a', 'b', ...recent].map(id => track(id)))
    const history = [event('a', 'started'), event('b', 'started'), ...recent.map(id => event(id, 'started'))]
    input.listening.events = history
    const [first] = generateWave(input, 1)
    const other = first === 'a' ? 'b' : 'a'
    for (const type of ['error', 'ended'] as const) {
      input.listening.events = [...history, event(first, type)]
      expect(generateWave(input, 1)).toEqual([first])
    }
    input.listening.events = [...history, event(first, 'skipped')]
    expect(generateWave(input, 1)).toEqual([other])
    input.listening.events = [...history, event(other, 'completed')]
    expect(generateWave(input, 1)).toEqual([other])
    input.listening.events = [...history, { ...event(first, 'skipped'), timestamp: '2025-01-01T00:00:00Z' }]
    expect(generateWave(input, 1)).toEqual([first])
    expect(randomQueue(input, 7)).toEqual(randomQueue(context(input.candidates.slice()), 7))
    expect(preferenceQueue(input, 7)).toEqual(preferenceQueue(context(input.candidates.slice()), 7))
  })

  it('cycles through a short catalog before repeating across queue requests', () => {
    const input = context([track('a', 'A'), track('b', 'B'), track('c', 'C')])
    input.listening.preferences = [like('a')]
    const played = []
    for (let i = 0; i < 12; i++) {
      const ids = generateWave({ ...input, seed: i }, 3)
      expect(new Set(ids).size).toBe(3)
      played.push(ids[0])
      input.listening.events.push(event(ids[0], 'started', String(i)))
    }
    for (let i = 0; i < played.length - 2; i++) {
      expect(new Set(played.slice(i, i + 3)).size).toBe(3)
    }
  })

  it('exhausts each eligible catalog even when all candidates have been heard', () => {
    for (let size = 1; size <= 8; size++) {
      const candidates = Array.from({ length: size }, (_, index) => track(String(index), 'A'))
      const input = context([...candidates, track('unavailable', 'B', false)])
      input.listening.events = input.candidates.map(({ id }) => event(id, 'started'))
      for (const method of methods) {
        const queue = method(input, 10)
        expect(queue).toHaveLength(size)
        expect(new Set(queue)).toEqual(new Set(candidates.map(({ id }) => id)))
        expect(method({ ...input, candidates: input.candidates.toReversed() }, 10)).toEqual(queue)
      }
    }
  })

  it('avoids adjacent known artists when an alternative is eligible', () => {
    const input = context([track('a1', 'A'), track('a2', 'A'), track('b1', 'B'), track('b2', 'B')])
    input.listening.preferences = [like('a1'), like('a2')]
    input.listening.events = [event('a1', 'started')]
    const ids = generateWave(input, 4)
    expect(ids.map(id => id[0])).toEqual(['b', 'a', 'b', 'a'])
  })

  it('occasionally explores unheard tracks even with a higher-ranked familiar option', () => {
    const recent = ['c', 'd', 'e', 'f', 'g']
    const input = context(['a', 'b', ...recent].map(id => track(id)))
    input.listening.preferences = [like('a')]
    input.listening.events = ['a', ...recent].map(id => event(id, 'started'))
    const choices = Array.from({ length: 100 }, (_, seed) => generateWave({ ...input, seed }, 1)[0])
    expect(choices).toContain('a')
    expect(choices).toContain('b')
  })

  it('keeps Balance identical to the default and increases early discoveries across modes', () => {
    const recent = ['c', 'd', 'e', 'f', 'g']
    const input = context(['a', 'b', ...recent].map(id => track(id)))
    input.listening.preferences = [like('a')]
    input.listening.events = ['a', ...recent].map(id => event(id, 'started'))
    const discoveries = { familiar: 0, balance: 0, discovery: 0 }
    for (let seed = 0; seed < 100; seed++) {
      const seeded = { ...input, seed }
      expect(generateWave({ ...seeded, mode: 'balance' }, 7)).toEqual(generateWave(seeded, 7))
      for (const mode of waveModes) {
        const snapshot = { ...seeded, mode }
        const queue = generateWave(snapshot, 3)
        expect(generateWave(structuredClone(snapshot), 3)).toEqual(queue)
        if (queue[0] === 'b') discoveries[mode]++
      }
    }
    expect(discoveries.familiar).toBe(0)
    expect(discoveries.balance).toBeGreaterThan(discoveries.familiar)
    expect(discoveries.discovery).toBeGreaterThan(discoveries.balance)
  })

  it('caps every mode at the number of unique available tracks in a short catalog', () => {
    for (const mode of waveModes) {
      for (const size of [0, 1, 2]) {
        const available = [track('a'), track('b')].slice(0, size)
        const input = { ...context([...available, ...available, track('x', 'X', false)]), mode }
        expect(generateWave(input, 10).sort()).toEqual(available.map(track => track.id))
      }
    }
  })
})

it('measures artist diversity and repeats independently of ranking scores', () => {
  const artists = new Map([['a', 'x'], ['b', 'x'], ['c', 'y'], ['unknown', undefined]])
  expect(measureQueue(['a', 'b', 'unknown', 'a', 'c'], artists, new Set(['a']), new Set(['a', 'b']))).toEqual({
    tracks: 5, knownArtistTracks: 4, distinctArtists: 2, artistDiversity: 0.5,
    sameArtistTransitionRate: 0.5, repeatedTracks: 1, historyRepeats: 2,
    unheardTracks: 2, unheardShare: 0.4,
  })
  expect(measureQueue(['unknown'], artists, new Set()).artistDiversity).toBeNull()
})

describe('wave diagnostics', () => {
  it('matches the queues captured from d453c39 with and without diagnostics', () => {
    const fixture: {
      now: number
      snapshots: Pick<RecommendationContext, 'candidates' | 'listening'>[]
      cases: ({ seed: number; random: string[]; preferences: string[] } & Record<typeof waveModes[number], string[]> )[][]
    } = JSON.parse(readFileSync(new URL('./fixtures/wave-0.4.1.json', import.meta.url), 'utf8'))
    for (const [index, snapshot] of fixture.snapshots.entries()) {
      for (const expected of fixture.cases[index]) {
        const input = { ...snapshot, now: fixture.now, seed: expected.seed }
        expect(randomQueue(input, 10)).toEqual(expected.random)
        expect(preferenceQueue(input, 10)).toEqual(expected.preferences)
        for (const mode of waveModes) {
          const configured = { ...input, mode }
          expect(generateWave(configured, 10)).toEqual(expected[mode])
          const explained = explainWave(configured, 10)
          expect(explained.decisions.map(item => item.trackId)).toEqual(expected[mode])
          expect(explainWave(configured, 10)).toEqual(explained)
        }
      }
    }
  })

  it('reports actual signed and capped score factors with the reaction time window', () => {
    const input = context([{ ...track('a', ' Artist '), genres: [' Rock '] }])
    input.listening.preferences = [like('a')]
    const start = event('a', 'started')
    const old = new Date(now - 31 * 86_400_000).toISOString()
    input.listening.events = [
      { ...start, timestamp: old },
      ...Array.from({ length: 3 }, (_, i) => event('a', 'skipped', 's' + i)),
      event('a', 'completed', 'c'),
      { ...event('a', 'completed', 'edge'), timestamp: new Date(now - 30 * 86_400_000).toISOString() },
      { ...event('a', 'completed', 'old'), timestamp: old },
      { ...event('a', 'completed', 'future'), timestamp: new Date(now + 1).toISOString() },
    ]
    const result = explainWave(input, 5)
    expect(result).toMatchObject({ calculatedAt: now, reactionWindowMs: 30 * 86_400_000, recentLimit: 0, seed: 42 })
    expect(result.decisions).toMatchObject([{
      trackId: 'a', score: 3, eligible: 1, selection: 'only-eligible', prioritizedUnheard: false,
      factors: { likedTrack: 6, likedArtist: 2, likedGenre: 1, unheard: 0, completions: 2, skips: -8 },
    }])
  })

  it('traces exploration over a higher score and the repeat and artist exclusions', () => {
    const recent = ['c', 'd', 'e', 'f', 'g']
    const input = context([track('a', 'A'), track('b'), ...recent.map(id => track(id, 'C'))])
    input.listening.preferences = [like('a')]
    input.listening.events = ['a', ...recent].map(id => event(id, 'started'))
    const attempts = Array.from({ length: 10 }, (_, seed) =>
      explainWave({ ...input, mode: 'discovery', seed }, 7))
    const explored = attempts.find(attempt => attempt.decisions[0].prioritizedUnheard)!
    expect(explored.decisions[0]).toMatchObject({
      trackId: 'b', score: 1, selection: 'exploration', eligible: 2, recentExcluded: 5,
      factors: { likedArtist: 0, likedGenre: 0, unheard: 1 },
    })
    expect(explored.decisions[0].explorationRoll).toBeLessThan(0.8)
    expect(explainWave({ ...input, mode: 'familiar', seed: explored.seed }, 7).decisions[0].trackId).toBe('a')
    expect(explored.decisions.every(decision => !decision.recentRelaxed)).toBe(true)
    const diversity = context([track('a', 'A'), track('b', 'A'), track('c', 'C')])
    diversity.listening.events = [event('a', 'started')]
    expect(explainWave(diversity, 1).decisions[0]).toMatchObject({
      trackId: 'c', recentExcluded: 1, sameArtistExcluded: 1, selection: 'only-eligible',
    })
  })

  it('describes ties at cold start and returns no decisions for unavailable or empty catalogs', () => {
    expect(explainWave(context([]), 10).decisions).toEqual([])
    expect(explainWave(context([track('x', null, false)]), 10).decisions).toEqual([])
    const cold = { ...context([track('a'), track('b')]), mode: 'familiar' as const }
    expect(explainWave(cold, 10).decisions).toMatchObject([
      { selection: 'seeded-tie', tiedForChoice: 2, score: 1 },
      { selection: 'only-eligible', tiedForChoice: 1, score: 1 },
    ])
  })
})
