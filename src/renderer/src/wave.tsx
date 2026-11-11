import { waveModes } from '../../shared/contracts'
import type { WaveMode } from '../../shared/contracts'
import { Icon } from './icons'
import type { RecommendationExplanation } from './playback'

const modes: Record<WaveMode, { label: string; description: string }> = {
  familiar: { label: 'Знакомое', description: 'Больше треков, близких к вашим предпочтениям.' },
  balance: { label: 'Баланс', description: 'Знакомая музыка вперемешку с новыми находками.' },
  discovery: { label: 'Открытия', description: 'Больше музыки, которую вы ещё не слушали.' },
}

const factorLabels = {
  likedTrack: 'Вы отметили этот трек лайком',
  likedArtist: 'Вы лайкнули музыку этого исполнителя',
  likedGenre: 'Жанр совпадает с жанром лайкнутого трека',
  unheard: 'В истории нет начала воспроизведения этого трека',
  completions: 'Недавние дослушивания повысили балл',
  skips: 'Недавние пропуски снизили балл',
} as const

function Explanation({ value }: { value?: RecommendationExplanation }) {
  if (!value) return <p className="wave-status wave-explanation-unavailable">Диагностика для этой позиции недоступна.</p>
  const { decision, calculation, rank, previousTrackExcluded, attemptedExcluded } = value
  const factors = (Object.keys(factorLabels) as (keyof typeof factorLabels)[])
    .filter(key => decision.factors[key] !== 0)
  const reason = {
    'only-eligible': decision.remaining === 1 ? 'В этой позиции был один кандидат.' :
      'После применения ограничений остался один кандидат.',
    'highest-score': 'У трека самый высокий балл среди подходящих кандидатов.',
    'seeded-tie': 'Баллы совпали. Порядок определило воспроизводимое перемешивание.',
    exploration: 'Режим дал приоритет ещё не слышанным трекам. Выбран один из лучших по баллу в этой группе.',
  }[decision.selection]
  return <details className="wave-explanation">
    <summary>Почему этот трек?</summary>
    <p>{reason}</p>
    {decision.recentRelaxed ? <p>Все оставшиеся треки были недавними. Алгоритм вернул самый давний из них.</p> :
      decision.recentExcluded > 0 && <p>Недавние треки исключены из выбора.</p>}
    {decision.sameArtistExcluded > 0 && <p>Алгоритм исключил повторы предыдущего исполнителя.</p>}
    <p>Режим «{modes[calculation.mode].label}» · шанс поиска новых треков {Math.round(calculation.explorationChance * 100)}%.
      {decision.prioritizedUnheard && decision.selection === 'only-eligible' && ' Поиск нашёл ещё не слышанный трек среди доступных вариантов.'}
      {decision.selection === 'exploration' && decision.tiedForChoice > 1 && ' При равных баллах сработал порядок после перемешивания.'}
    </p>
    {previousTrackExcluded && <p>Плеер исключил только что игравший трек из этого перехода.</p>}
    {attemptedExcluded > 0 && <p>Плеер исключил уже испробованные треки из этого перехода.</p>}
    {decision.selection !== 'only-eligible' && factors.length > 0 && <ul>
      {factors.map(key => <li key={key}>{factorLabels[key]}</li>)}
    </ul>}
    <details className="wave-diagnostics">
      <summary>Технические подробности</summary>
      <dl>
        <dt>Итоговый балл</dt><dd>{decision.score}</dd>
        {factors.map(key => <div key={key}><dt>{factorLabels[key]}</dt><dd>{decision.factors[key]}</dd></div>)}
        <dt>Позиция в расчёте</dt><dd>{rank}</dd>
        <dt>Оставалось / прошло фильтры</dt><dd>{decision.remaining} / {decision.eligible}</dd>
        <dt>Исключено по недавности / исполнителю</dt><dd>{decision.recentExcluded} / {decision.sameArtistExcluded}</dd>
        <dt>Равный балл в группе выбора</dt><dd>{decision.tiedForChoice}</dd>
        <dt>Окно реакций / недавних треков</dt><dd>{calculation.reactionWindowMs / 86_400_000} сут. / {calculation.recentLimit}</dd>
        <dt>Версия / seed</dt><dd>{calculation.algorithmVersion} / {calculation.seed}</dd>
        <dt>Значение генератора для поиска</dt><dd>{decision.explorationRoll.toFixed(6)}</dd>
        <dt>Время расчёта (UTC)</dt><dd>{new Date(calculation.calculatedAt).toISOString()}</dd>
      </dl>
    </details>
  </details>
}

export function Wave({ mode, saving, changeMode, empty, unavailable, ready, active, playing, loading, title, notice, recommendation, start, openLibrary }: {
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
  recommendation?: { entryId: string; explanation?: RecommendationExplanation }
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
    {active && title && !loading && recommendation &&
      <Explanation key={recommendation.entryId} value={recommendation.explanation} />}
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
