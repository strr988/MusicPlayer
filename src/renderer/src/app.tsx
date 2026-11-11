import { useEffect, useState } from 'react'
import type { ImportIssue, Track, TrackPreference } from '../../shared/contracts'
import { formatTime, usePlayback } from './playback'

export function App() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [issues, setIssues] = useState<ImportIssue[]>([])
  const playback = usePlayback(tracks)
  const [preferences, setPreferences] = useState<TrackPreference[]>([])
  const [pendingLike, setPendingLike] = useState<string | null>(null)
  const [preferencesReady, setPreferencesReady] = useState(false)
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
    void window.musicPlayer.getTracks().then(setTracks).catch(() => {
      setNotice('Не удалось открыть библиотеку.')
    })
  }, [])

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
        <button className="primary" onClick={() => void importFolder()} disabled={importing}>
          <span aria-hidden="true">＋</span> {importing ? 'Импорт…' : 'Выбрать папку'}
        </button>
      </header>

      <main className="library min-h-0 flex-1 overflow-auto">
        <div className="library-heading flex items-baseline justify-between gap-4">
          <h1>Библиотека</h1>
          <span className="muted">Треков: {tracks.length}</span>
        </div>
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
        {tracks.length === 0 ? (
          <div className="empty flex flex-col items-center justify-center text-center">
            <span className="empty-mark" aria-hidden="true">♫</span>
            <h2>Здесь появится ваша музыка</h2>
            <p>Выберите папку с файлами MP3 или FLAC.</p>
          </div>
        ) : (
          <table className="tracks">
            <thead><tr><th>Название</th><th>Исполнитель</th><th>Альбом</th><th>Формат</th><th>Время</th><th>Лайк</th></tr></thead>
            <tbody>
              {tracks.map((track) => (
                <tr key={track.id} data-current={track.id === playback.track?.id}>
                  <td><button className="track-button" onClick={() => void playback.select(track.id)}
                    aria-current={track.id === playback.track?.id ? 'true' : undefined}>
                    <span aria-hidden="true" className="track-icon">{track.id === playback.track?.id && playback.playing ? '♫' : '▶'}</span>
                    <span className="truncate" title={track.title}>{track.title}</span>
                  </button></td>
                  <td className="truncate" title={track.artist ?? undefined}>{track.artist ?? '—'}</td>
                  <td className="truncate" title={track.album ?? undefined}>{track.album ?? '—'}</td>
                  <td><span className="format">{track.format.toUpperCase()}</span></td>
                  <td>{formatTime(track.durationSeconds)}</td>
                  <td><button aria-label={`Лайк: ${track.title}`}
                    aria-pressed={likedTrackIds.has(track.id)}
                    disabled={!preferencesReady || pendingLike !== null} onClick={() => void toggleLike(track.id)}>
                    {preferences.some(item => item.trackId === track.id && item.liked) ? '♥' : '♡'}
                  </button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>

      <footer className="player" aria-label="Воспроизведение">
        <audio {...playback.audioProps} preload="metadata" />
        {playback.error && <p className="playback-error" role="alert">{playback.error}</p>}
        <div className="player-main">
          <div className="now-playing flex min-w-0 items-center gap-3">
            <span className="now-mark" aria-hidden="true">♪</span>
            <div className="min-w-0">
              <p className="truncate">{playback.track?.title ?? 'Трек не выбран'}</p>
              {playback.track?.artist && <p className="muted truncate">{playback.track.artist}</p>}
            </div>
          </div>
          <div className="controls flex items-center justify-center gap-3">
            <button aria-label="Предыдущий трек" title="Предыдущий трек" disabled={playback.index <= 0} onClick={() => playback.step(-1)}>Ⅰ◀</button>
            <button className="play-button" aria-label={playback.playing ? 'Пауза' : 'Воспроизвести'}
              title={playback.playing ? 'Пауза' : 'Воспроизвести'}
              disabled={tracks.length === 0 || playback.loading} onClick={playback.toggle}>{playback.playing ? '❚❚' : '▶'}</button>
            <button aria-label="Следующий трек" title="Следующий трек" disabled={playback.index >= tracks.length - 1} onClick={() => playback.step(1)}>▶Ⅰ</button>
          </div>
          <div className="timeline flex items-center gap-2">
            <span>{formatTime(playback.position)}</span>
            <input aria-label="Позиция воспроизведения" type="range" min={0} max={playback.duration ?? 0}
              step={0.01} value={playback.position} disabled={playback.duration === null}
              onChange={(event) => playback.seek(event.currentTarget.valueAsNumber)} />
            <span>{formatTime(playback.duration ?? playback.track?.durationSeconds ?? null)}</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
