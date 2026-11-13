import { playlistNameLimit, queueEntryLimit, repeatModes } from '../shared/contracts'
import type { PlaybackSession, QueueEntry, QueueSource, RepeatMode } from '../shared/contracts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function invalid(): never {
  throw new Error('Invalid playback session')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

function id(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !uuid.test(value)) return invalid()
  return value
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > queueEntryLimit) return invalid()
  return value
}

function source(value: unknown): QueueSource {
  const { type, id: playlistId, name } = object(value)
  if (type === 'library' || type === 'wave') return { type }
  if (type !== 'playlist' || typeof name !== 'string' || !name.trim() ||
      name.length > playlistNameLimit || /[\u0000-\u001f\u007f]/.test(name)) return invalid()
  return { type, id: id(playlistId), name }
}

export function validatePlaybackSession(input: unknown): PlaybackSession {
  const { position, queue: value } = object(input)
  const queue = object(value)
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 ||
      typeof queue.shuffle !== 'boolean' || !repeatModes.includes(queue.repeat as RepeatMode)) return invalid()
  const entries = list(queue.entries).map((value): QueueEntry => {
    const entry = object(value)
    if (entry.kind !== 'source' && entry.kind !== 'manual' && entry.kind !== 'recommendation') return invalid()
    return { id: id(entry.id), trackId: id(entry.trackId), kind: entry.kind }
  })
  const entryIds = new Set(entries.map(entry => entry.id))
  const current = queue.current === null ? null : id(queue.current)
  const pending = list(queue.pending).map(id)
  const history = list(queue.history).map(id)
  const used = current ? [current, ...pending, ...history] : [...pending, ...history]
  if (entryIds.size !== entries.length || new Set(used).size !== used.length ||
      used.some(item => !entryIds.has(item)) || (!current && position !== 0)) return invalid()
  return { position, queue: { source: source(queue.source), entries, current, pending, history,
    shuffle: queue.shuffle, repeat: queue.repeat as RepeatMode } }
}

export function filterPlaybackSession({ position, queue }: PlaybackSession, keep: (trackId: string) => boolean): PlaybackSession {
  const entries = queue.entries.filter(entry => keep(entry.trackId))
  const entryIds = new Set(entries.map(entry => entry.id))
  const current = queue.current && entryIds.has(queue.current) ? queue.current : null
  return {
    position: current ? position : 0,
    queue: { ...queue, entries, current, pending: queue.pending.filter(id => entryIds.has(id)),
      history: queue.history.filter(id => entryIds.has(id)) },
  }
}
