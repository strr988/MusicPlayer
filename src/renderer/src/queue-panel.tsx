import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Artwork } from './artwork'
import { IconButton } from './icons'
import { ListPager, pageSize } from './list-pager'
import { formatTime } from './playback'
import type { usePlayback } from './playback'

export function TrackQueueActions({ title, disabled, add }: {
  title: string
  disabled: boolean
  add: (next: boolean) => void
}) {
  return <span className="track-queue-actions">
    <IconButton icon="nextInQueue" label={'Воспроизвести следующим: ' + title} title="Воспроизвести следующим"
      disabled={disabled} onClick={() => add(true)} />
    <IconButton icon="plus" label={'Добавить в очередь: ' + title} title="Добавить в очередь"
      disabled={disabled} onClick={() => add(false)} />
  </span>
}

export function QueuePanel({ playback, open, close, closeButton, id = 'playback-queue' }: {
  playback: ReturnType<typeof usePlayback>
  open: boolean
  close: () => void
  closeButton: RefObject<HTMLButtonElement | null>
  id?: string
}) {
  const { queue, entriesById, tracksById, track, loading, ready, mode } = playback
  const [requestedPage, setPage] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  const moveFocus = useRef<{ id: string; offset: -1 | 1 } | null>(null)
  const page = open ? Math.min(requestedPage, Math.max(0, Math.ceil(queue.pending.length / pageSize) - 1)) : 0
  if (page !== requestedPage) setPage(page)
  const pageStart = page * pageSize
  const visible = open ? queue.pending.slice(pageStart, pageStart + pageSize) : []
  useLayoutEffect(() => {
    if (!moveFocus.current) return
    const { id, offset } = moveFocus.current
    moveFocus.current = null
    const row = body.current?.querySelector(`[data-queue-entry="${CSS.escape(id)}"]`)
    const target = row?.querySelector<HTMLButtonElement>(`[data-move="${offset}"]:enabled`) ??
      row?.querySelector<HTMLButtonElement>(`[data-move="${-offset}"]:enabled`)
    target?.focus()
  }, [page])

  function move(id: string, index: number, offset: -1 | 1, button: HTMLButtonElement) {
    const destination = index + offset
    const nextPage = Math.floor(destination / pageSize)
    if (nextPage !== page) {
      moveFocus.current = { id, offset }
      setPage(nextPage)
    } else if (destination === 0 || destination === queue.pending.length - 1) {
      button.parentElement?.querySelector<HTMLButtonElement>(`[data-move="${-offset}"]`)?.focus()
    }
    playback.move(id, offset)
  }

  return <aside id={id} className="queue-panel" aria-labelledby={id + '-heading'} hidden={!open}>
    {open && <>
      <div className="queue-heading">
        <h2 id={id + '-heading'}>Очередь</h2>
        <IconButton ref={closeButton} icon="close" label="Закрыть очередь" onClick={close} />
      </div>
      <div className="queue-body" ref={body}>
        <h3 className="queue-current-heading">Сейчас играет</h3>
        <div className="queue-current">
          <Artwork key={track?.artworkUrl} url={track?.artworkUrl ?? null} />
          <div className="min-w-0">
            <p className="track-name truncate" title={track?.title}>
              {track?.title ?? (queue.current ? 'Файл недоступен' : 'Трек не выбран')}
            </p>
            {track?.artist && <p className="muted truncate" title={track.artist}>{track.artist}</p>}
            {track && !track.available && <p className="unavailable">Файл недоступен</p>}
          </div>
        </div>
        <div className="queue-subheading">
          <h3>Далее <span className="muted">({queue.pending.length})</span></h3>
          {queue.pending.length > 0 && <button type="button" className="text-button"
            onClick={() => { closeButton.current?.focus(); playback.remove() }}>Очистить ожидающие</button>}
        </div>
        {!queue.pending.length && <p className="muted">
          {mode === 'wave' ? 'Следующий трек подберёт «Моя волна».' : 'Добавьте треки из библиотеки или плейлиста.'}
        </p>}
        {queue.pending.length > pageSize && <ListPager page={page} count={queue.pending.length} label="Страницы очереди"
          onPage={next => { setPage(next); body.current?.scrollTo(0, 0) }} />}
        <ol className="queue-list" aria-label="Ожидающие треки">
          {visible.map((id, pageIndex) => {
            const index = pageStart + pageIndex
            const item = tracksById.get(entriesById.get(id)!.trackId)
            const title = item?.title ?? 'Неизвестный трек'
            return <li key={id} data-queue-entry={id} data-unavailable={!item?.available}>
              <button className="queue-track" title={title} aria-label={'Играть из очереди: ' + title}
                disabled={loading || !ready || !item?.available}
                onClick={() => { closeButton.current?.focus(); playback.jump(id) }}>
                <span className="track-name truncate">{title}</span>
                {item?.artist && <span className="muted truncate" title={item.artist}>{item.artist}</span>}
                {!item?.available && <span className="unavailable">Файл недоступен</span>}
              </button>
              {item?.available && <span className="queue-time muted">{formatTime(item.durationSeconds)}</span>}
              <div className="queue-actions">
                <IconButton icon="up" label={'Выше в очереди: ' + title} title="Переместить выше" data-move={-1}
                  disabled={index === 0} onClick={event => move(id, index, -1, event.currentTarget)} />
                <IconButton icon="down" label={'Ниже в очереди: ' + title} title="Переместить ниже" data-move={1}
                  disabled={index === queue.pending.length - 1} onClick={event => move(id, index, 1, event.currentTarget)} />
                <IconButton icon="close" label={'Убрать из очереди: ' + title} title="Убрать из очереди"
                  onClick={() => { closeButton.current?.focus(); playback.remove(id) }} />
              </div>
            </li>
          })}
        </ol>
      </div>
    </>}
  </aside>
}
