import type { PlaybackQueue, QueueEntry, QueueSource } from '../../shared/contracts'

export function emptyQueue(source: QueueSource = { type: 'library' }): PlaybackQueue {
  return { source, entries: [], current: null, pending: [], history: [], shuffle: false, repeat: 'off' }
}

export function shuffledPending(entries: QueueEntry[], pending: string[], random = Math.random): string[] {
  const manualIds = new Set(entries.filter(entry => entry.kind === 'manual').map(entry => entry.id))
  const positions = pending.flatMap((id, index) => manualIds.has(id) ? [] : [index])
  const result = [...pending]
  for (let index = positions.length - 1; index > 0; index--) {
    const left = positions[index]
    const right = positions[Math.floor(random() * (index + 1))]
    const entry = result[left]
    result[left] = result[right]
    result[right] = entry
  }
  return result
}

export function startQueue(previous: PlaybackQueue, source: QueueSource, entries: QueueEntry[], start: number): PlaybackQueue {
  const queue = { ...emptyQueue(source), entries, shuffle: previous.shuffle, repeat: previous.repeat }
  const [first, ...rest] = entries.slice(start).map(entry => entry.id)
  if (first) queue.pending = [first, ...(queue.shuffle ? shuffledPending(entries, rest) : rest)]
  return queue
}

export function setShuffle(queue: PlaybackQueue, shuffle: boolean): PlaybackQueue {
  const pending = new Set(queue.pending)
  return {
    ...queue, shuffle,
    pending: shuffle ? shuffledPending(queue.entries, queue.pending) :
      queue.entries.filter(entry => pending.has(entry.id)).map(entry => entry.id),
  }
}

export function enqueue(queue: PlaybackQueue, entry: QueueEntry, next: boolean): PlaybackQueue {
  const entries = [...queue.entries]
  const pending = new Set(queue.pending)
  const firstWaiting = next ? entries.findIndex(item => pending.has(item.id)) : -1
  entries.splice(firstWaiting === -1 ? entries.length : firstWaiting, 0, entry)
  return { ...queue, entries, pending: next ? [entry.id, ...queue.pending] : [...queue.pending, entry.id] }
}

export function movePending(queue: PlaybackQueue, id: string, offset: -1 | 1): PlaybackQueue {
  const index = queue.pending.indexOf(id)
  const neighbor = queue.pending[index + offset]
  if (index === -1 || !neighbor) return queue
  const entries = queue.entries.filter(entry => entry.id !== id)
  const entry = queue.entries.find(entry => entry.id === id)!
  entries.splice(entries.findIndex(item => item.id === neighbor) + (offset === 1 ? 1 : 0), 0, entry)
  const pending = [...queue.pending]
  pending[index] = neighbor
  pending[index + offset] = id
  return { ...queue, entries, pending }
}

export function removePending(queue: PlaybackQueue, id?: string): PlaybackQueue {
  const removed = new Set(id === undefined ? queue.pending : queue.pending.filter(item => item === id))
  return { ...queue, entries: queue.entries.filter(entry => !removed.has(entry.id)),
    pending: queue.pending.filter(item => !removed.has(item)) }
}

export function takePending(queue: PlaybackQueue, id: string, rememberCurrent: boolean): PlaybackQueue {
  const history = rememberCurrent && queue.current ? [...queue.history, queue.current] : queue.history
  const pending = queue.pending.filter(item => item !== id)
  if (queue.source.type !== 'wave') return { ...queue, current: id, pending, history }
  const recent = history.slice(-100)
  const retained = new Set([id, ...pending, ...recent])
  return { ...queue, current: id, pending, history: recent, entries: queue.entries.filter(entry => retained.has(entry.id)) }
}

export function previousEntry(queue: PlaybackQueue): string | undefined {
  const lastPlayed = queue.history.at(-1)
  if (lastPlayed || queue.source.type !== 'library' || !queue.current) return lastPlayed
  const index = queue.entries.findIndex(entry => entry.id === queue.current)
  if (index < 1) return undefined
  const pending = new Set(queue.pending)
  return queue.entries.findLast((entry, position) =>
    position < index && entry.kind === 'source' && !pending.has(entry.id))?.id
}

export function goBack(queue: PlaybackQueue, rememberCurrent: boolean): PlaybackQueue {
  const current = previousEntry(queue)
  if (!current) return queue
  return { ...queue, current, history: queue.history.slice(0, -1),
    pending: rememberCurrent && queue.current ? [queue.current, ...queue.pending] : queue.pending }
}

export function repeatQueue(queue: PlaybackQueue): PlaybackQueue {
  const order = queue.entries.map(entry => entry.id)
  const pending = queue.shuffle ? shuffledPending(queue.entries, order) : order
  // Avoid an immediate replay at a shuffled cycle boundary when there is an alternative.
  if (queue.shuffle && pending.length > 1 && pending[0] === queue.current) pending.push(pending.shift()!)
  return { ...queue, current: null, pending, history: [] }
}
