import { useEffect, useMemo, useRef, useState } from 'react'
import { queueEntryLimit } from '../../shared/contracts'
import type { LibraryTrack, PlaybackEventInput, PlaybackQueue, Playlist, QueueEntry, QueueSource, RepeatMode, VolumePreference } from '../../shared/contracts'
import { ListeningSession } from './listening-session'
import { emptyQueue, enqueue, goBack, movePending, previousEntry, removePending, repeatQueue, setShuffle, startQueue, takePending } from './playback-queue'

export function formatTime(seconds: number | null): string {
  if (seconds === null) return '—'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

const newEntry = (trackId: string, kind: QueueEntry['kind']): QueueEntry => ({ id: crypto.randomUUID(), trackId, kind })
type Transition = 'next' | 'back' | 'restart' | 'jump'

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

  const [queue, setQueue] = useState(() => emptyQueue())
  const queueRef = useRef(queue)
  const position = useRef(0)
  const resumeAt = useRef(0)
  const played = useRef(false)
  const busy = useRef(false)
  const [sessionReady, setSessionReady] = useState(false)
  const [restoredPosition, setRestoredPosition] = useState<number | null>(null)
  const [storageError, setStorageError] = useState('')
  const saveRevision = useRef(0)
  const lastCheckpoint = useRef(0)
  const [waveNotice, setWaveNotice] = useState('')
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [duration, setDuration] = useState<number | null>(null)
  const tracksById = useMemo(() => new Map(tracks.map(track => [track.id, track])), [tracks])
  const entriesById = useMemo(() => new Map(queue.entries.map(entry => [entry.id, entry])), [queue.entries])
  const current = queue.current ? entriesById.get(queue.current) : undefined
  const track = current && tracksById.get(current.trackId)
  const mode = queue.source.type

  useEffect(() => {
    let active = true
    void window.musicPlayer.getPlaybackSession().then(saved => {
      if (!active || !saved) return
      queueRef.current = saved.queue
      position.current = saved.position
      setRestoredPosition(saved.position)
      played.current = saved.queue.current !== null
      setQueue(saved.queue)
    }).catch(() => {
      if (active) setStorageError('Не удалось восстановить очередь воспроизведения.')
    }).finally(() => { if (active) setSessionReady(true) })
    return () => { active = false }
  }, [])

  function persist(): void {
    const revision = ++saveRevision.current
    lastCheckpoint.current = performance.now()
    void window.musicPlayer.setPlaybackSession({ queue: queueRef.current, position: position.current })
      .then(() => { if (revision === saveRevision.current) setStorageError('') })
      .catch(() => { if (revision === saveRevision.current) setStorageError('Не удалось сохранить очередь воспроизведения.') })
  }

  function updateQueue(next: PlaybackQueue): void {
    if (next === queueRef.current) return
    queueRef.current = next
    setQueue(next)
    persist()
  }

  function checkpoint(element: HTMLAudioElement): void {
    if (!busy.current && element.hasAttribute('src') && !element.error && Number.isFinite(element.currentTime)) {
      position.current = element.ended ? 0 : element.currentTime
      persist()
    }
  }

  function showMediaError(): void {
    session.current?.finish('error', audio.current?.duration ?? NaN)
    setPlaying(false)
    setError('Не удалось воспроизвести файл. Если файл был изменён, импортируйте папку повторно.')
  }

  async function play(element: HTMLAudioElement, token: number): Promise<boolean> {
    try {
      await element.play()
      return token === request.current
    } catch {
      if (token === request.current) showMediaError()
      return false
    }
  }

  function resetAudio(element: HTMLAudioElement): number {
    const token = ++request.current
    busy.current = true
    session.current?.finish('manual', element.duration)
    session.current = null
    element.pause()
    element.removeAttribute('src')
    element.load()
    setPlaying(false)
    setDuration(null)
    setRestoredPosition(null)
    setLoading(true)
    setError('')
    setWaveNotice('')
    return token
  }

  async function loadTrack(element: HTMLAudioElement, entry: QueueEntry, token: number): Promise<boolean> {
    if (tracksById.has(entry.trackId)) session.current = new ListeningSession(entry.trackId, crypto.randomUUID(), record)
    try {
      const source = await window.musicPlayer.getPlayableSource(entry.trackId)
      if (token !== request.current) return false
      if (!source) {
        markUnavailable(entry.trackId)
        showMediaError()
        return false
      }
      element.src = source.url
      return await play(element, token)
    } catch {
      if (token === request.current) showMediaError()
      return false
    }
  }

  async function navigate(direction: Transition, options: { id?: string; fresh?: PlaybackQueue; allowSame?: boolean; restore?: boolean } = {}): Promise<void> {
    const element = audio.current
    if (!element || !sessionReady || (busy.current && !options.fresh)) return
    const previous = queueRef.current
    const previousTrack = previous.entries.find(entry => entry.id === previous.current)?.trackId
    let remember = played.current
    const savedPosition = options.restore ? position.current : 0
    const token = resetAudio(element)
    if (options.fresh) {
      remember = false
      played.current = false
      position.current = 0
      updateQueue(options.fresh)
    }
    const attempted = new Set<string>()
    let wrapped = false
    let target = direction
    try {
      while (token === request.current) {
        let state = queueRef.current
        if (target === 'back') {
          const earlier = goBack(state, remember)
          if (earlier === state) break
          state = earlier
        } else if (target !== 'restart') {
          if (target === 'next' && !state.pending.length && state.source.type !== 'wave' &&
              state.repeat === 'all' && state.entries.length && !wrapped) {
            state = repeatQueue(state)
            state.pending = state.pending.filter(id => !attempted.has(id))
            wrapped = true
          }
          let id = target === 'jump' ? options.id : state.pending[0]
          if (!id && state.source.type === 'wave') {
            // The terminal event must reach Main before it takes a recommendation snapshot.
            await writes.current
            if (token !== request.current) return
            const recommendations = await window.musicPlayer.getWaveQueue()
            if (token !== request.current) return
            state = queueRef.current
            id = state.pending[0]
            if (!id) {
              const trackId = recommendations.find(item => !attempted.has(item) && (options.allowSame || item !== previousTrack))
              if (!trackId) {
                setWaveNotice(recommendations.length ? 'В «Моей волне» больше нет других доступных треков.' :
                  'Для «Моей волны» нет доступных треков. Проверьте папки с музыкой.')
                break
              }
              const recommendation = newEntry(trackId, 'recommendation')
              id = recommendation.id
              state = { ...state, entries: [...state.entries, recommendation] }
            }
          }
          if (!id || attempted.has(id)) break
          state = takePending(state, id, remember && !wrapped)
        }
        const entry = state.entries.find(item => item.id === state.current)
        if (!entry || attempted.has(entry.id)) break
        attempted.add(entry.id)
        if (state.source.type === 'wave') attempted.add(entry.trackId)
        played.current = false
        position.current = target === 'restart' ? savedPosition : 0
        resumeAt.current = position.current
        updateQueue(state)
        if (state === previous && target === 'restart') persist()
        if (await loadTrack(element, entry, token)) {
          if (token === request.current) setError('')
          return
        }
        if (token !== request.current) return
        session.current = null
        element.removeAttribute('src')
        element.load()
        remember = false
        if (target !== 'back') target = 'next'
      }
    } catch {
      if (token === request.current) setError('Не удалось сформировать очередь «Моей волны».')
    } finally {
      if (token === request.current) {
        busy.current = false
        setLoading(false)
      }
    }
  }

  function start(source: QueueSource, ids: string[], startAt: number): void {
    if (startAt < 0 || !ids.length) return
    if (ids.length > queueEntryLimit) {
      setError('Очередь вмещает до 50 000 элементов.')
      return
    }
    const entries = ids.map(id => newEntry(id, 'source'))
    void navigate('next', { fresh: startQueue(queueRef.current, source, entries, startAt) })
  }

  function step(offset: -1 | 1): void {
    const state = queueRef.current
    if (offset === -1) {
      if (previousEntry(state)) void navigate('back')
    } else if (state.pending.length || state.source.type === 'wave' ||
        (state.repeat === 'all' && state.entries.length)) {
      void navigate('next')
    }
  }

  function pause(): void {
    const element = audio.current
    if (element && !busy.current) {
      element.pause()
      checkpoint(element)
    }
  }

  function resume(): void {
    const element = audio.current
    if (!element || !sessionReady || !volume || busy.current || !element.paused) return
    const state = queueRef.current
    if (element.hasAttribute('src') && !element.error && !element.ended) {
      setError('')
      void play(element, ++request.current)
    } else if (state.current) {
      void navigate('restart', { restore: !element.ended })
    } else if (state.pending.length || state.source.type === 'wave') {
      void navigate('next', { allowSame: true })
    } else {
      start({ type: 'library' }, tracks.map(item => item.id), 0)
    }
  }

  function toggle(): void {
    if (audio.current?.paused) resume()
    else pause()
  }

  function addToQueue(trackId: string, next: boolean): void {
    const state = queueRef.current
    if (state.entries.length >= queueEntryLimit) {
      setError('Очередь вмещает до 50 000 элементов.')
      return
    }
    updateQueue(enqueue(state, newEntry(trackId, 'manual'), next))
  }

  function seek(seconds: number): void {
    const element = audio.current
    if (!element || !Number.isFinite(element.duration) || !Number.isFinite(seconds)) return
    session.current?.suspend()
    element.currentTime = Math.min(element.duration, Math.max(0, seconds))
  }

  const canGoBack = !loading && !!previousEntry(queue)
  const canGoNext = !loading && (queue.pending.length > 0 || mode === 'wave' ||
    (queue.repeat === 'all' && queue.entries.length > 0))

  return {
    queue, entriesById, tracksById, track, mode, playlistName: queue.source.type === 'playlist' ? queue.source.name : undefined,
    playing, loading, ready: sessionReady && !!volume, error: error || feedbackError || volumeError || storageError,
    waveNotice, duration, restoredPosition, volume, changeVolume, canGoBack, canGoNext,
    addToQueue, pause, resume, toggle, step, seek,
    changeShuffle: () => {
      const state = queueRef.current
      if (state.source.type !== 'wave') updateQueue(setShuffle(state, !state.shuffle))
    },
    changeRepeat: (repeat: RepeatMode) => updateQueue({ ...queueRef.current, repeat }),
    move: (id: string, offset: -1 | 1) => updateQueue(movePending(queueRef.current, id, offset)),
    remove: (id?: string) => updateQueue(removePending(queueRef.current, id)),
    jump: (id: string) => {
      if (queueRef.current.pending.includes(id)) void navigate('jump', { id })
    },
    select: (id: string) => start({ type: 'library' }, tracks.map(item => item.id), tracks.findIndex(item => item.id === id)),
    startPlaylist: (playlist: Playlist) => start({ type: 'playlist', id: playlist.id, name: playlist.name }, playlist.trackIds, 0),
    startWave: () => {
      if (queueRef.current.source.type === 'wave') void navigate('next', { allowSame: !!waveNotice })
      else void navigate('next', { fresh: startQueue(queueRef.current, { type: 'wave' }, [], 0), allowSame: true })
    },
    audioProps: {
      ref: audio,
      onLoadedMetadata: () => {
        const element = audio.current
        if (element && resumeAt.current > 0 && Number.isFinite(element.duration)) {
          // A checkpoint at the end starts this item from its beginning.
          if (resumeAt.current < element.duration) element.currentTime = resumeAt.current
          resumeAt.current = 0
        }
      },
      onPlaying: () => {
        if (!audio.current?.paused && audio.current?.hasAttribute('src')) {
          played.current = true
          session.current?.playing()
          setPlaying(true)
        }
      },
      onPause: () => { session.current?.suspend(); setPlaying(false) },
      onWaiting: () => session.current?.suspend(),
      onSeeking: () => session.current?.suspend(),
      onSeeked: () => {
        const element = audio.current
        if (!element) return
        if (!element.paused && element.readyState >= 3) session.current?.resume()
        checkpoint(element)
      },
      onTimeUpdate: () => {
        if (audio.current && performance.now() - lastCheckpoint.current >= 5_000) checkpoint(audio.current)
      },
      onEnded: () => {
        const element = audio.current
        if (!element?.ended) return
        session.current?.finish('ended', element.duration)
        setPlaying(false)
        checkpoint(element)
        if (queueRef.current.repeat === 'one') void navigate('restart')
        else step(1)
      },
      onDurationChange: () => {
        const length = audio.current?.duration
        setDuration(length !== undefined && Number.isFinite(length) && length > 0 ? length : null)
      },
      onError: () => { if (audio.current?.error) showMediaError() },
    },
  }
}
