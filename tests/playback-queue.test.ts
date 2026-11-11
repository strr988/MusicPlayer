import { describe, expect, it } from 'vitest'
import { emptyQueue, enqueue, goBack, movePending, removePending, repeatQueue, setShuffle, startQueue, takePending } from '../src/renderer/src/playback-queue'
import type { QueueEntry } from '../src/shared/contracts'

const entry = (id: string, kind: QueueEntry['kind'] = 'source'): QueueEntry => ({ id, trackId: id, kind })

describe('playback queue', () => {
  it.each([1, 2, 4000])('shuffles the remainder of a %i item queue without replaying the current item', size => {
    const entries = Array.from({ length: size }, (_, index) => entry(String(index)))
    const initial = startQueue(emptyQueue(), { type: 'library' }, entries, 0)
    const playing = takePending(initial, '0', false)
    const shuffled = setShuffle(playing, true)
    expect(shuffled.current).toBe('0')
    expect(shuffled.history).toEqual([])
    expect(shuffled.pending).toHaveLength(size - 1)
    expect(new Set(shuffled.pending)).toEqual(new Set(playing.pending))
    expect(setShuffle(shuffled, false)).toEqual(playing)
  })

  it('retains manual priority, duplicates, moves and removals through Shuffle and Repeat All', () => {
    const initial = startQueue(emptyQueue(), { type: 'library' }, ['a', 'b', 'c'].map(id => entry(id)), 0)
    let queue = takePending(initial, 'a', false)
    queue = enqueue(queue, { ...entry('d', 'manual'), trackId: 'a' }, true)
    queue = enqueue(queue, { ...entry('e', 'manual'), trackId: 'a' }, false)
    queue = setShuffle(queue, true)
    expect(queue.pending.at(0)).toBe('d')
    expect(queue.pending.at(-1)).toBe('e')
    queue = removePending(setShuffle(queue, false), 'b')
    queue = movePending(queue, 'e', -1)
    expect(setShuffle(setShuffle(queue, true), false).pending).toEqual(['d', 'e', 'c'])
    queue = takePending(queue, 'e', true)
    expect(queue.pending).toEqual(['d', 'c'])
    expect(goBack(queue, true)).toMatchObject({ current: 'a', history: [], pending: ['e', 'd', 'c'] })
    expect(repeatQueue({ ...queue, repeat: 'all' }).pending).toEqual(['a', 'd', 'e', 'c'])
    expect(removePending(queue)).toMatchObject({ current: 'e', pending: [], history: ['a'] })
  })

  it('does not replay the previous item immediately on a shuffled wrap with alternatives', () => {
    const initial = startQueue(emptyQueue(), { type: 'library' }, ['a', 'b'].map(id => entry(id)), 0)
    const queue = takePending(takePending(initial, 'a', false), 'b', true)
    const wrapped = repeatQueue({ ...queue, repeat: 'all', shuffle: true })
    expect(wrapped).toMatchObject({ current: null, history: [], pending: ['a', 'b'] })
  })

  it('keeps earlier library tracks reachable when starting in the middle without fabricating history', () => {
    const initial = startQueue(emptyQueue(), { type: 'library' }, ['a', 'b', 'c'].map(id => entry(id)), 1)
    const queue = takePending(initial, 'b', false)
    expect(queue.history).toEqual([])
    expect(goBack(queue, true)).toMatchObject({ current: 'a', history: [], pending: ['b', 'c'] })
  })
})
