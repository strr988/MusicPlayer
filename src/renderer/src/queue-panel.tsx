import { repeatModes } from '../../shared/contracts'
import type { RepeatMode } from '../../shared/contracts'
import type { usePlayback } from './playback'

const repeatLabels: Record<RepeatMode, string> = {
  off: 'Выключен', all: 'Вся очередь', one: 'Один трек',
}

export function TrackQueueActions({ title, disabled, add }: {
  title: string
  disabled: boolean
  add: (next: boolean) => void
}) {
  return <span className="track-queue-actions">
    <button aria-label={`Воспроизвести следующим: ${title}`} title="Воспроизвести следующим"
      disabled={disabled} onClick={() => add(true)}>↥</button>
    <button aria-label={`Добавить в очередь: ${title}`} title="Добавить в очередь"
      disabled={disabled} onClick={() => add(false)}>＋</button>
  </span>
}

export function QueuePanel({ playback, open, toggle }: {
  playback: ReturnType<typeof usePlayback>
  open: boolean
  toggle: () => void
}) {
  const { queue, entriesById, tracksById, track, loading } = playback
  return <>
    <div className="queue-controls">
      <button className="secondary" aria-expanded={open} aria-controls="playback-queue" onClick={toggle}>
        Очередь ({queue.pending.length})
      </button>
      <button className="secondary" aria-pressed={queue.shuffle && playback.mode !== 'wave'}
        title={playback.mode === 'wave' ? 'Порядок рекомендаций определяет «Моя волна»' : 'Перемешать ожидающие треки'}
        disabled={!playback.ready || playback.mode === 'wave'} onClick={playback.changeShuffle}>Shuffle</button>
      <label className="repeat-control">
        <span>Повтор</span>
        <select aria-label="Режим повтора" value={queue.repeat} disabled={!playback.ready}
          onChange={event => playback.changeRepeat(event.currentTarget.value as RepeatMode)}>
          {repeatModes.map(mode => <option key={mode} value={mode} disabled={mode === 'all' && playback.mode === 'wave'}>
            {mode === 'all' && playback.mode === 'wave' ? 'Непрерывная волна' : repeatLabels[mode]}
          </option>)}
        </select>
      </label>
    </div>
    <section id="playback-queue" className="queue-panel" aria-label="Очередь воспроизведения" hidden={!open}>
      {open && <>
        <div className="queue-heading">
          <p className="truncate" title={track?.title}>
            Сейчас · {track?.title ?? (queue.current ? 'Файл недоступен' : 'Трек не выбран')}
            {track && !track.available && ' · Файл недоступен'}
          </p>
          <button className="secondary" disabled={!queue.pending.length} onClick={() => playback.remove()}>
            Очистить ожидающие
          </button>
        </div>
        {!queue.pending.length && <p className="muted">
          {playback.mode === 'wave' ? 'Следующий трек подберёт «Моя волна».' : 'Очередь ожидания пуста.'}
        </p>}
        <ol className="queue-list" aria-label="Ожидающие треки">
          {queue.pending.map((id, index) => {
            const entry = entriesById.get(id)!
            const item = tracksById.get(entry.trackId)
            const title = item?.title ?? 'Неизвестный трек'
            return <li key={id} data-queue-entry={id}>
              <button className="queue-track truncate" title={title} aria-label={`Играть из очереди: ${title}`}
                disabled={loading || !playback.ready || !item?.available} onClick={() => playback.jump(id)}>
                {title}{item?.artist && <span className="muted"> · {item.artist}</span>}
                {!item?.available && <span className="muted"> · Файл недоступен</span>}
              </button>
              <button className="secondary" aria-label={`Выше в очереди: ${title}`} disabled={index === 0}
                onClick={() => playback.move(id, -1)}>↑</button>
              <button className="secondary" aria-label={`Ниже в очереди: ${title}`} disabled={index === queue.pending.length - 1}
                onClick={() => playback.move(id, 1)}>↓</button>
              <button className="secondary" aria-label={`Убрать из очереди: ${title}`} onClick={() => playback.remove(id)}>×</button>
            </li>
          })}
        </ol>
      </>}
    </section>
  </>
}
