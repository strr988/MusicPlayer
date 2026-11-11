import { useEffect, useRef, useState } from 'react'
import { ListeningSession } from './listening-session'
import type { LibraryTrack, PlaybackEventInput, Playlist, VolumePreference } from '../../shared/contracts'

export function formatTime(seconds: number | null): string {
  if (seconds === null) return '—'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function usePlayback(tracks: LibraryTrack[], markUnavailable: (trackId: string) => void) {
  const audio = useRef<HTMLAudioElement>(null)
  const [volume, setVolume] = useState<VolumePreference | null>(null)
  const [volumeError, setVolumeError] = useState('')
  const volumeWrite = useRef(0)
  useEffect(() => {
    let active = true
    const apply = (preference: VolumePreference) => {
      if (!active || !audio.current) return
      audio.current.volume = preference.level
      audio.current.muted = preference.muted
      setVolume(preference)
    }
    void window.musicPlayer.getVolume().then(apply).catch(() => {
      if (!active) return
      setVolumeError('Не удалось загрузить громкость.')
      apply({ level: 1, muted: false })
    })
    return () => { active = false }
  }, [])

  function changeVolume(preference: VolumePreference): void {
    const element = audio.current
    if (!element) return
    element.volume = preference.level
    element.muted = preference.muted
    setVolume(preference)
    setVolumeError('')
    const revision = ++volumeWrite.current
    void window.musicPlayer.setVolume(preference.level, preference.muted).catch(() => {
      if (revision === volumeWrite.current) setVolumeError('Не удалось сохранить громкость.')
    })
  }

  const request = useRef(0)
  const session = useRef<ListeningSession | null>(null)
  const writes = useRef(Promise.resolve())
  const [feedbackError, setFeedbackError] = useState('')
  function record(event: PlaybackEventInput): void {
    writes.current = writes.current.then(() => window.musicPlayer.recordPlaybackEvent(event))
      .catch(() => setFeedbackError('Не удалось сохранить историю воспроизведения.'))
  }
  const [trackId, setTrackId] = useState<string | null>(null)
  const [mode, setMode] = useState<'library' | 'playlist' | 'wave'>('library')
  const [playlist, setPlaylist] = useState<Playlist | null>(null)
  const [waveNotice, setWaveNotice] = useState('')
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [duration, setDuration] = useState<number | null>(null)
  const index = tracks.findIndex((track) => track.id === trackId)
  const track = tracks[index]
  const playlistIndex = playlist && trackId ? playlist.trackIds.indexOf(trackId) : -1
  const availableIds = mode === 'playlist' ? new Set(tracks.filter(track => track.available).map(track => track.id)) : null
  const playlistBack = playlist?.trackIds.findLastIndex((id, position) => position < playlistIndex && availableIds?.has(id)) ?? -1
  const playlistNext = playlist?.trackIds.findIndex((id, position) => position > playlistIndex && availableIds?.has(id)) ?? -1

  async function play(element: HTMLAudioElement, id: number): Promise<boolean> {
    try {
      await element.play()
      return true
    } catch {
      if (id === request.current) showMediaError()
      return false
    }
  }

  function resetAudio(element: HTMLAudioElement): number {
    const current = ++request.current
    setError('')
    session.current?.finish('manual', element.duration)
    session.current = null
    element.pause()
    element.removeAttribute('src')
    element.load()
    setPlaying(false)
    setDuration(null)
    setLoading(true)
    return current
  }

  async function loadTrack(element: HTMLAudioElement, id: string, current: number): Promise<boolean> {
    setTrackId(id)
    session.current = new ListeningSession(id, crypto.randomUUID(), record)
    try {
      const source = await window.musicPlayer.getPlayableSource(id)
      if (current !== request.current) return false
      if (!source) {
        markUnavailable(id)
        showMediaError()
        return false
      }
      setError('')
      element.src = source.url
      return await play(element, current)
    } catch {
      if (current === request.current) showMediaError()
      return false
    }
  }

  function select(id: string): void {
    const element = audio.current
    if (!element) return
    const current = resetAudio(element)
    void loadTrack(element, id, current).finally(() => {
      if (current === request.current) setLoading(false)
    })
  }

  async function playPlaylist(ids: readonly string[], start: number, offset: -1 | 1): Promise<void> {
    const element = audio.current
    if (!element || !ids[start]) return
    const current = resetAudio(element)
    try {
      for (let index = start; ids[index] && current === request.current; index += offset) {
        if (availableIds && !availableIds.has(ids[index])) continue
        if (await loadTrack(element, ids[index], current)) break
        if (current === request.current && element.hasAttribute('src')) {
          element.removeAttribute('src')
          element.load()
        }
      }
    } finally {
      if (current === request.current) setLoading(false)
    }
  }

  async function advanceWave(avoidCurrent: boolean): Promise<void> {
    const element = audio.current
    if (!element || loading) return
    setMode('wave')
    setWaveNotice('')
    const current = resetAudio(element)
    try {
      // Finishing the old session enqueues its terminal event before taking a new snapshot.
      await writes.current
      if (current !== request.current) return
      const queue = await window.musicPlayer.getWaveQueue()
      if (current !== request.current) return
      const next = queue.find(id => !avoidCurrent || id !== trackId)
      if (next) {
        await loadTrack(element, next, current)
      } else {
        setTrackId(null)
        setWaveNotice(queue.length > 0 ? 'В «Моей волне» больше нет других доступных треков.' :
          'Для «Моей волны» нет доступных треков. Проверьте папки с музыкой.')
      }
    } catch {
      if (current === request.current) {
        setTrackId(null)
        setError('Не удалось сформировать очередь «Моей волны».')
      }
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
    } else if (mode === 'wave') {
      void advanceWave(false)
    } else if (mode === 'playlist' && playlist) {
      const start = trackId && availableIds?.has(trackId) ? playlistIndex : Math.max(playlistNext, playlistBack)
      void playPlaylist(playlist.trackIds, start, 1)
    } else {
      const id = track?.id ?? tracks[0]?.id
      if (id) void select(id)
    }
  }

  function step(offset: -1 | 1): void {
    if (mode === 'wave') {
      if (offset === 1) void advanceWave(true)
      return
    }
    if (mode === 'playlist' && playlist) {
      void playPlaylist(playlist.trackIds, offset === -1 ? playlistBack : playlistNext, offset)
      return
    }
    const target = tracks[index + offset]
    if (target) void select(target.id)
  }

  function showMediaError(): void {
    session.current?.finish('error', audio.current?.duration ?? NaN)
    setPlaying(false)
    setError('Не удалось воспроизвести файл. Если файл был изменён, импортируйте папку повторно.')
  }

  return {
    track, mode, playlistName: mode === 'playlist' ? playlist?.name : undefined,
    playing, loading, error: error || feedbackError || volumeError, waveNotice, duration,
    volume, changeVolume,
    canGoBack: mode === 'playlist' ? !loading && playlistBack !== -1 : mode === 'library' && index > 0,
    canGoNext: mode === 'wave' ? trackId !== null && !loading :
      mode === 'playlist' ? !loading && playlistNext !== -1 :
        index < tracks.length - 1,
    select: (id: string) => {
      setMode('library')
      setWaveNotice('')
      select(id)
    },
    startWave: () => advanceWave(mode === 'wave'),
    startPlaylist: (value: Playlist) => {
      const available = new Set(tracks.filter(track => track.available).map(track => track.id))
      const trackIds = value.trackIds.filter(id => available.has(id))
      if (!trackIds.length) return
      setMode('playlist')
      setPlaylist({ ...value, trackIds })
      void playPlaylist(trackIds, 0, 1)
    },
    toggle, step,
    seek: (seconds: number) => {
      const element = audio.current
      if (!element || !Number.isFinite(element.duration)) return
      session.current?.suspend()
      element.currentTime = seconds
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
      onDurationChange: () => {
        const length = audio.current?.duration
        setDuration(length !== undefined && Number.isFinite(length) && length > 0 ? length : null)
      },
      onError: () => { if (audio.current?.error) showMediaError() },
    },
  }
}
