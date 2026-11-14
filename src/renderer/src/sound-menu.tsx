import { useId } from 'react'
import { soundEffectRates, soundEffects } from '../../shared/contracts'
import type { SoundEffect, SoundSettings } from '../../shared/contracts'
import { IconButton } from './icons'

const labels: Record<SoundEffect, string> = {
  original: 'Оригинал', 'speed-up': 'Speed Up', slowed: 'Slowed',
}
const formatRate = new Intl.NumberFormat('ru')

export function SoundMenu({ sound, saving = false, error, changeEffect, changeReverb }: {
  sound: SoundSettings | null
  saving?: boolean
  error?: string
  changeEffect(effect: SoundEffect): void
  changeReverb(effect: SoundEffect, enabled: boolean): void
}) {
  const id = useId()
  const effect = sound?.effect ?? 'original'
  return <>
    <IconButton icon="effects" label="Звуковые эффекты" popoverTarget={id} aria-controls={id}
      className="sound-button" data-active={effect !== 'original' || sound?.reverb[effect] || undefined} />
    <div className="sound-menu" id={id} popover="auto">
      <label className="sound-control">
        <span>Пресет</span>
        <select className="player-select" aria-label="Звуковой эффект" value={effect} disabled={!sound || saving}
          onChange={event => changeEffect(event.currentTarget.value as SoundEffect)}>
          {soundEffects.map(value => <option key={value} value={value}>{labels[value]} · {formatRate.format(soundEffectRates[value])}×</option>)}
        </select>
      </label>
      <label className="sound-control reverb-control">
        <span>Reverb</span>
        <input type="checkbox" role="switch" checked={sound?.reverb[effect] ?? false} disabled={!sound || saving}
          onChange={event => changeReverb(effect, event.currentTarget.checked)} />
      </label>
      {error && <p role="alert">{error}</p>}
    </div>
  </>
}
