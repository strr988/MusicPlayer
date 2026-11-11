import { expect, it } from 'vitest'
import type { PlaybackEventInput } from '../src/shared/contracts'
import { ListeningSession } from '../src/renderer/src/listening-session'

function setup() {
  let time = 0
  const events: PlaybackEventInput[] = []
  const session = new ListeningSession('track', 'session', event => events.push(event), () => time)
  return { session, events, advance: (seconds: number) => { time += seconds * 1000 } }
}

it('records one start and manual skip, including switching while paused', () => {
  const { session, events, advance } = setup()
  session.playing(); session.playing(); advance(2); session.suspend()
  advance(100); session.finish('manual', 10); session.finish('manual', 10)
  expect(events.map(e => e.type)).toEqual(['started', 'skipped'])
  expect(events[1].listenedSeconds).toBe(2)
})

it('pause, buffering and resume create no false skip or duplicate start', () => {
  const { session, events, advance } = setup()
  session.playing(); advance(2); session.suspend(); advance(20); session.playing(); advance(8)
  expect(events.map(e => e.type)).toEqual(['started'])
  session.finish('ended', 10)
  expect(events[1]).toMatchObject({ type: 'completed', listenedSeconds: 10 })
})

it('seeking to the end is not completed listening', () => {
  const { session, events, advance } = setup()
  session.playing(); advance(1); session.suspend(); advance(20)
  session.finish('ended', 100)
  expect(events[1]).toMatchObject({ type: 'ended', listenedSeconds: 1 })
})

it('resumes the clock after seek without manufacturing a playback start', () => {
  const { session, events, advance } = setup()
  session.resume(); advance(10)
  expect(events).toEqual([])
  session.playing(); advance(2); session.suspend(); advance(20)
  session.resume(); advance(8); session.finish('ended', 10)
  expect(events.map(e => e.type)).toEqual(['started', 'completed'])
  expect(events[1].listenedSeconds).toBe(10)
})

it('unavailable sources and decoder errors are errors rather than skips', () => {
  const { session, events } = setup()
  session.finish('error', NaN); session.finish('manual', 10)
  expect(events.map(e => e.type)).toEqual(['error'])
  const playing = setup()
  playing.session.playing(); playing.session.finish('error', 10)
  expect(playing.events.map(e => e.type)).toEqual(['started', 'error'])
})

it('switching before playback begins creates no skip', () => {
  const { session, events } = setup()
  session.finish('manual', NaN); session.playing()
  expect(events).toEqual([])
})
