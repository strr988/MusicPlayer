import type { ListeningData, Track, WaveMode, WaveRecommendations, WaveScoreFactors } from '../shared/contracts'

export interface RecommendationCandidate extends Pick<Track, 'id' | 'artist' | 'genres'> {
  available: boolean
}

export interface RecommendationContext {
  candidates: readonly RecommendationCandidate[]
  listening: ListeningData
  now: number
  seed: number
  mode?: WaveMode
}

export type RecommendationEngine = (context: RecommendationContext, count: number) => string[]

const historyWindowMs = 30 * 24 * 60 * 60 * 1000
export const algorithmVersions = { random: 'random-1', preferences: 'likes-1', wave: 'wave-1' } as const
const explorationChance: Record<WaveMode, number> = { familiar: 0, balance: 0.2, discovery: 0.8 }
export const artistKey = (artist: string | null) => artist?.trim().normalize('NFC').toLowerCase() || undefined

function randomFrom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32
  }
}

function shuffledAvailable(context: RecommendationContext): RecommendationCandidate[] {
  const byId = new Map(context.candidates.filter(track => track.available).map(track => [track.id, track]))
  const tracks = [...byId.values()].sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id))
  const random = randomFrom(context.seed)
  for (let i = tracks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const track = tracks[i]
    tracks[i] = tracks[j]
    tracks[j] = track
  }
  return tracks
}

export const randomQueue: RecommendationEngine = (context, count) =>
  shuffledAvailable(context).slice(0, Math.max(0, count)).map(track => track.id)

type PreferenceFactors = Pick<WaveScoreFactors, 'likedTrack' | 'likedArtist' | 'likedGenre'>

function preferenceFactors(context: RecommendationContext): (track: RecommendationCandidate) => PreferenceFactors {
  const liked = new Set(context.listening.preferences.filter(item => item.liked).map(item => item.trackId))
  const likedArtists = new Set<string>()
  const likedGenres = new Set<string>()
  for (const track of context.candidates) {
    if (!liked.has(track.id)) continue
    const artist = artistKey(track.artist)
    if (artist) likedArtists.add(artist)
    for (const genre of track.genres) likedGenres.add(genre.trim().toLowerCase())
  }
  likedGenres.delete('')
  return track => {
    const artist = artistKey(track.artist)
    return {
      likedTrack: 6 * Number(liked.has(track.id)),
      likedArtist: 2 * Number(artist !== undefined && likedArtists.has(artist)),
      likedGenre: Number(track.genres.some(genre => likedGenres.has(genre.trim().toLowerCase()))),
    }
  }
}

const preferenceScore = ({ likedTrack, likedArtist, likedGenre }: PreferenceFactors) => likedTrack + likedArtist + likedGenre

export const preferenceQueue: RecommendationEngine = (context, count) => {
  const factors = preferenceFactors(context)
  return shuffledAvailable(context)
    .map(track => ({ id: track.id, score: preferenceScore(factors(track)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, count))
    .map(track => track.id)
}

export const generateWave: RecommendationEngine = (context, count) => rankWave(context, count)

export function explainWave(context: RecommendationContext, count: number): WaveRecommendations {
  const mode = context.mode ?? 'balance'
  const trace: WaveRecommendations = {
    algorithmVersion: algorithmVersions.wave, mode, calculatedAt: context.now, seed: context.seed,
    reactionWindowMs: historyWindowMs, explorationChance: explorationChance[mode], recentLimit: 0, decisions: [],
  }
  rankWave(context, count, trace)
  return trace
}

function rankWave(context: RecommendationContext, count: number, trace?: WaveRecommendations): string[] {
  const available = shuffledAvailable(context)
  const recentLimit = Math.max(0, Math.min(5, available.length - 1))
  if (trace) trace.recentLimit = recentLimit
  const limit = Math.min(available.length, Math.max(0, Math.floor(count)))
  if (!limit) return []

  const trackArtists = new Map(context.candidates.map(track => [track.id, artistKey(track.artist)]))
  const preferences = preferenceFactors(context)
  const lastHeard = new Map<string, { time: number; order: number }>()
  const skips = new Map<string, number>()
  const completions = new Map<string, number>()
  let order = 0
  for (const event of context.listening.events) {
    const time = Date.parse(event.timestamp)
    if (!Number.isFinite(time) || time > context.now || event.type === 'error') continue
    if (event.type === 'started') {
      if (time >= (lastHeard.get(event.trackId)?.time ?? -Infinity)) {
        lastHeard.set(event.trackId, { time, order })
      }
      order++
    }
    if (time < context.now - historyWindowMs) continue
    if (event.type === 'skipped') skips.set(event.trackId, (skips.get(event.trackId) ?? 0) + 1)
    if (event.type === 'completed') completions.set(event.trackId, (completions.get(event.trackId) ?? 0) + 1)
  }

  const ranked = available.map(track => {
    const unheard = !lastHeard.has(track.id)
    const factors = {
      ...preferences(track), unheard: Number(unheard),
      completions: Math.min(2, completions.get(track.id) ?? 0),
      skips: -4 * Math.min(2, skips.get(track.id) ?? 0) || 0,
    }
    return {
      id: track.id, artist: trackArtists.get(track.id), unheard, factors,
      score: preferenceScore(factors) + factors.unheard + factors.completions + factors.skips,
    }
  }).sort((a, b) => b.score - a.score)

  const availableIds = new Set(available.map(track => track.id))
  const heard = [...lastHeard].sort(([, a], [, b]) => b.time - a.time || b.order - a.order)
  let previousArtist = trackArtists.get(heard[0]?.[0])
  let recent = heard.map(([id]) => id).filter(id => availableIds.has(id)).slice(0, recentLimit)
  const explore = randomFrom(context.seed ^ 0x9e3779b9)
  const chance = explorationChance[context.mode ?? 'balance']
  const queue: string[] = []
  while (queue.length < limit) {
    // Relax the oldest exclusions first if only recently played tracks remain.
    let pool = ranked.filter(track => !recent.includes(track.id))
    const recentExcluded = ranked.length - pool.length
    const recentRelaxed = pool.length === 0
    if (recentRelaxed) {
      const oldest = recent.findLast(id => ranked.some(track => track.id === id))
      pool = ranked.filter(track => track.id === oldest)
    }
    const differentArtist = pool.filter(track => track.artist !== previousArtist || !previousArtist)
    const diverse = differentArtist.length > 0 ? differentArtist : pool
    const explorationRoll = explore()
    const discovery = explorationRoll < chance ? diverse.find(track => track.unheard) : undefined
    const next = discovery ?? diverse[0]
    if (trace) {
      const tiedForChoice = diverse.filter(track => track.score === next.score && (!discovery || track.unheard)).length
      trace.decisions.push({
        trackId: next.id, score: next.score, factors: next.factors, remaining: ranked.length,
        recentExcluded, recentRelaxed, sameArtistExcluded: pool.length - diverse.length, eligible: diverse.length,
        selection: diverse.length === 1 ? 'only-eligible' : discovery ? 'exploration' :
          tiedForChoice > 1 ? 'seeded-tie' : 'highest-score',
        prioritizedUnheard: !!discovery, explorationRoll, tiedForChoice,
      })
    }
    queue.push(next.id)
    ranked.splice(ranked.indexOf(next), 1)
    recent = [next.id, ...recent.filter(id => id !== next.id)].slice(0, recentLimit)
    previousArtist = next.artist
  }
  return queue
}
