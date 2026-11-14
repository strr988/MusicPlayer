import { useId, useState, useEffect } from 'react'
import { soundEffectRates } from '../../shared/contracts'
import { formatTime } from './playback'
import type { usePlayback } from './playback'
import { sleepMaxMinutes, sleepPresets, timedSleep } from './sleep-timer'
import { IconButton } from './icons'

export function SleepMenu({ playback }: { playback: ReturnType<typeof usePlayback> }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return <>
    <IconButton icon="timer" label="Таймер сна" popoverTarget={id} aria-controls={id}
      data-active={!!playback.sleep || undefined} />
    <div id={id} className="sound-menu sleep-menu" popover="auto" onToggle={event => setOpen(event.newState === 'open')}>
      {open && <SleepControls playback={playback} />}
    </div>
  </>
}

export function SleepPanel({ playback }: { playback: ReturnType<typeof usePlayback> }) {
  const [open, setOpen] = useState(false)
  return <details className="sleep-panel" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Таймер сна{playback.sleep ? ' · включён' : ''}</summary>
    {open && <SleepControls playback={playback} />}
  </details>
}

function SleepControls({ playback }: { playback: ReturnType<typeof usePlayback> }) {
  const { sleep, changeSleep, track, currentEntryId, loading } = playback
  const [minutes, setMinutes] = useState('')
  const [now, setNow] = useState(Date.now)
  const [position, setPosition] = useState(0)
  const audio = playback.audioProps.ref
  useEffect(() => {
    if (!sleep) return
    const update = () => {
      setNow(Date.now())
      setPosition(audio.current?.currentTime ?? 0)
    }
    update()
    const interval = setInterval(update, 250)
    return () => clearInterval(interval)
  }, [sleep, audio])

  function start(duration: number) {
    const time = Date.now()
    setNow(time)
    changeSleep(timedSleep(duration, time))
  }
  const rate = soundEffectRates[playback.sound?.effect ?? 'original']
  const remaining = sleep?.kind === 'deadline' ? Math.ceil(Math.max(0, sleep.at - now) / 1000)
    : sleep?.kind === 'track' && playback.duration !== null ? Math.ceil(Math.max(0, playback.duration - position) / rate) : null
  const customMinutes = Number(minutes)

  return <section className="sleep-controls" aria-label="Таймер сна">
    <h3>Таймер сна</h3>
    <p className="muted">{sleep?.kind === 'track' ? 'До конца текущего трека' : sleep ? 'До остановки' : 'Таймер выключен'}
      {remaining !== null && <strong className="sleep-remaining"> · {formatTime(remaining)}</strong>}
    </p>
    <div className="settings-actions" role="group" aria-label="Длительность таймера">
      {sleepPresets.map(preset => <button key={preset} type="button" className="secondary"
        onClick={() => start(preset)}>{preset} мин</button>)}
    </div>
    <form className="settings-actions" onSubmit={event => {
      event.preventDefault()
      if (timedSleep(customMinutes, Date.now())) start(customMinutes)
    }}>
      <input className="settings-input sleep-minutes" aria-label="Своя длительность в минутах"
        type="number" min={1} max={sleepMaxMinutes} step={1} placeholder="Минуты" required value={minutes}
        onChange={event => setMinutes(event.currentTarget.value)} />
      <button className="secondary" type="submit">{sleep ? 'Изменить время' : 'Запустить'}</button>
    </form>
    <div className="settings-actions">
      <button className="secondary" type="button" disabled={!track?.available || !currentEntryId || loading}
        onClick={() => {
          if (currentEntryId) changeSleep({ kind: 'track', entryId: currentEntryId })
        }}>После текущего трека</button>
      {sleep && <button className="text-button" type="button" onClick={() => changeSleep(null)}>Отменить таймер</button>}
    </div>
  </section>
}
