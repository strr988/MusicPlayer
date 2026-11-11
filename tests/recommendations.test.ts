import { describe, expect, it } from 'vitest'
import type { PlaybackEvent, TrackPreference } from '../src/shared/contracts'
import { generateWave, preferenceQueue, randomQueue } from '../src/recommendations/engine'
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
})

it('measures artist diversity and repeats independently of ranking scores', () => {
  const artists = new Map([['a', 'x'], ['b', 'x'], ['c', 'y'], ['unknown', undefined]])
  expect(measureQueue(['a', 'b', 'unknown', 'a', 'c'], artists, new Set(['a']))).toEqual({
    tracks: 5, knownArtistTracks: 4, distinctArtists: 2, artistDiversity: 0.5,
    sameArtistTransitionRate: 0.5, repeatedTracks: 1, historyRepeats: 2,
  })
  expect(measureQueue(['unknown'], artists, new Set()).artistDiversity).toBeNull()
})
