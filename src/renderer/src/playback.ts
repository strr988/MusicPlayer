import { useRef, useState } from 'react'
import { ListeningSession } from './listening-session'
import type { Track, PlaybackEventInput } from '../../shared/contracts'

export function formatTime(seconds: number | null): string {
  if (seconds === null) return '—'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function usePlayback(tracks: Track[]) {
  const audio = useRef<HTMLAudioElement>(null)
  const request = useRef(0)
  const session = useRef<ListeningSession | null>(null)
  const writes = useRef(Promise.resolve())
  const [feedbackError, setFeedbackError] = useState('')
  function record(event: PlaybackEventInput): void {
    writes.current = writes.current.then(() => window.musicPlayer.recordPlaybackEvent(event))
      .catch(() => setFeedbackError('Не удалось сохранить историю воспроизведения.'))
  }
  const [trackId, setTrackId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState<number | null>(null)
  const index = tracks.findIndex((track) => track.id === trackId)
  const track = tracks[index]

  async function play(element: HTMLAudioElement, id: number): Promise<void> {
    try {
      await element.play()
    } catch {
      if (id === request.current) showMediaError()
    }
  }

  async function select(id: string): Promise<void> {
    const element = audio.current
    if (!element) return
    const current = ++request.current
    setError('')
    session.current?.finish('manual', element.duration)
    session.current = new ListeningSession(id, crypto.randomUUID(), record)

    element.pause()
    element.removeAttribute('src')
    element.load()
    setPlaying(false)
    setTrackId(id)
    setPosition(0)
    setDuration(null)
    setLoading(true)

    try {
      const source = await window.musicPlayer.getPlayableSource(id)
      if (current !== request.current) return
      if (!source) {
        showMediaError()
        return
      }
      element.src = source.url
      await play(element, current)
    } catch {
      if (current === request.current) showMediaError()
    } finally {
      if (current === request.current) setLoading(false)
    }
  }

  function toggle(): void {
    const element = audio.current
    if (!element || loading) return
    if (!element.paused) {
      request.current++
      element.pause()
    } else if (element.hasAttribute('src') && !element.error && !element.ended) {
      setError('')
      void play(element, ++request.current)
    } else {
      const id = track?.id ?? tracks[0]?.id
      if (id) void select(id)
    }
  }

  function step(offset: -1 | 1): void {
    const target = tracks[index + offset]
    if (target) void select(target.id)
  }

  function showMediaError(): void {
    session.current?.finish('error', audio.current?.duration ?? NaN)
    setPlaying(false)
    setError('Не удалось воспроизвести файл. Если файл был изменён, импортируйте папку повторно.')
  }

  return {
    track, index, playing, loading, error: error || feedbackError, position, duration,
    select, toggle, step,
    seek: (seconds: number) => {
      const element = audio.current
      if (!element || !Number.isFinite(element.duration)) return
      session.current?.suspend()
      element.currentTime = seconds
      setPosition(seconds)
    },
    audioProps: {
      ref: audio,
      onPlaying: () => {
        if (!audio.current?.paused && audio.current?.hasAttribute('src')) {
          session.current?.playing()
          setPlaying(true)
        }
      },
      onPause: () => { session.current?.suspend(); setPlaying(false) },
      onWaiting: () => session.current?.suspend(),
      onSeeking: () => session.current?.suspend(),
      onSeeked: () => {
        const element = audio.current
        if (element && !element.paused && element.readyState >= 3) session.current?.resume()
      },
      onEnded: () => {
        if (!audio.current?.ended) return
        session.current?.finish('ended', audio.current.duration)
        setPlaying(false)
        step(1)
      },
      onTimeUpdate: () => setPosition(audio.current?.currentTime ?? 0),
      onDurationChange: () => {
        const length = audio.current?.duration
        setDuration(length !== undefined && Number.isFinite(length) && length > 0 ? length : null)
      },
      onError: () => { if (audio.current?.error) showMediaError() },
    },
  }
}
