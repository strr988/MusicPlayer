import { useState } from 'react'
import type { VolumePreference } from '../../shared/contracts'
import { IconButton } from './icons'

export function VolumeControl({ volume, toggleMute, setVolumeLevel, fullscreen = false }: {
  volume: VolumePreference | null
  toggleMute: () => void
  setVolumeLevel: (level: number) => void
  fullscreen?: boolean
}) {
  const [pointerFocus, setPointerFocus] = useState(false)
  const level = Math.round((volume?.level ?? 1) * 100)

  return <div className={fullscreen ? 'volume-control full-volume' : 'volume-control player-volume'}
    data-pointer-focus={pointerFocus || undefined}
    onPointerDownCapture={() => setPointerFocus(true)}
    onKeyDownCapture={() => setPointerFocus(false)}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setPointerFocus(false)
    }}>
    <IconButton icon={volume?.muted ? 'mute' : 'volume'} label="Без звука"
      title={volume?.muted ? 'Включить звук' : 'Отключить звук'}
      aria-pressed={volume?.muted ?? false} disabled={!volume} onClick={toggleMute} />
    <div className="volume-slider">
      <input aria-label="Громкость" aria-orientation={fullscreen ? 'horizontal' : 'vertical'}
        type="range" min={0} max={100} step={1} value={level} disabled={!volume}
        aria-valuetext={level + '%'} title={level + '%'}
        onChange={event => setVolumeLevel(event.currentTarget.valueAsNumber / 100)} />
    </div>
  </div>
}
