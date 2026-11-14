import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultWavePulse } from '../../shared/contracts'
import type { ImportIssue, LibraryTrack, Theme, TrackPreference, WaveMode } from '../../shared/contracts'
import { Icon } from './icons'
import { useDesktopPlayback } from './desktop-playback'
import { DiscoLayer, pulseDisco, useDiscoMode } from './disco'
import { FullPlayer } from './full-player'
import { Library } from './library'
import { LyricsPanel } from './lyrics-panel'
import { useMediaControls } from './media-controls'
import { Player } from './player'
import { PlayerSettings } from './player-settings'
import { usePlayback } from './playback'
import { Playlists } from './playlists'
import { QueuePanel } from './queue-panel'
import { ThemeToggle } from './theme-toggle'
import { Wave } from './wave'
import { WindowTitle } from './window-title'

const sections = [
  { id: 'library', label: 'Библиотека', icon: 'library' },
  { id: 'wave', label: 'Моя волна', icon: 'wave' },
  { id: 'playlists', label: 'Плейлисты', icon: 'playlists' },
  { id: 'lyrics', label: 'Текст песни', icon: 'lyrics' },
  { id: 'settings', label: 'Настройки', icon: 'settings' },
] as const
type Section = typeof sections[number]['id']
type LyricsMode = 'sync' | 'read'

