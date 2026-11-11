import { waveModes } from '../../shared/contracts'
import type { WaveMode } from '../../shared/contracts'
import { Icon } from './icons'

const modes: Record<WaveMode, { label: string; description: string }> = {
  familiar: { label: 'Знакомое', description: 'Больше треков, близких к вашим предпочтениям.' },
  balance: { label: 'Баланс', description: 'Знакомая музыка вперемешку с новыми находками.' },
  discovery: { label: 'Открытия', description: 'Больше музыки, которую вы ещё не слушали.' },
}

export function Wave({ mode, saving, changeMode, empty, unavailable, ready, active, playing, loading, title, notice, start, openLibrary }: {
  mode: WaveMode | null
  saving: boolean
  changeMode: (mode: WaveMode) => void
  empty: boolean
  unavailable: boolean
  ready: boolean
  active: boolean
  playing: boolean
  loading: boolean
  title?: string
  notice: string
  start: () => void
  openLibrary: () => void
}) {
  const status = notice || (loading && active ? 'Подбираем трек…' :
    active && title ? (playing ? 'Сейчас играет · ' : 'На паузе · ') + title : '')
  return <>
    <div className="wave-hero">
      <div className="wave-art" aria-hidden="true"><Icon name="wave" /></div>
      <div className="wave-intro">
        <h1>Моя волна</h1>
        <p>Радио из вашей библиотеки. Подборка учитывает лайки, дослушивания и пропуски и обновляется по мере прослушивания.</p>
        <div className="wave-start">
          <button type="button" className="primary" disabled={!ready || !mode || saving || loading || empty}
            onClick={start}><Icon name={active && !notice ? 'next' : 'play'} />
            {active ? (notice ? 'Продолжить волну' : 'Следующий трек волны') : 'Запустить волну'}
          </button>
          {empty && <button type="button" className="secondary" onClick={openLibrary}>Открыть библиотеку</button>}
        </div>
        {status && <p className="wave-status" role="status">{status}</p>}
        {empty && <p className="wave-status">Добавьте музыку в библиотеку, чтобы запустить радио.</p>}
        {unavailable && <p className="wave-status">Файлы из библиотеки сейчас недоступны. При запуске плеер проверит источники.</p>}
      </div>
    </div>
    <fieldset className="wave-modes" disabled={!mode} aria-busy={saving}>
      <legend>Режим рекомендаций</legend>
      <div className="wave-mode-grid">
        {waveModes.map(value => <label key={value} className="wave-mode" data-selected={mode === value}>
          <input type="radio" name="wave-mode" value={value} checked={mode === value}
            aria-describedby={'wave-mode-' + value} onChange={() => changeMode(value)} />
          <span className="mode-label">{modes[value].label}</span>
          <span className="muted" id={'wave-mode-' + value}>{modes[value].description}</span>
        </label>)}
      </div>
    </fieldset>
  </>
}
