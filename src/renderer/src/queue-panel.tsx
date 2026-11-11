import type { RefObject } from 'react'
import { Artwork } from './artwork'
import { IconButton } from './icons'
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

export function QueuePanel({ playback, open, close, closeButton }: {
  playback: ReturnType<typeof usePlayback>
  open: boolean
  close: () => void
  closeButton: RefObject<HTMLButtonElement | null>
}) {
  const { queue, entriesById, tracksById, track, loading, ready, mode } = playback
  return <aside id="playback-queue" className="queue-panel" aria-labelledby="queue-heading" hidden={!open}>
    {open && <>
      <div className="queue-heading">
        <h2 id="queue-heading">Очередь</h2>
        <IconButton ref={closeButton} icon="close" label="Закрыть очередь" onClick={close} />
      </div>
      <div className="queue-body">
        <h3>Текущий трек</h3>
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
        <ol className="queue-list" aria-label="Ожидающие треки">
          {queue.pending.map((id, index) => {
            const item = tracksById.get(entriesById.get(id)!.trackId)
            const title = item?.title ?? 'Неизвестный трек'
            return <li key={id} data-queue-entry={id}>
              <button className="queue-track" title={title} aria-label={'Играть из очереди: ' + title}
                disabled={loading || !ready || !item?.available}
                onClick={() => { closeButton.current?.focus(); playback.jump(id) }}>
                <span className="track-name truncate">{title}</span>
                {item?.artist && <span className="muted truncate" title={item.artist}>{item.artist}</span>}
                {!item?.available && <span className="unavailable">Файл недоступен</span>}
              </button>
              {item?.available && <span className="queue-time muted">{formatTime(item.durationSeconds)}</span>}
              <IconButton icon="up" label={'Выше в очереди: ' + title} title="Переместить выше" disabled={index === 0}
                onClick={event => {
                  if (index === 1) (event.currentTarget.nextElementSibling as HTMLButtonElement).focus()
                  playback.move(id, -1)
                }} />
              <IconButton icon="down" label={'Ниже в очереди: ' + title} title="Переместить ниже"
                disabled={index === queue.pending.length - 1} onClick={event => {
                  if (index === queue.pending.length - 2) (event.currentTarget.previousElementSibling as HTMLButtonElement).focus()
                  playback.move(id, 1)
                }} />
              <IconButton icon="close" label={'Убрать из очереди: ' + title} title="Убрать из очереди"
                onClick={() => { closeButton.current?.focus(); playback.remove(id) }} />
            </li>
          })}
        </ol>
      </div>
    </>}
  </aside>
}