export function App({ initialTheme }: { initialTheme: Theme }) {
  const [tracks, setTracks] = useState<LibraryTrack[]>([])
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [libraryLoadFailed, setLibraryLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [scan, setScan] = useState<'import' | 'rescan' | null>(null)
  const [importNotice, setImportNotice] = useState<{ text: string; processed?: number }>()
  const [issues, setIssues] = useState<ImportIssue[]>([])
  const [notice, setNotice] = useState('')
  const [section, setSection] = useState<Section>('library')
  const [lyricsMode, setLyricsMode] = useState<LyricsMode>('read')
  const beforeLyrics = useRef<Section>('library')
  const lyricsButton = useRef<HTMLButtonElement>(null)
  const fullPlayerButton = useRef<HTMLButtonElement>(null)
  const fullDialog = useRef<HTMLDialogElement>(null)
  const [fullPlayerOpen, setFullPlayerOpen] = useState(false)
  const openingFullPlayer = useRef(false)
  const ownsFullscreen = useRef(false)
  const [playlistRequest, setPlaylistRequest] = useState<{ trackId: string; sequence: number }>()
  const libraryLink = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLElement>(null)
  const trackRead = useRef(0)
  const playback = usePlayback(tracks, trackId => {
    trackRead.current++
    setTracks(previous => previous.map(track => track.id === trackId ? { ...track, available: false } : track))
  })
  useMediaControls(playback)
  const miniVisible = useDesktopPlayback(playback, tracks.length > 0)
  const discoLayer = useRef<HTMLDivElement>(null)
  const fullDiscoLayer = useRef<HTMLDivElement>(null)
  const disco = useDiscoMode(playback.audioEffects, playback.playing && !playback.loading &&
    !playback.volume?.muted && !!playback.volume?.level, strength => {
    if (miniVisible) void window.mustplay.publishDiscoBeat(strength).catch(() => {})
    else pulseDisco(fullPlayerOpen ? fullDiscoLayer.current : discoLayer.current, strength)
  })

  const [queueOpen, setQueueOpen] = useState(false)
  const [compactQueue, setCompactQueue] = useState(() => window.matchMedia('(width < 1080px)').matches)
  const queueButton = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [waveMode, setWaveMode] = useState<WaveMode | null>(null)
  const [wavePulse, setWavePulse] = useState<number | null>(null)
  const pulseWrite = useRef(0)
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
    if (!queueOpen || fullPlayerOpen) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        closeQueue()
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [queueOpen, fullPlayerOpen])

  useEffect(() => {
    const onFullscreenChange = () => {
      if (ownsFullscreen.current && !document.fullscreenElement) void closeFullPlayer()
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  function openFullPlayer() {
    const dialog = fullDialog.current
    if (!dialog || dialog.open || openingFullPlayer.current) return
    function show() {
      openingFullPlayer.current = false
      if (!dialog?.isConnected) return
      dialog.showModal()
      setFullPlayerOpen(true)
    }
    if (document.fullscreenElement || !document.fullscreenEnabled) {
      show()
      return
    }
    openingFullPlayer.current = true
    void document.documentElement.requestFullscreen().then(() => {
      ownsFullscreen.current = document.fullscreenElement === document.documentElement
      show()
    }, show)
  }

  async function closeFullPlayer() {
    if (!fullDialog.current?.open) return
    fullDialog.current.close()
    setFullPlayerOpen(false)
    const exitFullscreen = ownsFullscreen.current && document.fullscreenElement === document.documentElement
    ownsFullscreen.current = false
    if (exitFullscreen) await document.exitFullscreen().catch(() => {})
    fullPlayerButton.current?.focus()
  }

  function openMini() {
    setNotice('')
    void window.mustplay.openMiniPlayer().catch(() => setNotice('Не удалось открыть мини-плеер.'))
  }

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

  function toggleTextMusic() {
    if (section === 'lyrics' && lyricsMode === 'sync') {
      openSection(beforeLyrics.current)
      lyricsButton.current?.focus()
      return
    }
    if (section !== 'lyrics') beforeLyrics.current = section
    setLyricsMode('sync')
    openSection('lyrics')
  }

  useEffect(() => {
    let active = true
    void window.mustplay.getWaveMode().then(mode => {
      if (active) setWaveMode(mode)
    }).catch(() => { if (active) setNotice('Не удалось загрузить режим «Моей волны».') })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    void window.mustplay.getWavePulse().then(value => {
      if (active) setWavePulse(value)
    }).catch(() => {
      if (active) {
        setWavePulse(defaultWavePulse)
        setNotice('Не удалось загрузить силу пульсации.')
      }
    })
    return () => { active = false }
  }, [])

  function changeWavePulse(value: number) {
    setWavePulse(value)
    setNotice('')
    const revision = ++pulseWrite.current
    void window.mustplay.setWavePulse(value).catch(() => {
      if (pulseWrite.current === revision) setNotice('Не удалось сохранить силу пульсации.')
    })
  }

  async function changeWaveMode(mode: WaveMode): Promise<void> {
    if (savingWaveMode) return
    setSavingWaveMode(true)
    setNotice('')
    try {
      await window.mustplay.setWaveMode(mode)
      setWaveMode(mode)
    } catch { setNotice('Не удалось сохранить режим «Моей волны».') }
    finally { setSavingWaveMode(false) }
  }

  useEffect(() => {
    let active = true
    void window.mustplay.getListeningData().then(data => {
      if (active) { setPreferences(data.preferences); setPreferencesReady(true) }
    }).catch(() => { if (active) setNotice('Не удалось загрузить предпочтения. Перезапустите приложение.') })
    return () => { active = false }
  }, [])

  async function toggleLike(trackId: string): Promise<void> {
    if (pendingLike) return
    setPendingLike(true)
    setNotice('')
    try {
      const value = await window.mustplay.setTrackPreference(trackId, !likedTrackIds.has(trackId))
      setPreferences(previous => [...previous.filter(item => item.trackId !== trackId), value])
    } catch { setNotice('Не удалось сохранить лайк.') }
    finally { setPendingLike(false) }
  }

  useEffect(() => {
    let active = true
    void window.mustplay.getTracks().then(result => {
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
      const result = await window.mustplay.getTracks()
      if (current === trackRead.current) {
        setTracks(result)
        setLibraryLoadFailed(false)
      }
    } catch {
      if (current === trackRead.current) setNotice('Не удалось проверить доступность треков.')
    }
  }

  async function scanLibrary(mode: 'import' | 'rescan'): Promise<void> {
    if (scan) return
    const rescan = mode === 'rescan'
    const failure = rescan ? 'Не удалось обновить медиатеку.' : 'Не удалось импортировать папку.'
    setScan(mode)
    try {
      const result = await (rescan ? window.mustplay.rescanLibrary() : window.mustplay.importFolder())
      if (result.status === 'cancelled') return
      setIssues(result.status === 'complete' ? result.issues : [])
      if (result.status === 'failed') {
        setImportNotice({ text: rescan ? failure : 'Не удалось открыть папку.' })
        return
      }
      if (result.status === 'no-folders') {
        setImportNotice({ text: 'Сначала выберите папку с музыкой.' })
        return
      }
      trackRead.current++
      setTracks(result.tracks)
      setLibraryLoadFailed(false)
      setImportNotice(result.processed > 0 ?
        { text: 'Файлов обработано: ' + result.processed, processed: result.processed } :
        { text: rescan ? 'В импортированных папках нет доступных MP3 и FLAC.' : 'В папке нет доступных MP3 и FLAC.' })
    } catch {
      setIssues([])
      setImportNotice({ text: failure })
    } finally {
      setScan(null)
    }
  }

  const covered = queueOpen && compactQueue
  const likeDisabled = !preferencesReady
  const playerControls = {
    playback, hasTracks: tracks.length > 0, liked: !!playback.track && likedTrackIds.has(playback.track.id),
    likeDisabled, toggleLike: () => { if (playback.track) void toggleLike(playback.track.id) },
  }
  return <div className="shell">
    <WindowTitle />
    {disco.enabled && <DiscoLayer ref={discoLayer} />}
    <div className="workspace">
      <nav className="section-nav" aria-label="Разделы" inert={covered}>
        {sections.map(item => <button key={item.id} ref={item.id === "library" ? libraryLink : undefined} type="button" aria-label={item.label} title={item.label}
          aria-current={section === item.id ? 'page' : undefined} onClick={() => {
            if (item.id === 'lyrics' && section !== 'lyrics') {
              beforeLyrics.current = section
              setLyricsMode('read')
            }
            openSection(item.id)
          }}
          disabled={item.id === 'playlists' && (libraryLoading || scan !== null)}>
          <Icon name={item.icon} /><span>{item.label}</span>
        </button>)}
        <ThemeToggle initialTheme={initialTheme} reportError={setNotice} />
      </nav>
      <div className="content-frame">
        <main className="content" ref={content} inert={covered}>
          <div className="section-content">
            {notice && <p className="notice" role="alert">{notice}</p>}
            <div hidden={section !== 'library'}>
              <Library tracks={tracks} loading={libraryLoading} loadFailed={libraryLoadFailed} retryLoad={retryLibrary}
                scan={scan} notice={importNotice} issues={issues} importFolder={() => void scanLibrary('import')}
                rescanLibrary={() => void scanLibrary('rescan')}
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
                unavailable={tracks.length > 0 && !anyAvailable} ready={playback.ready && !scan && !libraryLoading && !libraryLoadFailed}
                active={playback.mode === 'wave'} playing={playback.playing} loading={playback.loading}
                visible={section === 'wave' && !fullPlayerOpen} audio={playback.audioProps.ref}
                pulseIntensity={wavePulse ?? defaultWavePulse}
                recommendation={playback.recommendation}
                title={playback.track?.title} notice={playback.waveNotice} start={playback.startWave}
                openLibrary={() => { openSection('library'); libraryLink.current?.focus() }} />
            </div>
            <div hidden={section !== 'playlists'}>
              <Playlists active={section === 'playlists'} tracks={tracks} playbackReady={playback.ready && !playback.loading}
                request={playlistRequest} onPlay={playback.startPlaylist} refreshTracks={refreshTracks} onQueue={playback.addToQueue} />
            </div>
            <div hidden={section !== 'lyrics'}>
              <LyricsPanel key={JSON.stringify([playback.track?.id, playback.track?.artworkUrl, playback.track?.available])}
                track={playback.track} active={section === 'lyrics' && !fullPlayerOpen} audio={playback.audioProps.ref}
                mode={lyricsMode} changeMode={setLyricsMode} close={toggleTextMusic}
                canSeek={playback.duration !== null && !playback.loading} seek={playback.seek} />
            </div>
            {section === 'settings' && <PlayerSettings playback={playback} wavePulse={wavePulse}
              changeWavePulse={changeWavePulse} openMini={openMini} disco={disco} />}
          </div>
        </main>
        {playback.error && <p className="playback-error" role="alert">{playback.error}</p>}
      </div>
      {covered && <div className="queue-scrim" aria-hidden="true" onClick={closeQueue} />}
      <QueuePanel playback={playback} open={queueOpen} close={closeQueue} closeButton={closeButton} />
    </div>
    <Player {...playerControls} fullPlayerButton={fullPlayerButton} openFullPlayer={openFullPlayer}
      queueOpen={queueOpen} queueButton={queueButton} toggleQueue={() => queueOpen ? closeQueue() : setQueueOpen(true)}
      textMusicOpen={section === 'lyrics' && lyricsMode === 'sync'} textMusicButton={lyricsButton} toggleTextMusic={toggleTextMusic} />
    <FullPlayer {...playerControls} dialog={fullDialog} open={fullPlayerOpen}
      discoLayer={disco.enabled ? <DiscoLayer ref={fullDiscoLayer} /> : null} close={() => void closeFullPlayer()}
      openMini={() => void closeFullPlayer().then(openMini)} />
    <p className="sr-only" role="status">Треков в очереди: {playback.queue.pending.length}</p>
  </div>
}
