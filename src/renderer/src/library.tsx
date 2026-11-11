import { useMemo, useState } from 'react'
import type { ImportIssue, LibraryTrack } from '../../shared/contracts'
import { Artwork } from './artwork'
import { EmptyState } from './empty-state'
import { Icon, IconButton } from './icons'
import { sortFields, visibleTracks } from './library-view'
import type { SortDirection, SortField } from './library-view'
import { formatTime } from './playback'
import { TrackQueueActions } from './queue-panel'

export function Library({ tracks, loading, loadFailed, retryLoad, importing, notice, issues, importFolder,
  activeId, playing, ready, likedIds, likeDisabled, toggleLike, select, addToQueue, addToPlaylist }: {
  tracks: LibraryTrack[]
  loading: boolean
  loadFailed: boolean
  retryLoad: () => void
  importing: boolean
  notice: string
  issues: ImportIssue[]
  importFolder: () => void
  activeId?: string
  playing: boolean
  ready: boolean
  likedIds: Set<string>
  likeDisabled: boolean
  toggleLike: (id: string) => void
  select: (id: string) => void
  addToQueue: (id: string, next: boolean) => void
  addToPlaylist: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [sortField, setSortField] = useState<SortField | ''>('')
  const [direction, setDirection] = useState<SortDirection>('asc')
  const shown = useMemo(() => visibleTracks(tracks, query, sortField, direction), [tracks, query, sortField, direction])
  const title = importing ? 'Импорт…' : 'Выбрать папку'
  const importButton = <button type="button" className="primary" onClick={importFolder} disabled={importing || loading}>
    <Icon name="folder" />{title}
  </button>
  const sortState = (field: SortField) => sortField === field ? (direction === 'asc' ? 'ascending' : 'descending') : undefined

  return <>
    <header className="section-heading">
      <div>
        <h1>Библиотека</h1>
        {tracks.length > 0 && <p className="muted" role="status">
          Треков: {shown.length}{query.trim() && ' из ' + tracks.length}
        </p>}
      </div>
      {tracks.length > 0 && importButton}
    </header>
    {(notice || importing) && <p className="notice" role="status">{importing ? 'Читаем папку…' : notice}</p>}
    {issues.length > 0 && <details className="issues">
      <summary>Ошибки импорта ({issues.length})</summary>
      <ul>{issues.map(issue => <li key={issue.entry}>
        {issue.entry} — {issue.reason === 'directory-unreadable' ? 'папка недоступна' : 'файл не прочитан'}
      </li>)}</ul>
    </details>}
    {loading ? <p className="notice" role="status">Загружаем библиотеку…</p> :
      loadFailed ? <EmptyState icon="library" title="Не удалось открыть библиотеку"
        action={<button type="button" className="primary" onClick={retryLoad}>Повторить загрузку</button>} /> :
      tracks.length === 0 ? <EmptyState icon="music" title="Здесь появится ваша музыка" action={importButton}>
        Выберите папку с файлами MP3 или FLAC.
      </EmptyState> : <>
        <div className="library-tools">
          <label className="search-control">
            <Icon name="search" />
            <input type="search" aria-label="Поиск по библиотеке" placeholder="Название, исполнитель или альбом"
              value={query} onChange={event => setQuery(event.currentTarget.value)} />
          </label>
          <label className="sort-control">
            <span aria-hidden="true">Сортировка</span>
            <select aria-label="Сортировка" value={sortField} onChange={event => setSortField(event.currentTarget.value as SortField | '')}>
              <option value="">Порядок импорта</option>
              {Object.entries(sortFields).map(([field, label]) => <option key={field} value={field}>{label}</option>)}
            </select>
          </label>
          <IconButton className="sort-direction secondary" icon={direction === 'asc' ? 'up' : 'down'} disabled={!sortField}
            label={direction === 'asc' ? 'Сортировать по убыванию' : 'Сортировать по возрастанию'}
            onClick={() => setDirection(previous => previous === 'asc' ? 'desc' : 'asc')} />
        </div>
        {shown.length === 0 ? <EmptyState icon="search" title="Треки не найдены"
          action={<button type="button" className="secondary" onClick={() => setQuery('')}>Очистить поиск</button>}>
          Попробуйте поискать по другому названию, исполнителю или альбому.
        </EmptyState> :
          <table className="tracks">
            <thead><tr>
              <th scope="col" aria-sort={sortState('title') ?? sortState('artist')}>Композиция</th>
              <th scope="col" className="album-column" aria-sort={sortState('album')}>Альбом</th>
              <th scope="col" className="format-column">Формат</th>
              <th scope="col" className="time-column" aria-sort={sortState('durationSeconds')}>Время</th>
              <th scope="col" className="actions-column">Действия</th>
            </tr></thead>
            <tbody>{shown.map(track => {
              const current = track.id === activeId
              return <tr key={track.id} data-current={current}>
                <td><button type="button" className="track-button" disabled={!ready} onClick={() => select(track.id)}
                  aria-label={track.title} aria-current={current ? 'true' : undefined} title={track.title}>
                  <span className="track-cover">
                    <Artwork key={track.artworkUrl} url={track.artworkUrl} />
                    {current && <span className="playing-mark" aria-hidden="true"><Icon name={playing ? 'wave' : 'pause'} /></span>}
                  </span>
                  <span className="track-text">
                    <span className="track-name truncate">{track.title}</span>
                    <span className="muted truncate" title={track.artist ?? undefined}>{track.artist ?? 'Неизвестный исполнитель'}</span>
                    {!track.available && <span className="unavailable">Файл недоступен</span>}
                  </span>
                </button></td>
                <td className="album-column truncate" title={track.album ?? undefined}>{track.album ?? '—'}</td>
                <td className="format-column"><span className="format">{track.format.toUpperCase()}</span></td>
                <td className="time-column">{formatTime(track.durationSeconds)}</td>
                <td><div className="track-actions">
                  <IconButton icon="heart" label={'Лайк: ' + track.title} title="Лайк" aria-pressed={likedIds.has(track.id)}
                    disabled={likeDisabled} onClick={() => toggleLike(track.id)} />
                  <TrackQueueActions title={track.title} disabled={!track.available || !ready}
                    add={next => addToQueue(track.id, next)} />
                  <IconButton icon="addToPlaylist" label={'Добавить в плейлист: ' + track.title}
                    title="Добавить в плейлист" disabled={!track.available} onClick={() => addToPlaylist(track.id)} />
                </div></td>
              </tr>
            })}</tbody>
          </table>}
      </>}
  </>
}
