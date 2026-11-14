import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { defaultSoundSettings, queueEntryLimit, soundEffectRates } from '../../shared/contracts'
import type { LibraryTrack, PlaybackEventInput, PlaybackQueue, Playlist, QueueEntry, QueueSource, RepeatMode, SoundEffect, SoundSettings, VolumePreference, WaveDecision, WaveRecommendations } from '../../shared/contracts'
import { createAudioEffects } from './audio-effects'
import type { AudioEffects } from './audio-effects'
import { ListeningSession } from './listening-session'
import { emptyQueue, enqueue, goBack, movePending, previousEntry, removePending, repeatQueue, setShuffle, startQueue, takePending } from './playback-queue'
import { fadedVolume, sleepAtTrackEnd, sleepStatus } from './sleep-timer'
import type { SleepTimer } from './sleep-timer'

export function formatTime(seconds: number | null): string {
  if (seconds === null) return '—'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function applySoundEffect(element: HTMLAudioElement, effect: SoundEffect): void {
  const rate = soundEffectRates[effect]
  element.preservesPitch = effect === 'original'
  element.defaultPlaybackRate = rate
  element.playbackRate = rate
}

const newEntry = (trackId: string, kind: QueueEntry['kind']): QueueEntry => ({ id: crypto.randomUUID(), trackId, kind })
type Transition = 'next' | 'back' | 'restart' | 'jump'

export interface RecommendationExplanation {
  calculation: Omit<WaveRecommendations, 'decisions'>
  decision: WaveDecision
  rank: number
  previousTrackExcluded: boolean
  attemptedExcluded: number
}

export function usePlayback(tracks: LibraryTrack[], markUnavailable: (trackId: string) => void) {
  const audio = useRef<HTMLAudioElement>(null)
  const [volume, setVolume] = useState<VolumePreference | null>(null)
  const volumeRef = useRef<VolumePreference | null>(null)
  const gain = useRef(1)
  const [volumeError, setVolumeError] = useState('')
  const volumeWrite = useRef(0)
  const [sound, setSound] = useState<SoundSettings | null>(null)
  const [savingSoundEffect, setSavingSoundEffect] = useState(false)
  const savingSound = useRef(false)
  const [soundEffectError, setSoundEffectError] = useState('')
  const audioEffects = useRef<AudioEffects>(null)
  useEffect(() => () => { void audioEffects.current?.context.close().catch(() => {}) }, [])
  useEffect(() => {
    let active = true
    const apply = (preference: VolumePreference) => {
      if (!active || !audio.current) return
      audio.current.volume = fadedVolume(preference.level, gain.current)
      audio.current.muted = preference.muted
      volumeRef.current = preference
      setVolume(preference)
    }
    void window.mustplay.getVolume().then(apply).catch(() => {
      if (!active) return
      setVolumeError('Не удалось загрузить громкость.')
      apply({ level: 1, muted: false })
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    const apply = (settings: SoundSettings) => {
      if (!active || !audio.current) return
      applySoundEffect(audio.current, settings.effect)
      setSound(settings)
    }
    void window.mustplay.getSoundEffect().then(apply).catch(() => {
      if (!active) return
      setSoundEffectError('Не удалось загрузить звуковой эффект.')
      apply(defaultSoundSettings)
    })
    return () => { active = false }
  }, [])

  function changeVolume(preference: VolumePreference): void {
    const element = audio.current
    if (!element) return
    element.volume = fadedVolume(preference.level, gain.current)
    element.muted = preference.muted
    audioEffects.current?.setMuted(preference.muted || element.volume === 0)
    volumeRef.current = preference
    setVolume(preference)
    setVolumeError('')
    const revision = ++volumeWrite.current
    void window.mustplay.setVolume(preference.level, preference.muted).catch(() => {
      if (revision === volumeWrite.current) setVolumeError('Не удалось сохранить громкость.')
    })
  }

  const request = useRef(0)
  const session = useRef<ListeningSession | null>(null)
  const writes = useRef(Promise.resolve())
  const [feedbackError, setFeedbackError] = useState('')
  function record(event: PlaybackEventInput): void {
    writes.current = writes.current.then(() => window.mustplay.recordPlaybackEvent(event))
      .catch(() => setFeedbackError('Не удалось сохранить историю воспроизведения.'))
  }

  const [queue, setQueue] = useState(() => emptyQueue())
  const queueRef = useRef(queue)
  const [sleep, setSleep] = useState<SleepTimer | null>(null)
  const sleepRef = useRef<SleepTimer | null>(null)
  const sleepPauseRequested = useRef(false)
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
  const [explanations, setExplanations] = useState<Map<string, RecommendationExplanation>>(() => new Map())
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [duration, setDuration] = useState<number | null>(null)
  const tracksById = useMemo(() => new Map(tracks.map(track => [track.id, track])), [tracks])
  const entriesById = useMemo(() => new Map(queue.entries.map(entry => [entry.id, entry])), [queue.entries])
  const current = queue.current ? entriesById.get(queue.current) : undefined
  const track = current && tracksById.get(current.trackId)
  const mode = queue.source.type
  const ready = sessionReady && !!volume && sound !== null

  async function saveSound(next: SoundSettings, persistSetting: () => Promise<void>): Promise<void> {
    if (savingSound.current) return
    savingSound.current = true
    setSavingSoundEffect(true)
    setSoundEffectError('')
    try {
      await persistSetting()
      const element = audio.current
      if (!element) return
      session.current?.setRate(soundEffectRates[next.effect])
      applySoundEffect(element, next.effect)
      audioEffects.current?.setReverb(next.reverb[next.effect])
      if (sleepRef.current) updateSleep()
      setSound(next)
    } catch {
      setSoundEffectError('Не удалось сохранить звуковой эффект.')
    } finally {
      savingSound.current = false
      setSavingSoundEffect(false)
    }
  }

  function changeSoundEffect(effect: SoundEffect): void {
    if (!sound || effect === sound.effect) return
    void saveSound({ ...sound, effect }, () => window.mustplay.setSoundEffect(effect))
  }

  function changeReverb(effect: SoundEffect, enabled: boolean): void {
    if (!sound || sound.reverb[effect] === enabled) return
    void saveSound({ ...sound, reverb: { ...sound.reverb, [effect]: enabled } },
      () => window.mustplay.setReverb(effect, enabled))
  }

  useEffect(() => {
    let active = true
    void window.mustplay.getPlaybackSession().then(saved => {
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
    void window.mustplay.setPlaybackSession({ queue: queueRef.current, position: position.current })
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

  function applyGain(next: number): void {
    if (gain.current === next) return
    gain.current = next
    if (audio.current && volumeRef.current) {
      audio.current.volume = fadedVolume(volumeRef.current.level, next)
      audioEffects.current?.setMuted(audio.current.muted || audio.current.volume === 0)
    }
  }

  function changeSleep(timer: SleepTimer | null): void {
    sleepRef.current = timer
    setSleep(timer)
    if (timer) updateSleep()
    else applyGain(1)
  }

  function stopForSleep(): void {
    sleepPauseRequested.current = true
    audio.current?.pause()
    if (audio.current) checkpoint(audio.current)
    changeSleep(null)
  }

  function updateSleep(): void {
    const element = audio.current
    const remaining = element && Number.isFinite(element.duration)
      ? Math.max(0, element.duration - element.currentTime) / element.playbackRate * 1000 : null
    const status = sleepStatus(sleepRef.current, Date.now(), queueRef.current.current, remaining)
    applyGain(status.gain)
    if (status.result === 'stop') stopForSleep()
    if (status.result === 'cancel') changeSleep(null)
  }

  const tickSleep = useEffectEvent(updateSleep)
  useEffect(() => {
    if (!sleep) return
    const tick = setInterval(() => tickSleep(), 100)
    return () => clearInterval(tick)
  }, [sleep])

  function showMediaError(): void {
    if (sleepRef.current?.kind === 'track') changeSleep(null)
    session.current?.finish('error', audio.current?.duration ?? NaN)
    setPlaying(false)
    setError('Не удалось воспроизвести файл. Если файл был изменён, импортируйте папку повторно.')
  }

  async function play(element: HTMLAudioElement, token: number): Promise<boolean> {
    try {
      audioEffects.current ??= createAudioEffects(element)
      audioEffects.current.setMuted(element.muted || element.volume === 0)
      if (sound) audioEffects.current.setReverb(sound.reverb[sound.effect])
      if (audioEffects.current.context.state !== 'running') void audioEffects.current.context.resume().catch(() => {})
    } catch {
      setSoundEffectError('Не удалось подключить обработку звука.')
    }
    try {
      await element.play()
      return token === request.current
    } catch {
      if (token === request.current && sleepPauseRequested.current && element.paused && !element.error) return true
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
    audioEffects.current?.resetReverb()
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
    if (tracksById.has(entry.trackId)) {
      session.current = new ListeningSession(entry.trackId, crypto.randomUUID(), record)
      session.current.setRate(element.playbackRate)
    }
    try {
      const source = await window.mustplay.getPlayableSource(entry.trackId)
      if (token !== request.current) return false
      if (!source) {
        markUnavailable(entry.trackId)
        showMediaError()
        return false
      }
      element.src = source.url
      if (sleepPauseRequested.current) return true
      return await play(element, token)
    } catch {
      if (token === request.current) showMediaError()
      return false
    }
  }

  async function navigate(direction: Transition, options: { id?: string; fresh?: PlaybackQueue; allowSame?: boolean; restore?: boolean } = {}): Promise<void> {
    const element = audio.current
    if (!element || !ready || (busy.current && !options.fresh)) return
    const previous = queueRef.current
    const previousTrack = previous.entries.find(entry => entry.id === previous.current)?.trackId
    let remember = played.current
    const savedPosition = options.restore ? position.current : 0
    if (sleepRef.current?.kind === 'track' && (direction !== 'restart' || options.fresh)) changeSleep(null)
    sleepPauseRequested.current = false
    const token = resetAudio(element)
    if (options.fresh) {
      setExplanations(new Map())
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
            const { decisions, ...calculation } = await window.mustplay.getWaveRecommendations()
            if (token !== request.current) return
            state = queueRef.current
            id = state.pending[0]
            if (!id) {
              let previousTrackExcluded = false
              let attemptedExcluded = 0
              const index = decisions.findIndex(({ trackId }) => {
                if (attempted.has(trackId)) {
                  attemptedExcluded++
                  return false
                }
                if (!options.allowSame && trackId === previousTrack) {
                  previousTrackExcluded = true
                  return false
                }
                return true
              })
              const decision = decisions[index]
              if (!decision) {
                setWaveNotice(decisions.length ? 'В «Моей волне» больше нет других доступных треков.' :
                  'Для «Моей волны» нет доступных треков. Проверьте папки с музыкой.')
                break
              }
              const recommendation = newEntry(decision.trackId, 'recommendation')
              setExplanations(previous => new Map([...previous].slice(-99)).set(recommendation.id, {
                calculation, decision, rank: index + 1, previousTrackExcluded, attemptedExcluded,
              }))
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
    if (!element || !ready || busy.current || !element.paused) return
    sleepPauseRequested.current = false
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
    playing, loading, ready, error: error || feedbackError || volumeError || storageError,
    waveNotice, duration, restoredPosition, volume, changeVolume, canGoBack, canGoNext,
    sound, savingSoundEffect, soundEffectError, changeSoundEffect, changeReverb, audioEffects,
    sleep, changeSleep, currentEntryId: queue.current,
    adjustVolume: (offset: number) => {
      const current = volumeRef.current
      if (!current) return
      const level = Math.min(1, Math.max(0, Math.round((current.level + offset) * 100) / 100))
      changeVolume({ ...current, level, muted: offset > 0 ? false : current.muted })
    },
    toggleMute: () => {
      const current = volumeRef.current
      if (current) changeVolume({ ...current, muted: !current.muted })
    },
    setVolumeLevel: (level: number) => {
      const current = volumeRef.current
      if (current) changeVolume({ ...current, level })
    },
    recommendation: current?.kind === 'recommendation' ? { entryId: current.id, explanation: explanations.get(current.id) } : undefined,
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
          if (sleepRef.current) updateSleep()
          if (audio.current.paused) return
          played.current = true
          session.current?.playing()
          setPlaying(true)
        }
      },
      onPause: () => {
        session.current?.suspend()
        if (!audio.current?.ended) audioEffects.current?.resetReverb()
        setPlaying(false)
      },
      onWaiting: () => session.current?.suspend(),
      onSeeking: () => session.current?.suspend(),
      onSeeked: () => {
        const element = audio.current
        if (!element) return
        if (!element.paused && element.readyState >= 3) session.current?.resume()
        if (sleepRef.current) updateSleep()
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
        if (sleepAtTrackEnd(sleepRef.current, Date.now(), queueRef.current.current)) {
          stopForSleep()
          return
        }
        checkpoint(element)
        // A timer tick may pause an ended element before Chromium delivers its ended event.
        if (sleepPauseRequested.current) return
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
