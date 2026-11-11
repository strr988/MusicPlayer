import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { formatTime } from './playback'

export function Timeline({ audio, duration, trackDuration, seek }: {
  audio: RefObject<HTMLAudioElement | null>
  duration: number | null
  trackDuration: number | null
  seek: (seconds: number) => void
}) {
  const [position, setPosition] = useState(0)
  useEffect(() => {
    const element = audio.current
    if (!element) return
    const update = () => setPosition(element.currentTime)
    const events = ['timeupdate', 'seeking', 'emptied'] as const
    for (const event of events) element.addEventListener(event, update)
    return () => { for (const event of events) element.removeEventListener(event, update) }
  }, [audio])

  const length = duration ?? 0
  return (
    <div className="timeline flex items-center gap-2">
      <span>{formatTime(position)}</span>
      <input aria-label="Позиция воспроизведения" type="range" min={0} max={length}
        step={0.01} value={Math.min(position, length)} disabled={duration === null}
        onChange={event => seek(event.currentTarget.valueAsNumber)} />
      <span>{formatTime(duration ?? trackDuration)}</span>
    </div>
  )
}
