import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ImportIssue, LibraryTrack, TrackPreference, WaveMode } from '../../shared/contracts'
import { Icon } from './icons'
import { Library } from './library'
import { useMediaControls } from './media-controls'
import { Player } from './player'
import { usePlayback } from './playback'
import { Playlists } from './playlists'
import { QueuePanel } from './queue-panel'
import { Wave } from './wave'

const sections = [
  { id: 'library', label: 'Библиотека', icon: 'library' },
  { id: 'wave', label: 'Моя волна', icon: 'wave' },
  { id: 'playlists', label: 'Плейлисты', icon: 'playlists' },
] as const
type Section = typeof sections[number]['id']

export function App() {
  const [tracks, setTracks] = useState<LibraryTrack[]>([])
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [libraryLoadFailed, setLibraryLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [importing, setImporting] = useState(false)
  const [importNotice, setImportNotice] = useState('')
  const [issues, setIssues] = useState<ImportIssue[]>([])
  const [notice, setNotice] = useState('')
  const [section, setSection] = useState<Section>('library')
  const [playlistRequest, setPlaylistRequest] = useState<{ trackId: string; sequence: number }>()
  const libraryLink = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLElement>(null)
  const trackRead = useRef(0)
  const playback = usePlayback(tracks, trackId => {
    trackRead.current++
    setTracks(previous => previous.map(track => track.id === trackId ? { ...track, available: false } : track))
  })
  useMediaControls(playback)

  const [queueOpen, setQueueOpen] = useState(false)
  const [compactQueue, setCompactQueue] = useState(() => window.matchMedia('(width < 1080px)').matches)
  const queueButton = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [waveMode, setWaveMode] = useState<WaveMode | null>(null)
  const [savingWaveMode, setSavingWaveMode] = useState(false)
  const [preferences, setPreferences] = useState<TrackPreference[]>([])
  const [pendingLike, setPendingLike] = useState(false)
  const [preferencesReady, setPreferencesReady] = useState(false)
  const likedTrackIds = useMemo(() => new Set(preferences.filter(item => item.liked).map(item => item.trackId)), [preferences])
  const anyAvailable = useMemo(() => tracks.some(track => track.available), [tracks])

  useEffect(() => {
    const query = window.matchMedia('(width < 1080px)')
    const update = () => setCompactQueue(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    if (queueOpen) closeButton.current?.focus()
  }, [queueOpen, compactQueue])

  useEffect(() => {
    if (!queueOpen) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        closeQueue()
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [queueOpen])

  function closeQueue() {
    setQueueOpen(false)
    queueButton.current?.focus()
  }

  function openSection(next: Section) {
    if (next !== section) content.current?.scrollTo(0, 0)
    setSection(next)
    if (queueOpen && compactQueue) setQueueOpen(false)
    if (next === 'playlists') void refreshTracks()
  }

  useEffect(() => {
    let active = true
    void window.musicPlayer.getWaveMode().then(mode => {
      if (active) setWaveMode(mode)
    }).catch(() => { if (active) setNotice('Не удалось загрузить режим «Моей волны».') })
    return () => { active = false }
  }, [])

  async function changeWaveMode(mode: WaveMode): Promise<void> {
    if (savingWaveMode) return
    setSavingWaveMode(true)
    setNotice('')
    try {
      await window.musicPlayer.setWaveMode(mode)
      setWaveMode(mode)
    } catch { setNotice('Не удалось сохранить режим «Моей волны».') }
    finally { setSavingWaveMode(false) }
  }

  useEffect(() => {
    let active = true
    void window.musicPlayer.getListeningData().then(data => {
      if (active) { setPreferences(data.preferences); setPreferencesReady(true) }
    }).catch(() => { if (active) setNotice('Не удалось загрузить предпочтения. Перезапустите приложение.') })
    return () => { active = false }
  }, [])

  async function toggleLike(trackId: string): Promise<void> {
    if (pendingLike) return
    setPendingLike(true)
    setNotice('')
    try {
      const value = await window.musicPlayer.setTrackPreference(trackId, !likedTrackIds.has(trackId))
      setPreferences(previous => [...previous.filter(item => item.trackId !== trackId), value])
    } catch { setNotice('Не удалось сохранить лайк.') }
    finally { setPendingLike(false) }
  }

  useEffect(() => {
    let active = true
    void window.musicPlayer.getTracks().then(result => {
      if (active) setTracks(result)
    }).catch(() => {
      if (active) setLibraryLoadFailed(true)
    }).finally(() => { if (active) setLibraryLoading(false) })
    return () => { active = false }
  }, [loadAttempt])

  function retryLibrary() {
    setLibraryLoading(true)
    setLibraryLoadFailed(false)
    setLoadAttempt(attempt => attempt + 1)
  }

  async function refreshTracks(): Promise<void> {
    const current = ++trackRead.current
    try {
      const result = await window.musicPlayer.getTracks()
      if (current === trackRead.current) {
        setTracks(result)
        setLibraryLoadFailed(false)
      }
    } catch {
      if (current === trackRead.current) setNotice('Не удалось проверить доступность треков.')
    }
  }

  async function importFolder(): Promise<void> {
    setImporting(true)
    try {
      const result = await window.musicPlayer.importFolder()
      if (result.status === 'cancelled') return
      setIssues(result.status === 'complete' ? result.issues : [])
      if (result.status === 'failed') {
        setImportNotice('Не удалось открыть папку.')
        return
      }
      trackRead.current++
      setTracks(result.tracks)
      setImportNotice(result.processed > 0 ? 'Файлов обработано: ' + result.processed : 'В папке нет доступных MP3 и FLAC.')
    } catch {
      setIssues([])
      setImportNotice('Не удалось импортировать папку.')
    } finally {
      setImporting(false)
    }
  }

  const covered = queueOpen && compactQueue
  const likeDisabled = !preferencesReady
  return <div className="shell">
    <div className="workspace">
      <nav className="section-nav" aria-label="Разделы">
        <span className="brand-mark" aria-hidden="true"><Icon name="music" /></span>
        {sections.map(item => <button key={item.id} ref={item.id === "library" ? libraryLink : undefined} type="button" aria-label={item.label} title={item.label}
          aria-current={section === item.id ? 'page' : undefined} onClick={() => openSection(item.id)}
          disabled={item.id === 'playlists' && (libraryLoading || importing)}>
          <Icon name={item.icon} /><span>{item.label}</span>
        </button>)}
      </nav>
      <div className="content-frame">
        <main className="content" ref={content} inert={covered}>
          <div className="section-content">
            {notice && <p className="notice" role="alert">{notice}</p>}
            <div hidden={section !== 'library'}>
              <Library tracks={tracks} loading={libraryLoading} loadFailed={libraryLoadFailed} retryLoad={retryLibrary}
                importing={importing} notice={importNotice} issues={issues} importFolder={() => void importFolder()}
                activeId={playback.track?.id} playing={playback.playing} ready={playback.ready}
                likedIds={likedTrackIds} likeDisabled={likeDisabled} toggleLike={id => void toggleLike(id)}
                select={playback.select} addToQueue={playback.addToQueue} addToPlaylist={id => {
                  setPlaylistRequest(request => ({ trackId: id, sequence: (request?.sequence ?? 0) + 1 }))
                  openSection('playlists')
                }} />
            </div>
            <div hidden={section !== 'wave'}>
              <Wave mode={waveMode} saving={savingWaveMode} changeMode={mode => void changeWaveMode(mode)}
                empty={!libraryLoading && !libraryLoadFailed && tracks.length === 0}
                unavailable={tracks.length > 0 && !anyAvailable} ready={playback.ready && !importing && !libraryLoading && !libraryLoadFailed}
                active={playback.mode === 'wave'} playing={playback.playing} loading={playback.loading}
                title={playback.track?.title} notice={playback.waveNotice} start={playback.startWave}
                openLibrary={() => { openSection('library'); libraryLink.current?.focus() }} />
            </div>
            <div hidden={section !== 'playlists'}>
              <Playlists tracks={tracks} playbackReady={playback.ready && !playback.loading}
                request={playlistRequest} onPlay={playback.startPlaylist} refreshTracks={refreshTracks} onQueue={playback.addToQueue} />
            </div>
          </div>
        </main>
        {covered && <div className="queue-scrim" aria-hidden="true" onClick={closeQueue} />}
        {playback.error && <p className="playback-error" role="alert">{playback.error}</p>}
      </div>
      <QueuePanel playback={playback} open={queueOpen} close={closeQueue} closeButton={closeButton} />
    </div>
    <Player playback={playback} hasTracks={tracks.length > 0} liked={!!playback.track && likedTrackIds.has(playback.track.id)}
      likeDisabled={likeDisabled} toggleLike={() => { if (playback.track) void toggleLike(playback.track.id) }}
      queueOpen={queueOpen} queueButton={queueButton} toggleQueue={() => queueOpen ? closeQueue() : setQueueOpen(true)} />
    <p className="sr-only" role="status">Треков в очереди: {playback.queue.pending.length}</p>
  </div>
}
