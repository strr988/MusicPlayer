import { useMemo, useRef, useState } from 'react'
import type { ImportIssue, LibraryTrack, MusicFolder } from '../../shared/contracts'
import { Artwork } from './artwork'
import { EmptyState } from './empty-state'
import { Icon, IconButton, LikeButton } from './icons'
import { sortFields, visibleTracks } from './library-view'
import type { SortDirection, SortField } from './library-view'
import { ListPager, pageSize } from './list-pager'
import { formatTime } from './playback'
import { TrackQueueActions } from './queue-panel'

const issueLabels: Record<ImportIssue['reason'], string> = {
  'directory-unreadable': 'папка недоступна',
  'file-unreadable': 'файл не прочитан',
  'format-mismatch': 'контейнер или кодек не подходит для этого расширения',
  'codec-unsupported': 'кодек не поддерживается (например, Apple Lossless в M4A)',
}

export function Library({ tracks, loading, loadFailed, retryLoad, scan, notice, issues, importFolder, rescanLibrary,
  folders, folderListError, removeFolder, retryFolders, activeId, playing, ready, likedIds, likeDisabled, toggleLike, select, addToQueue, addToPlaylist }: {
  tracks: LibraryTrack[]
  loading: boolean
  loadFailed: boolean
  retryLoad: () => void
  scan: 'import' | 'rescan' | 'remove' | null
  folders: MusicFolder[]
  folderListError: boolean
  removeFolder: (id: string) => void
  retryFolders: () => void
  notice?: { text: string; processed?: number }
  issues: ImportIssue[]
  importFolder: () => void
  rescanLibrary: () => void
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
  const [requestedPage, setPage] = useState(0)
  const shown = useMemo(() => visibleTracks(tracks, query, sortField, direction), [tracks, query, sortField, direction])
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(shown.length / pageSize) - 1))
  const tableStart = useRef<HTMLDivElement>(null)
  const actions = <div className="library-folder-actions">
    <button type="button" className="secondary" onClick={rescanLibrary} disabled={!!scan || loading}
      title="Перечитать импортированные папки">
      <Icon name="refresh" />{scan === 'rescan' ? 'Обновляем…' : 'Обновить'}
    </button>
    <button type="button" className="primary" onClick={importFolder} disabled={!!scan || loading}>
      <Icon name="folder" />{scan === 'import' ? 'Импорт…' : 'Добавить папку'}
    </button>
  </div>
  const sortState = (field: SortField) => sortField === field ? (direction === 'asc' ? 'ascending' : 'descending') : undefined

  return <>
    <header className="section-heading library-heading">
      <div>
        <h1>Библиотека</h1>
        {tracks.length > 0 && <p className="muted" role="status">
          Треков: {shown.length}{query.trim() && ' из ' + tracks.length}
        </p>}
      </div>
      {tracks.length > 0 && actions}
    </header>
    {(folders.length > 0 || folderListError) && <details className="music-folders">
      <summary>Музыкальные папки ({folders.length})</summary>
      {folderListError && <button type="button" className="secondary" onClick={retryFolders}>Обновить список папок</button>}
      <ul>{folders.map(folder => <li key={folder.id}>
        <span>{folder.label}</span>
        <button type="button" className="secondary" disabled={!!scan || loading || !ready}
          aria-label={`Исключить папку ${folder.label}`} onClick={() => removeFolder(folder.id)}>Исключить</button>
      </li>)}</ul>
      <p className="muted">Исключение папки убирает её треки из библиотеки. Файлы остаются на диске.</p>
    </details>}
    {scan && <p className="notice" role="status">{scan === 'rescan' ? 'Перечитываем импортированные папки…' : scan === 'remove' ? 'Исключаем папку…' : 'Читаем папку…'}</p>}
    {!scan && notice && <p className={notice.processed ? 'sr-only' : 'notice'} role="status">{notice.text}</p>}
    {!scan && issues.length > 0 && <details className="import-result">
      <summary className="danger">Результат сканирования · ошибок: {issues.length}</summary>
      {notice?.processed && <p>{notice.text}</p>}
      <ul>{issues.map((issue, index) => <li key={index}>
        {issue.entry} — {issueLabels[issue.reason]}
      </li>)}</ul>
    </details>}
    {loading ? <p className="notice" role="status">Загружаем библиотеку…</p> :
      loadFailed ? <EmptyState icon="library" title="Не удалось открыть библиотеку"
        action={<button type="button" className="primary" onClick={retryLoad}>Повторить загрузку</button>} /> :
      tracks.length === 0 ? <EmptyState icon="music" title="Здесь появится ваша музыка" action={actions}>
        Добавьте папку с файлами MP3, AAC, M4A, FLAC, WAV, Ogg, Opus или WebM.
      </EmptyState> : <>
        <div className="library-tools">
          <label className="search-control">
            <Icon name="search" />
            <input type="search" aria-label="Поиск по библиотеке" placeholder="Название, исполнитель или альбом"
              value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(0) }} />
          </label>
          <label className="sort-control">
            <span aria-hidden="true">Сортировка</span>
            <select className="player-select" aria-label="Сортировка" value={sortField} onChange={event => {
              setSortField(event.currentTarget.value as SortField | '')
              setPage(0)
            }}>
              <option value="">Порядок импорта</option>
              {Object.entries(sortFields).map(([field, label]) => <option key={field} value={field}>{label}</option>)}
            </select>
          </label>
          <IconButton className="sort-direction secondary" icon={direction === 'asc' ? 'up' : 'down'} disabled={!sortField}
            label={direction === 'asc' ? 'Сортировать по убыванию' : 'Сортировать по возрастанию'}
            onClick={() => { setDirection(previous => previous === 'asc' ? 'desc' : 'asc'); setPage(0) }} />
        </div>
        {shown.length === 0 ? <EmptyState icon="search" title="Треки не найдены"
          action={<button type="button" className="secondary" onClick={() => setQuery('')}>Очистить поиск</button>}>
          Попробуйте поискать по другому названию, исполнителю или альбому.
        </EmptyState> :
          <div ref={tableStart} className="track-results">
            {shown.length > pageSize && <ListPager page={page} count={shown.length} label="Страницы библиотеки"
              onPage={next => { setPage(next); tableStart.current?.scrollIntoView({ block: 'start' }) }} />}
          <table className="tracks">
            <thead><tr>
              <th scope="col" aria-sort={sortState('title') ?? sortState('artist')}>Композиция</th>
              <th scope="col" className="album-column" aria-sort={sortState('album')}>Альбом</th>
              <th scope="col" className="format-column">Формат</th>
              <th scope="col" className="time-column" aria-sort={sortState('durationSeconds')}>Время</th>
              <th scope="col" className="actions-column">Действия</th>
            </tr></thead>
            <tbody>{shown.slice(page * pageSize, (page + 1) * pageSize).map(track => {
              const current = track.id === activeId
              return <tr key={track.id} data-current={current} data-unavailable={!track.available}>
                <td><button type="button" className="track-button" disabled={!ready} onClick={() => select(track.id)}
                  aria-label={track.title} aria-current={current ? 'true' : undefined} title={track.title}>
                  <span className="track-cover">
                    <Artwork key={track.artworkUrl} url={track.artworkUrl} />
                    {current && <span className="playing-mark" aria-hidden="true"><Icon name={playing ? 'wave' : 'pause'} /></span>}
                  </span>
                  <span className="track-text">
                    <span className="track-name truncate">{track.title}</span>
                    <span className="track-artist truncate" title={track.artist ?? undefined}>{track.artist ?? 'Неизвестный исполнитель'}</span>
                    {!track.available && <span className="unavailable">Файл недоступен</span>}
                  </span>
                </button></td>
                <td className="album-column truncate" title={track.album ?? undefined}>{track.album ?? '—'}</td>
                <td className="format-column"><span className="format">{track.format.toUpperCase()}</span></td>
                <td className="time-column">{formatTime(track.durationSeconds)}</td>
                <td><div className="track-actions">
                  <LikeButton label={'Лайк: ' + track.title} title="Лайк" aria-pressed={likedIds.has(track.id)}
                    disabled={likeDisabled} onClick={() => toggleLike(track.id)} />
                  <TrackQueueActions title={track.title} disabled={!track.available || !ready}
                    add={next => addToQueue(track.id, next)} />
                  <IconButton icon="addToPlaylist" label={'Добавить в плейлист: ' + track.title}
                    title="Добавить в плейлист" disabled={!track.available} onClick={() => addToPlaylist(track.id)} />
                </div></td>
              </tr>
            })}</tbody>
          </table>
          </div>}
      </>}
  </>
}
