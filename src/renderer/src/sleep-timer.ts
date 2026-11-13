export const sleepPresets = [5, 10, 15, 30, 45, 60] as const
export const sleepMaxMinutes = 24 * 60
const fadeMs = 10_000

export type SleepTimer =
  | { kind: 'deadline'; at: number }
  | { kind: 'track'; entryId: string }

export function timedSleep(minutes: number, now: number): SleepTimer | null {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > sleepMaxMinutes) return null
  return { kind: 'deadline', at: now + minutes * 60_000 }
}

export function sleepStatus(timer: SleepTimer | null, now: number, entryId: string | null, trackRemainingMs: number | null) {
  if (!timer) return { remainingMs: null, gain: 1, result: 'idle' } as const
  if (timer.kind === 'track' && timer.entryId !== entryId) {
    return { remainingMs: null, gain: 1, result: 'cancel' } as const
  }
  const remainingMs = timer.kind === 'deadline' ? Math.max(0, timer.at - now) : trackRemainingMs
  const gain = remainingMs === null ? 1 : Math.min(1, Math.max(0, remainingMs / fadeMs))
  const result = timer.kind === 'deadline' && remainingMs === 0 ? 'stop' : 'active'
  return { remainingMs, gain, result } as const
}

export function sleepAtTrackEnd(timer: SleepTimer | null, now: number, entryId: string | null): boolean {
  if (!timer) return false
  return timer.kind === 'track' ? timer.entryId === entryId : now >= timer.at
}

export function fadedVolume(level: number, gain: number): number {
  return level * gain
}
