import { useEffect, useRef, useState } from 'react'
import type { MiniPlayerApi, MiniState } from '../../shared/contracts'
import { Artwork } from './artwork'
import { IconButton } from './icons'
import { formatTime } from './playback'
import { DiscoLayer, pulseDisco } from './disco'
import { SoundMenu } from './sound-menu'
import { WindowTitle } from './window-title'

export function MiniPlayer({ api }: { api: MiniPlayerApi }) {
  const [state, setState] = useState<MiniState>()
  const [error, setError] = useState('')
  const disco = useRef<HTMLDivElement>(null)
  useEffect(() => api.onDiscoBeat(strength => pulseDisco(disco.current, strength)), [api])
  useEffect(() => {
    let waiting = true
    const unsubscribe = api.onState(next => {
      waiting = false
      setState(next)
    })
    void api.getState().then(next => {
      if (waiting) setState(next)
    }).catch(() => { if (waiting) setError('Не удалось загрузить состояние плеера.') })
    return () => { waiting = false; unsubscribe() }
  }, [api])

  function request(action: Promise<void>) {
    setError('')
    void action.catch(() => setError('Не удалось выполнить действие.'))
  }
  const current = state?.playback
  const track = current?.track
  const volume = current?.volume
  const level = Math.round((volume?.level ?? 1) * 100)
  const duration = current?.duration ?? 0
  const position = Math.min(current?.position ?? 0, duration)
  const entry = current?.entryId

  return <div className="mini-shell">
    <WindowTitle mini />
    <DiscoLayer ref={disco} />
    <main className="mini-player" aria-label="Мини-плеер">
      <header className="mini-header">
        <div className="now-playing">
          <Artwork key={track?.artworkUrl} url={track?.artworkUrl ?? null} eager />
          <div className="player-track">
            <p className="track-name truncate" title={track?.title}>{track?.title ?? 'Трек не выбран'}</p>
            <p className="muted truncate" title={track?.artist ?? undefined}>
              {track?.artist || (track ? 'Неизвестный исполнитель' : 'Откройте трек в библиотеке')}
            </p>
          </div>
        </div>
        <div className="controls">
          <SoundMenu sound={current?.sound ?? null} saving={current?.savingSound} error={error || current?.soundError}
            changeEffect={effect => request(api.control({ type: 'sound-effect', effect }))}
            changeReverb={(effect, enabled) => request(api.control({ type: 'reverb', effect, enabled }))} />
          <IconButton icon="pin" label="Поверх других окон" aria-pressed={state?.pinned ?? false} disabled={!state}
            onClick={() => request(api.setPinned(!state?.pinned))} />
          <IconButton icon="expand" label="Основное окно" onClick={() => request(api.showMain())} />
        </div>
      </header>
      <div className="timeline flex items-center gap-2">
        <span>{formatTime(position)}</span>
        <input aria-label="Позиция воспроизведения" type="range" min={0} max={duration} step={0.01}
          disabled={!current?.seekable || !entry} value={position} onChange={event => {
            if (entry) request(api.control({ type: 'seek', entryId: entry, seconds: event.currentTarget.valueAsNumber }))
          }} />
        <span>{formatTime(current?.duration ?? null)}</span>
      </div>
      <div className="mini-controls">
        <div className="controls" role="group" aria-label="Управление воспроизведением">
          <IconButton icon="previous" label="Предыдущий трек" disabled={!current?.canGoBack}
            onClick={() => request(api.control({ type: 'previous' }))} />
          <IconButton icon={current?.playing ? 'pause' : 'play'} label={current?.playing ? 'Пауза' : 'Воспроизвести'}
            className="play-button" disabled={!current?.canPlay} onClick={() => request(api.control({ type: 'toggle' }))} />
          <IconButton icon="next" label="Следующий трек" disabled={!current?.canGoNext}
            onClick={() => request(api.control({ type: 'next' }))} />
        </div>
        <div className="volume">
          <IconButton icon={volume?.muted ? 'mute' : 'volume'} label="Без звука" aria-pressed={volume?.muted ?? false}
            disabled={!volume} onClick={() => request(api.control({ type: 'mute' }))} />
          <input aria-label="Громкость" type="range" min={0} max={100} step={1} value={level} disabled={!volume}
            aria-valuetext={level + '%'} onChange={event => request(api.control({ type: 'volume', level: event.currentTarget.valueAsNumber / 100 }))} />
        </div>
      </div>
      {error && <p className="muted" role="alert">{error}</p>}
    </main>
  </div>
}
