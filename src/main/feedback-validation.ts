import type { PlaybackEventInput } from '../shared/contracts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function validatePreference(trackId: unknown, liked: unknown): void {
  if (typeof trackId !== 'string' || !uuid.test(trackId) || typeof liked !== 'boolean') {
    throw new Error('Invalid preference')
  }
}

export function validatePlaybackEvent(input: unknown): asserts input is PlaybackEventInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid playback event')
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== 4 ||
      typeof value.trackId !== 'string' || !uuid.test(value.trackId) ||
      typeof value.sessionId !== 'string' || !uuid.test(value.sessionId) ||
      !['started', 'completed', 'skipped', 'ended', 'error'].includes(value.type as string) ||
      typeof value.listenedSeconds !== 'number' || !Number.isFinite(value.listenedSeconds) ||
      value.listenedSeconds < 0 || value.listenedSeconds > 604800) throw new Error('Invalid playback event')
}
