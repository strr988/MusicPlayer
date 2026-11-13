import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { formatTime } from './playback'

export function Timeline({ audio, duration, trackDuration, restoredPosition, seek }: {
  audio: RefObject<HTMLAudioElement | null>
  duration: number | null
  trackDuration: number | null
  restoredPosition: number | null
  seek: (seconds: number) => void
}) {
  const [position, setPosition] = useState(0)
  useEffect(() => {
    const element = audio.current
    if (!element) return
    const update = () => setPosition(element.currentTime)
    update()
    const events = ['timeupdate', 'seeking', 'emptied'] as const
    for (const event of events) element.addEventListener(event, update)
    return () => { for (const event of events) element.removeEventListener(event, update) }
  }, [audio])

  const length = duration ?? trackDuration ?? 0
  const displayed = Math.min(restoredPosition ?? position, length)
  return (
    <div className="timeline flex items-center gap-2">
      <span>{formatTime(displayed)}</span>
      <input aria-label="Позиция воспроизведения" type="range" min={0} max={length}
        step={0.01} value={displayed} disabled={duration === null}
        onChange={event => seek(event.currentTarget.valueAsNumber)} />
      <span>{formatTime(duration ?? trackDuration)}</span>
    </div>
  )
}
