import { useEffect, useMemo, useRef, useState } from 'react'
import { waveModes } from '../../shared/contracts'
import type { ImportIssue, LibraryTrack, TrackPreference, WaveMode } from '../../shared/contracts'
import { Artwork } from './artwork'
import { sortFields, visibleTracks } from './library-view'
import type { SortDirection, SortField } from './library-view'
import { formatTime, usePlayback } from './playback'
import { Playlists } from './playlists'
import { Timeline } from './timeline'

const waveModeLabels: Record<WaveMode, string> = {
  familiar: 'Знакомое', balance: 'Баланс', discovery: 'Открытия',
}

export function App() {
  const [tracks, setTracks] = useState<LibraryTrack[]>([])
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [sortField, setSortField] = useState<SortField | ''>('')
  const [direction, setDirection] = useState<SortDirection>('asc')
  const shown = useMemo(() => visibleTracks(tracks, query, sortField, direction), [tracks, query, sortField, direction])
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [issues, setIssues] = useState<ImportIssue[]>([])
  const [section, setSection] = useState<'library' | 'playlists'>('library')
  const trackRead = useRef(0)
  const playback = usePlayback(tracks, trackId => {
    trackRead.current++
    setTracks(previous => previous.map(track => track.id === trackId ? { ...track, available: false } : track))
  })
  const [waveMode, setWaveMode] = useState<WaveMode | null>(null)
  const [savingWaveMode, setSavingWaveMode] = useState(false)
  const [preferences, setPreferences] = useState<TrackPreference[]>([])
  const [pendingLike, setPendingLike] = useState<string | null>(null)
  const [preferencesReady, setPreferencesReady] = useState(false)
  useEffect(() => {
    let active = true
    void window.musicPlayer.getWaveMode().then(mode => {
      if (active) setWaveMode(mode)
    }).catch(() => { if (active) setNotice('Не удалось загрузить режим «Моей волны».') })
    return () => { active = false }
  }, [])

  async function changeWaveMode(mode: WaveMode): Promise<void> {
    setSavingWaveMode(true)
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
  const likedTrackIds = new Set(preferences.filter(item => item.liked).map(item => item.trackId))

  async function toggleLike(trackId: string): Promise<void> {
    if (pendingLike) return
    setPendingLike(trackId)
    try {
      const liked = preferences.find(item => item.trackId === trackId)?.liked ?? false
      const value = await window.musicPlayer.setTrackPreference(trackId, !liked)
      setPreferences(previous => [...previous.filter(item => item.trackId !== trackId), value])
    } catch { setNotice('Не удалось сохранить лайк.') }
    finally { setPendingLike(null) }
  }

  useEffect(() => {
    let active = true
    void window.musicPlayer.getTracks().then(result => {
      if (active) setTracks(result)
    }).catch(() => {
      if (active) setNotice('Не удалось открыть библиотеку.')
    }).finally(() => { if (active) setLibraryLoading(false) })
    return () => { active = false }
  }, [])

  async function refreshTracks(): Promise<void> {
    const current = ++trackRead.current
    try {
      const result = await window.musicPlayer.getTracks()
      if (current === trackRead.current) setTracks(result)
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
        setNotice('Не удалось открыть папку.')
        return
      }
      trackRead.current++
      setTracks(result.tracks)
      setNotice(result.processed > 0 ? `Файлов обработано: ${result.processed}` : 'В папке нет доступных MP3 и FLAC.')
    } catch {
      setIssues([])
      setNotice('Не удалось импортировать папку.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="shell flex h-dvh flex-col">
      <header className="topbar flex items-center justify-between gap-4">
        <div className="brand flex items-center gap-3">
          <span className="brand-mark" aria-hidden="true">♫</span>
          <span>Music Player</span>
        </div>
        <button className="primary" onClick={() => void importFolder()} disabled={importing || libraryLoading}>
          <span aria-hidden="true">＋</span> {importing ? 'Импорт…' : 'Выбрать папку'}
        </button>
      </header>

      <main className="library min-h-0 flex-1 overflow-auto">
        <nav className="section-nav" aria-label="Разделы">
          <button aria-current={section === 'library' ? 'page' : undefined} onClick={() => setSection('library')}>Библиотека</button>
          <button aria-current={section === 'playlists' ? 'page' : undefined} disabled={libraryLoading || importing}
            onClick={() => { setSection('playlists'); void refreshTracks() }}>Плейлисты</button>
        </nav>
        {(notice || importing) && <p className="notice" role="status">{importing ? 'Читаем папку…' : notice}</p>}
        {issues.length > 0 && (
          <details className="issues">
            <summary>Ошибки импорта ({issues.length})</summary>
            <ul>
              {issues.map((issue) => (
                <li key={issue.entry}>{issue.entry} — {issue.reason === 'directory-unreadable' ? 'папка недоступна' : 'файл не прочитан'}</li>
              ))}
            </ul>
          </details>
        )}
        <div hidden={section !== 'library'}>
          <div className="library-heading flex flex-wrap items-center justify-between gap-3">
            <h1>Библиотека</h1>
            <div className="wave-controls">
              <select aria-label="Режим «Моей волны»" value={waveMode ?? ''} disabled={!waveMode || savingWaveMode}
                onChange={event => void changeWaveMode(event.currentTarget.value as WaveMode)}>
                {!waveMode && <option value="">Режим «Волны»</option>}
                {waveModes.map(mode => <option value={mode} key={mode}>{waveModeLabels[mode]}</option>)}
              </select>
              <button className="primary" disabled={tracks.length === 0 || importing || playback.loading || !playback.volume || !waveMode || savingWaveMode}
                onClick={() => void playback.startWave()}>Моя волна</button>
            </div>
          </div>
          <p className="track-count muted" role="status">Треков: {shown.length}{query.trim() && ` из ${tracks.length}`}</p>
          {tracks.length > 0 && (
            <div className="library-tools">
              <input type="search" aria-label="Поиск по библиотеке" placeholder="Название, исполнитель или альбом"
                value={query} onChange={event => setQuery(event.currentTarget.value)} />
              <label className="sort-control">
                <span>Сортировка</span>
                <select value={sortField} onChange={event => setSortField(event.currentTarget.value as SortField | '')}>
                  <option value="">Порядок импорта</option>
                  {Object.entries(sortFields).map(([field, label]) => <option key={field} value={field}>{label}</option>)}
                </select>
              </label>
              <button className="sort-direction" disabled={!sortField}
                aria-label={direction === 'asc' ? 'Сортировать по убыванию' : 'Сортировать по возрастанию'}
                title={direction === 'asc' ? 'По возрастанию' : 'По убыванию'}
                onClick={() => setDirection(previous => previous === 'asc' ? 'desc' : 'asc')}>
                {direction === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          )}
          {libraryLoading || (importing && tracks.length === 0) ? (
            libraryLoading && <p className="notice" role="status">Загружаем библиотеку…</p>
          ) : tracks.length === 0 ? (
            <div className="empty flex flex-col items-center justify-center text-center">
              <span className="empty-mark" aria-hidden="true">♫</span>
              <h2>Здесь появится ваша музыка</h2>
              <p>Выберите папку с файлами MP3 или FLAC.</p>
            </div>
          ) : shown.length === 0 ? (
            <div className="empty search-empty flex flex-col items-center justify-center text-center">
              <h2>Треки не найдены</h2>
              <button className="clear-search" onClick={() => setQuery('')}>Очистить поиск</button>
            </div>
          ) : (
            <table className="tracks">
              <thead><tr>
                {Object.entries(sortFields).slice(0, 3).map(([field, label]) => (
                  <th key={field} aria-sort={sortField === field ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>{label}</th>
                ))}
                <th className="format-column">Формат</th>
                <th aria-sort={sortField === 'durationSeconds' ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>Время</th>
                <th>Лайк</th>
              </tr></thead>
              <tbody>
                {shown.map((track) => (
                  <tr key={track.id} data-current={track.id === playback.track?.id}>
                    <td><button className="track-button" disabled={!playback.volume} onClick={() => playback.select(track.id)}
                      aria-current={track.id === playback.track?.id ? 'true' : undefined}>
                      <Artwork key={track.artworkUrl} url={track.artworkUrl} />
                      <span className="truncate" title={track.title}>{track.title}</span>
                    </button></td>
                    <td className="truncate" title={track.artist ?? undefined}>{track.artist ?? '—'}</td>
                    <td className="truncate" title={track.album ?? undefined}>{track.album ?? '—'}</td>
                    <td className="format-column"><span className="format">{track.format.toUpperCase()}</span></td>
                    <td>{formatTime(track.durationSeconds)}</td>
                    <td><button aria-label={`Лайк: ${track.title}`}
                      aria-pressed={likedTrackIds.has(track.id)}
                      disabled={!preferencesReady || pendingLike !== null} onClick={() => void toggleLike(track.id)}>
                      {likedTrackIds.has(track.id) ? '♥' : '♡'}
                    </button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div hidden={section !== 'playlists'}>
          <Playlists tracks={tracks} playbackReady={!!playback.volume && !playback.loading}
            onPlay={playback.startPlaylist} refreshTracks={refreshTracks} />
        </div>
      </main>

      <footer className="player" aria-label="Воспроизведение">
        <audio {...playback.audioProps} preload="metadata" />
        {playback.mode === 'wave' && <p className="notice" role="status">
          {playback.waveNotice || (playback.loading ? 'Подбираем трек для «Моей волны»…' : 'Режим «Моя волна»')}
        </p>}
        {playback.mode === 'library' && playback.loading && <p className="notice" role="status">Открываем трек…</p>}
        {playback.playlistName && <p className="notice truncate" role="status">Плейлист «{playback.playlistName}»</p>}
        {playback.error && <p className="playback-error" role="alert">{playback.error}</p>}
        <div className="player-main">
          <div className="now-playing flex min-w-0 items-center gap-3">
            <Artwork key={playback.track?.artworkUrl} url={playback.track?.artworkUrl ?? null} eager />
            <div className="min-w-0">
              <p className="truncate" title={playback.track?.title}>{playback.track?.title ?? 'Трек не выбран'}</p>
              {playback.track?.artist && <p className="muted truncate" title={playback.track.artist}>{playback.track.artist}</p>}
            </div>
          </div>
          <div className="controls flex items-center justify-center gap-3">
            <button aria-label="Предыдущий трек" title="Предыдущий трек" disabled={!playback.canGoBack} onClick={() => playback.step(-1)}>Ⅰ◀</button>
            <button className="play-button" aria-label={playback.playing ? 'Пауза' : 'Воспроизвести'}
              title={playback.playing ? 'Пауза' : 'Воспроизвести'}
              disabled={tracks.length === 0 || playback.loading || !playback.volume} onClick={playback.toggle}>{playback.playing ? '❚❚' : '▶'}</button>
            <button aria-label="Следующий трек" title="Следующий трек" disabled={!playback.canGoNext || !playback.volume} onClick={() => playback.step(1)}>▶Ⅰ</button>
          </div>
          <div className="volume flex items-center gap-2">
            <button className="mute" aria-label="Без звука" aria-pressed={playback.volume?.muted ?? false}
              title={playback.volume?.muted ? 'Включить звук' : 'Отключить звук'} disabled={!playback.volume}
              onClick={() => playback.volume && playback.changeVolume({ ...playback.volume, muted: !playback.volume.muted })}>
              {playback.volume?.muted ? '🔇' : '🔊'}
            </button>
            <input aria-label="Громкость" type="range" min={0} max={100} step={1}
              value={Math.round((playback.volume?.level ?? 1) * 100)} disabled={!playback.volume}
              onChange={event => playback.volume && playback.changeVolume({
                ...playback.volume, level: event.currentTarget.valueAsNumber / 100,
              })} />
            <span>{Math.round((playback.volume?.level ?? 1) * 100)}%</span>
          </div>
          <Timeline audio={playback.audioProps.ref} duration={playback.duration}
            trackDuration={playback.track?.durationSeconds ?? null} seek={playback.seek} />
        </div>
      </footer>
    </div>
  )
}
