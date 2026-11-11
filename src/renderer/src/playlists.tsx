import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { playlistNameLimit } from '../../shared/contracts'
import type { LibraryTrack, Playlist } from '../../shared/contracts'
import { Artwork } from './artwork'
import { EmptyState } from './empty-state'
import { Icon, IconButton } from './icons'
import { visibleTracks } from './library-view'
import { TrackQueueActions } from './queue-panel'

interface Props {
  active: boolean
  tracks: LibraryTrack[]
  playbackReady: boolean
  request?: { trackId: string; sequence: number }
  onPlay: (playlist: Playlist) => void
  refreshTracks: () => Promise<void>
  onQueue: (id: string, next: boolean) => void
}

export function Playlists({ active, tracks, playbackReady, request, onPlay, refreshTracks, onQueue }: Props) {
  const api = window.musicPlayer
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<'create' | 'rename' | 'delete' | null>(null)
  const [name, setName] = useState('')
  const createButton = useRef<HTMLButtonElement>(null)
  const renameButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const cancelDelete = useRef<HTMLButtonElement>(null)
  const addForm = useRef<HTMLFormElement>(null)
  const handledRequest = useRef<number | undefined>(undefined)
  const focusAfterEdit = useRef<'create' | 'rename' | 'delete' | null>(null)
  const focusAfterAdd = useRef(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const selected = playlists?.find(playlist => playlist.id === selectedId) ?? playlists?.[0]

  useLayoutEffect(() => {
    if (!active || !playlists || !request || handledRequest.current === request.sequence) return
    const target = selected ? addForm.current?.querySelector<HTMLElement>('select:enabled') ??
      addForm.current?.querySelector('input') : createButton.current
    if (target) {
      handledRequest.current = request.sequence
      target.focus()
    }
  }, [active, playlists, request, selected])

  useLayoutEffect(() => {
    if (editor === 'delete') cancelDelete.current?.focus()
    if (pending || editor || !focusAfterEdit.current) return
    const action = focusAfterEdit.current
    focusAfterEdit.current = null
    const target = action === 'rename' ? renameButton.current : action === 'delete' ?
      deleteButton.current ?? createButton.current : createButton.current
    target?.focus()
  }, [editor, pending])

  useLayoutEffect(() => {
    if (!active || pending || !focusAfterAdd.current) return
    focusAfterAdd.current = false
    addForm.current?.querySelector('input')?.focus()
  }, [active, pending])

  useEffect(() => {
    let active = true
    void api.getPlaylists().then(result => {
      if (active) setPlaylists(result)
    }).catch(() => {
      if (active) setError('Не удалось загрузить плейлисты.')
    })
    return () => { active = false }
  }, [api, loadAttempt])

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
    closeEditor()
  }

  async function deleteSelected(id: string): Promise<void> {
    await api.deletePlaylist(id)
    setPlaylists(previous => previous?.filter(item => item.id !== id) ?? [])
    setSelectedId('')
    closeEditor()
  }

  function closeEditor() {
    focusAfterEdit.current = editor
    setEditor(null)
  }

  function beginCreate() {
    setName('')
    setEditor('create')
  }

  async function updateTracks(action: () => Promise<Playlist>): Promise<void> {
    const updated = await action()
    setPlaylists(previous => previous?.map(item => item.id === updated.id ? updated : item) ?? [])
  }

  return (
    <section aria-labelledby="playlist-heading">
      <header className="section-heading">
        <h1 id="playlist-heading">Плейлисты</h1>
        {selected && <button ref={createButton} className="secondary" disabled={pending} onClick={beginCreate}>
          <Icon name="plus" /> Создать плейлист
        </button>}
      </header>
      {error && <p className="notice" role="alert">{error}</p>}
      {!playlists && (error ? <button className="secondary" onClick={() => {
        setError('')
        setLoadAttempt(attempt => attempt + 1)
      }}>Повторить загрузку</button> : <p className="notice" role="status">Загружаем плейлисты…</p>)}
      {playlists?.length === 0 && !editor && <EmptyState icon="playlists" title="Соберите первый плейлист"
        action={<button ref={createButton} className="primary" disabled={pending} onClick={beginCreate}>
          <Icon name="plus" /> Создать плейлист
        </button>}>
        Создайте подборку и добавьте в неё треки из библиотеки.
      </EmptyState>}
      {selected && (
        <label className="playlist-picker">
          <span className="muted">Ваши плейлисты · {playlists?.length}</span>
          <select aria-label="Выбрать плейлист" value={selected.id} disabled={pending}
            onChange={event => { setSelectedId(event.currentTarget.value); setEditor(null); setError('') }}>
            {playlists?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      )}
      {(editor === 'create' || editor === 'rename') && (
        <form className="playlist-toolbar" onSubmit={event => {
          event.preventDefault()
          if (!pending && name.trim()) void mutate(saveName, 'Не удалось сохранить название плейлиста.')
        }}>
          <input key={editor} autoFocus aria-label="Название плейлиста" placeholder="Название плейлиста" required
            maxLength={playlistNameLimit} value={name} disabled={pending}
            onChange={event => setName(event.currentTarget.value)} />
          <button className="primary" disabled={pending || !name.trim()}>Сохранить</button>
          <button type="button" className="secondary" disabled={pending} onClick={closeEditor}>Отмена</button>
        </form>
      )}
      {selected && (
        <PlaylistTracks key={selected.id + ":" + (request?.sequence ?? 0)} playlist={selected} tracks={tracks}
          pending={pending} active={active} addForm={addForm}
          playbackReady={playbackReady} initialCandidateId={request?.trackId} onPlay={() => onPlay(selected)} onQueue={onQueue}
          actions={<>
            <button ref={renameButton} className="secondary" disabled={pending} onClick={() => { setName(selected.name); setEditor('rename') }}>
              Переименовать
            </button>
            <button ref={deleteButton} className="text-button" disabled={pending} aria-expanded={editor === 'delete'}
              onClick={() => setEditor('delete')}>Удалить плейлист</button>
          </>}
          confirmation={editor === 'delete' && (
            <div className="playlist-confirm" role="group" aria-labelledby="playlist-delete-title"
              onKeyDown={event => {
                if (event.key === 'Escape' && !pending) { event.preventDefault(); closeEditor() }
              }}>
              <p id="playlist-delete-title">Удалить плейлист «{selected.name}»?</p>
              <p className="muted">Композиции останутся в библиотеке.</p>
              <div className="playlist-toolbar">
                <button ref={cancelDelete} className="secondary" disabled={pending} onClick={closeEditor}>Отмена</button>
                <button className="secondary danger" disabled={pending}
                  onClick={() => void mutate(() => deleteSelected(selected.id), 'Не удалось удалить плейлист.')}>
                  Подтвердить удаление
                </button>
              </div>
            </div>
          )}
          onAdd={trackId => {
            focusAfterAdd.current = true
            void mutate(async () => {
            try { await updateTracks(() => api.addPlaylistTrack(selected.id, trackId)) }
            catch (error) { await refreshTracks(); throw error }
            }, 'Не удалось добавить трек. Проверьте доступность файла.')
          }}
          onRemove={trackId => void mutate(() => updateTracks(() => api.removePlaylistTrack(selected.id, trackId)),
            'Не удалось убрать трек из плейлиста.')}
          onMove={(trackId, offset) => void mutate(() => updateTracks(() => api.movePlaylistTrack(selected.id, trackId, offset)),
            'Не удалось изменить порядок треков.')} />
      )}
    </section>
  )
}

interface PlaylistTracksProps {
  active: boolean
  actions: ReactNode
  confirmation: ReactNode
  addForm: RefObject<HTMLFormElement | null>
  playlist: Playlist
  tracks: LibraryTrack[]
  pending: boolean
  playbackReady: boolean
  initialCandidateId?: string
  onPlay: () => void
  onQueue: Props['onQueue']
  onAdd: (trackId: string) => void
  onRemove: (trackId: string) => void
  onMove: (trackId: string, offset: -1 | 1) => void
}

function PlaylistTracks({ active, actions, confirmation, addForm, playlist, tracks, pending, playbackReady,
  initialCandidateId, onPlay, onQueue, onAdd, onRemove, onMove }: PlaylistTracksProps) {
  const [query, setQuery] = useState('')
  const [candidateId, setCandidateId] = useState(initialCandidateId ?? '')
  const byId = useMemo(() => new Map(tracks.map(track => [track.id, track])), [tracks])
  const members = useMemo(() => new Set(playlist.trackIds), [playlist.trackIds])
  const canPlay = playlist.trackIds.some(id => byId.get(id)?.available)
  const candidates = useMemo(() => active ? visibleTracks(tracks, query, '', 'asc')
    .filter(track => track.available && !members.has(track.id)) : [], [active, tracks, query, members])
  const candidate = candidates.find(track => track.id === candidateId)

  return (
    <>
      <header className="playlist-detail">
        <div className="playlist-identity">
          <span className="empty-mark" aria-hidden="true"><Icon name="playlists" /></span>
          <div className="min-w-0">
            <h2 title={playlist.name}>{playlist.name}</h2>
            <p className="muted">Треков: {playlist.trackIds.length}</p>
          </div>
        </div>
        <div className="playlist-toolbar">
          <button className="primary" disabled={!canPlay || !playbackReady} onClick={onPlay}><Icon name="play" />Воспроизвести плейлист</button>
          {actions}
        </div>
      </header>
      {confirmation}
      <form ref={addForm} className="playlist-add" aria-labelledby="playlist-add-heading" onSubmit={event => {
        event.preventDefault()
        if (candidate && !pending) onAdd(candidate.id)
      }}>
        <h3 id="playlist-add-heading">Добавить из библиотеки</h3>
        <div className="playlist-toolbar">
          <input type="search" aria-label="Найти трек для добавления" placeholder="Найти трек в библиотеке"
            value={query} onChange={event => setQuery(event.currentTarget.value)} />
          <select aria-label="Трек для добавления" value={candidate?.id ?? ''} disabled={pending || !candidates.length}
            title={candidate?.title}
            onChange={event => setCandidateId(event.currentTarget.value)}>
            <option value="">{candidates.length ? 'Выберите трек' : 'Нет доступных треков для добавления'}</option>
            {candidates.map(track => <option key={track.id} value={track.id}>
              {track.artist ? `${track.title} — ${track.artist}` : track.title}
            </option>)}
          </select>
          <button className="secondary" disabled={pending || !candidate}>Добавить</button>
        </div>
      </form>
      <h3 className="playlist-track-heading">Композиции</h3>
      {playlist.trackIds.length === 0 && <p className="playlist-empty muted">В плейлисте пока нет треков. Выберите композицию из библиотеки выше.</p>}
      <ol className="playlist-tracks" aria-label="Треки плейлиста">
        {playlist.trackIds.map((id, index) => {
          const track = byId.get(id)
          const title = track?.title ?? 'Неизвестный трек'
          return (
            <li key={id} className="playlist-track">
              <span className="playlist-position muted" aria-hidden="true">{index + 1}</span>
              <Artwork key={track?.artworkUrl} url={track?.artworkUrl ?? null} />
              <div className="min-w-0 flex-1">
                <p className="track-name truncate" title={title}>{title}</p>
                {track?.artist && <p className="muted truncate" title={track.artist}>{track.artist}</p>}
                {!track?.available && <p className="unavailable">Файл недоступен</p>}
              </div>
              <TrackQueueActions title={title} disabled={!track?.available || !playbackReady}
                add={next => onQueue(id, next)} />
              <div className="playlist-order">
                <IconButton icon="up" label={`Выше: ${title}`} title="Переместить выше"
                  disabled={pending || index === 0} onClick={() => onMove(id, -1)} />
                <IconButton icon="down" label={`Ниже: ${title}`} title="Переместить ниже"
                  disabled={pending || index === playlist.trackIds.length - 1} onClick={() => onMove(id, 1)} />
                <IconButton icon="close" label={`Убрать из плейлиста: ${title}`} title="Убрать из плейлиста"
                  disabled={pending} onClick={() => onRemove(id)} />
              </div>
            </li>
          )
        })}
      </ol>
    </>
  )
}
