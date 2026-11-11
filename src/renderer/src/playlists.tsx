import { useEffect, useState } from 'react'
import { playlistNameLimit } from '../../shared/contracts'
import type { LibraryTrack, Playlist } from '../../shared/contracts'
import { Artwork } from './artwork'
import { visibleTracks } from './library-view'
import { TrackQueueActions } from './queue-panel'

interface Props {
  tracks: LibraryTrack[]
  playbackReady: boolean
  onPlay: (playlist: Playlist) => void
  refreshTracks: () => Promise<void>
  onQueue: (id: string, next: boolean) => void
}

export function Playlists({ tracks, playbackReady, onPlay, refreshTracks, onQueue }: Props) {
  const api = window.musicPlayer
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<'create' | 'rename' | 'delete' | null>(null)
  const [name, setName] = useState('')
  const selected = playlists?.find(playlist => playlist.id === selectedId) ?? playlists?.[0]

  useEffect(() => {
    let active = true
    void api.getPlaylists().then(result => {
      if (active) setPlaylists(result)
    }).catch(() => {
      if (active) setError('Не удалось загрузить плейлисты. Откройте раздел повторно.')
    })
    return () => { active = false }
  }, [api])

  async function mutate(action: () => Promise<void>, message: string): Promise<void> {
    setPending(true)
    setError('')
    try { await action() }
    catch { setError(message) }
    finally { setPending(false) }
  }

  async function saveName(): Promise<void> {
    if (editor === 'create') {
      const created = await api.createPlaylist(name)
      setPlaylists(previous => [...(previous ?? []), created])
      setSelectedId(created.id)
    } else if (selected) {
      await api.renamePlaylist(selected.id, name)
      setPlaylists(previous => previous?.map(item => item.id === selected.id ? { ...item, name: name.trim() } : item) ?? [])
    }
    setEditor(null)
  }

  async function deleteSelected(id: string): Promise<void> {
    await api.deletePlaylist(id)
    setPlaylists(previous => previous?.filter(item => item.id !== id) ?? [])
    setSelectedId('')
    setEditor(null)
  }

  async function updateTracks(action: () => Promise<Playlist>): Promise<void> {
    const updated = await action()
    setPlaylists(previous => previous?.map(item => item.id === updated.id ? updated : item) ?? [])
  }

  return (
    <section aria-labelledby="playlist-heading">
      <div className="library-heading flex flex-wrap items-center justify-between gap-3">
        <h1 id="playlist-heading">Плейлисты</h1>
        <button className="primary" disabled={!playlists || pending} onClick={() => { setName(''); setEditor('create') }}>
          Создать плейлист
        </button>
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      {!playlists && !error && <p className="notice" role="status">Загружаем плейлисты…</p>}
      {playlists?.length === 0 && !editor && <p className="notice">Создайте плейлист, чтобы собрать в нём треки из библиотеки.</p>}
      {selected && (
        <div className="playlist-toolbar">
          <select aria-label="Выбрать плейлист" value={selected.id} disabled={pending}
            onChange={event => { setSelectedId(event.currentTarget.value); setEditor(null); setError('') }}>
            {playlists?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button className="secondary" disabled={pending} onClick={() => { setName(selected.name); setEditor('rename') }}>
            Переименовать
          </button>
          <button className="secondary" disabled={pending} onClick={() => setEditor('delete')}>Удалить плейлист</button>
        </div>
      )}
      {(editor === 'create' || editor === 'rename') && (
        <form className="playlist-toolbar" onSubmit={event => {
          event.preventDefault()
          if (!pending && name.trim()) void mutate(saveName, 'Не удалось сохранить название плейлиста.')
        }}>
          <input key={editor} aria-label="Название плейлиста" placeholder="Название плейлиста" required
            maxLength={playlistNameLimit} value={name} disabled={pending}
            onChange={event => setName(event.currentTarget.value)} />
          <button className="primary" disabled={pending || !name.trim()}>Сохранить</button>
          <button type="button" className="secondary" disabled={pending} onClick={() => setEditor(null)}>Отмена</button>
        </form>
      )}
      {selected && editor === 'delete' && (
        <div className="playlist-confirm" role="group" aria-label="Подтверждение удаления">
          <p>Удалить плейлист «{selected.name}»?</p>
          <div className="playlist-toolbar">
            <button className="secondary danger" disabled={pending}
              onClick={() => void mutate(() => deleteSelected(selected.id), 'Не удалось удалить плейлист.')}>
              Подтвердить удаление
            </button>
            <button className="secondary" disabled={pending} onClick={() => setEditor(null)}>Отмена</button>
          </div>
        </div>
      )}
      {selected && (
        <PlaylistTracks key={selected.id} playlist={selected} tracks={tracks} pending={pending}
          playbackReady={playbackReady} onPlay={() => onPlay(selected)} onQueue={onQueue}
          onAdd={trackId => void mutate(async () => {
            try { await updateTracks(() => api.addPlaylistTrack(selected.id, trackId)) }
            catch (error) { await refreshTracks(); throw error }
          }, 'Не удалось добавить трек. Проверьте доступность файла.')}
          onRemove={trackId => void mutate(() => updateTracks(() => api.removePlaylistTrack(selected.id, trackId)),
            'Не удалось убрать трек из плейлиста.')}
          onMove={(trackId, offset) => void mutate(() => updateTracks(() => api.movePlaylistTrack(selected.id, trackId, offset)),
            'Не удалось изменить порядок треков.')} />
      )}
    </section>
  )
}

interface PlaylistTracksProps {
  playlist: Playlist
  tracks: LibraryTrack[]
  pending: boolean
  playbackReady: boolean
  onPlay: () => void
  onQueue: Props['onQueue']
  onAdd: (trackId: string) => void
  onRemove: (trackId: string) => void
  onMove: (trackId: string, offset: -1 | 1) => void
}

function PlaylistTracks({ playlist, tracks, pending, playbackReady, onPlay, onQueue, onAdd, onRemove, onMove }: PlaylistTracksProps) {
  const [query, setQuery] = useState('')
  const [candidateId, setCandidateId] = useState('')
  const byId = new Map(tracks.map(track => [track.id, track]))
  const members = new Set(playlist.trackIds)
  const canPlay = playlist.trackIds.some(id => byId.get(id)?.available)
  const candidates = visibleTracks(tracks, query, '', 'asc').filter(track => track.available && !members.has(track.id))
  const candidate = candidates.find(track => track.id === candidateId)

  return (
    <>
      <div className="playlist-toolbar">
        <button className="primary" disabled={!canPlay || !playbackReady} onClick={onPlay}>Воспроизвести плейлист</button>
      </div>
      <form className="playlist-toolbar playlist-add" onSubmit={event => {
        event.preventDefault()
        if (candidate && !pending) onAdd(candidate.id)
      }}>
        <input type="search" aria-label="Найти трек для добавления" placeholder="Найти трек в библиотеке"
          value={query} onChange={event => setQuery(event.currentTarget.value)} />
        <select aria-label="Трек для добавления" value={candidate?.id ?? ''} disabled={pending || !candidates.length}
          onChange={event => setCandidateId(event.currentTarget.value)}>
          <option value="">{candidates.length ? 'Выберите трек' : 'Нет доступных треков для добавления'}</option>
          {candidates.map(track => <option key={track.id} value={track.id}>
            {track.artist ? `${track.title} — ${track.artist}` : track.title}
          </option>)}
        </select>
        <button className="secondary" disabled={pending || !candidate}>Добавить</button>
      </form>
      {playlist.trackIds.length === 0 && <p className="notice">В плейлисте пока нет треков.</p>}
      <ol className="playlist-tracks" aria-label="Треки плейлиста">
        {playlist.trackIds.map((id, index) => {
          const track = byId.get(id)
          const title = track?.title ?? 'Неизвестный трек'
          return (
            <li key={id} className="playlist-track">
              <Artwork key={track?.artworkUrl} url={track?.artworkUrl ?? null} />
              <div className="min-w-0 flex-1">
                <p className="truncate" title={title}>{title}</p>
                {track?.artist && <p className="muted truncate">{track.artist}</p>}
                {!track?.available && <p className="muted">Файл недоступен</p>}
              </div>
              <TrackQueueActions title={title} disabled={!track?.available || !playbackReady}
                add={next => onQueue(id, next)} />
              <button className="secondary" aria-label={`Выше: ${title}`} title="Переместить выше"
                disabled={pending || index === 0} onClick={() => onMove(id, -1)}>↑</button>
              <button className="secondary" aria-label={`Ниже: ${title}`} title="Переместить ниже"
                disabled={pending || index === playlist.trackIds.length - 1} onClick={() => onMove(id, 1)}>↓</button>
              <button className="secondary" aria-label={`Убрать из плейлиста: ${title}`} title="Убрать из плейлиста"
                disabled={pending} onClick={() => onRemove(id)}>×</button>
            </li>
          )
        })}
      </ol>
    </>
  )
}
