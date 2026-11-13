import { expect, it } from 'vitest'
import { fadedVolume, sleepAtTrackEnd, sleepPresets, sleepStatus, timedSleep } from '../src/renderer/src/sleep-timer'

it('starts and replaces a deadline, with bounded integer custom durations', () => {
  for (const minutes of [...sleepPresets, 1, 1440]) {
    expect(timedSleep(minutes, 1000)).toEqual({ kind: 'deadline', at: 1000 + minutes * 60_000 })
  }
  for (const minutes of [0, -5, 1441, 1.1, NaN, Infinity]) expect(timedSleep(minutes, 0)).toBeNull()
  const timer = timedSleep(2, 1000)
  expect(sleepStatus(timer, 60_000, null, null)).toEqual({ remainingMs: 61_000, gain: 1, result: 'active' })
  expect(sleepStatus(timedSleep(1, 60_000), 65_000, 'next', 10)).toEqual({ remainingMs: 55_000, gain: 1, result: 'active' })
})

it('fades toward the deadline across track changes and restores the current user volume on cancel', () => {
  const timer = timedSleep(1, 0)
  const fading = sleepStatus(timer, 55_000, 'new-track', 1000)
  expect(fading).toEqual({ remainingMs: 5000, gain: 0.5, result: 'active' })
  expect(fadedVolume(0.8, fading.gain)).toBe(0.4)
  expect(fadedVolume(0.6, fading.gain)).toBe(0.3)
  expect(sleepStatus(timer, 60_001, 'new-track', null)).toEqual({ remainingMs: 0, gain: 0, result: 'stop' })
  const cancelled = sleepStatus(null, 60_001, 'new-track', null)
  expect(cancelled).toEqual({ remainingMs: null, gain: 1, result: 'idle' })
  expect(fadedVolume(0.6, cancelled.gain)).toBe(0.6)
})

it('waits for the selected queue entry and stops before the repeat or shuffle transition', () => {
  const timer = { kind: 'track', entryId: 'current' } as const
  expect(sleepStatus(timer, 0, 'current', null)).toEqual({ remainingMs: null, gain: 1, result: 'active' })
  expect(sleepStatus(timer, 0, 'current', 2500).gain).toBe(0.25)
  expect(sleepStatus(timer, 0, 'current', 0).result).toBe('active')
  expect(sleepAtTrackEnd(timer, 0, 'current')).toBe(true)
  expect(sleepAtTrackEnd(timer, 0, 'other')).toBe(false)
  expect(sleepStatus(timer, 0, 'other', 2500)).toEqual({ remainingMs: null, gain: 1, result: 'cancel' })
  expect(sleepAtTrackEnd(timedSleep(1, 0), 59_999, 'current')).toBe(false)
  expect(sleepAtTrackEnd(timedSleep(1, 0), 60_000, 'current')).toBe(true)
})
