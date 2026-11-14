import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { Artwork } from './artwork'
import { IconButton, LikeButton } from './icons'
import { LyricsPanel } from './lyrics-panel'
import { TransportControls } from './player'
import type { usePlayback } from './playback'
import { QueuePanel } from './queue-panel'
import { Timeline } from './timeline'
import { SoundMenu } from './sound-menu'
import { SleepMenu } from './sleep-menu'
import { DiscoButton, type useDiscoMode } from './disco'
import { VolumeControl } from './volume-control'

function coverTint(image: HTMLImageElement): string | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 12
  const context = canvas.getContext('2d')
  if (!context) return
  try {
    context.drawImage(image, 0, 0, 12, 12)
    const { data } = context.getImageData(0, 0, 12, 12)
    let red = 0, green = 0, blue = 0, total = 0
    for (let offset = 0; offset < data.length; offset += 4) {
      const [r, g, b, alpha] = data.subarray(offset, offset + 4)
      const weight = alpha / 255 * (1 + 3 * (Math.max(r, g, b) - Math.min(r, g, b)) / 255)
      red += r * weight
      green += g * weight
      blue += b * weight
      total += weight
    }
    if (total > 0) return `rgb(${Math.round(red / total)} ${Math.round(green / total)} ${Math.round(blue / total)})`
  } catch {
    // Some images cannot be sampled. The fullscreen player keeps its theme color.
  }
}

type FullPlayerControls = {
  playback: ReturnType<typeof usePlayback>
  hasTracks: boolean
  liked: boolean
  likeDisabled: boolean
  toggleLike: () => void
  close: () => void
  openMini: () => void
  discoLayer: ReactNode
  disco: ReturnType<typeof useDiscoMode>
}

export function FullPlayer({ dialog, open, ...controls }: FullPlayerControls & {
  dialog: RefObject<HTMLDialogElement | null>
  open: boolean
}) {
  return <dialog ref={dialog} className="full-player" aria-label="Полноэкранный плеер"
    onCancel={event => {
      event.preventDefault()
      controls.close()
    }}>
    {open && <FullPlayerContent {...controls} />}
  </dialog>
}

function FullPlayerContent({ playback, hasTracks, liked, likeDisabled, toggleLike, close, openMini, discoLayer, disco }: FullPlayerControls) {
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const side = queueOpen ? 'queue' : lyricsOpen ? 'lyrics' : null
  const [tint, setTint] = useState<{ url: string; color: string }>()
  const queueButton = useRef<HTMLButtonElement>(null)
  const queueClose = useRef<HTMLButtonElement>(null)
  const exit = useRef<HTMLButtonElement>(null)
  const more = useRef<HTMLDivElement>(null)
  const { track, loading, playing, volume } = playback
  const url = track?.artworkUrl
  useLayoutEffect(() => { exit.current?.focus() }, [])
  useLayoutEffect(() => {
    if (queueOpen) queueClose.current?.focus()
  }, [queueOpen])

  function closeQueue() {
    setQueueOpen(false)
    queueButton.current?.focus()
  }

  return <>
    <div className="full-player-stage" data-side={side ?? undefined}
      style={{ '--cover-tint': tint?.url === url ? tint?.color : undefined } as CSSProperties}
      onKeyDown={event => {
        if (!queueOpen || event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        closeQueue()
      }}>
      {discoLayer}
      <IconButton ref={exit} icon="collapse" label="Свернуть полноэкранный плеер" className="full-player-exit" onClick={close} />
      <div className="full-player-center">
        <div className="full-player-cover" data-paused={!playing}>
          <Artwork key={url} url={url ?? null} eager onLoad={image => {
            const color = coverTint(image)
            if (url && color) setTint({ url, color })
          }} />
          <div className="full-cover-controls">
            <VolumeControl fullscreen volume={volume} toggleMute={playback.toggleMute} setVolumeLevel={playback.setVolumeLevel} />
            <IconButton ref={queueButton} icon="queue" label="Очередь" className="full-queue-button"
              aria-expanded={queueOpen} aria-controls="full-playback-queue"
              onClick={() => queueOpen ? closeQueue() : setQueueOpen(true)} />
            <SoundMenu className="full-sound-button" sound={playback.sound} saving={playback.savingSoundEffect}
              error={playback.soundEffectError} changeEffect={playback.changeSoundEffect} changeReverb={playback.changeReverb} />
            <TransportControls playback={playback} hasTracks={hasTracks} />
            <div className="full-cover-actions">
              <IconButton icon="more" label="Дополнительно" popoverTarget="full-player-menu" aria-controls="full-player-menu" />
              <IconButton icon="lyrics" label="Текстомузыка" aria-pressed={side === 'lyrics'}
                onClick={() => {
                  setLyricsOpen(side !== 'lyrics')
                  setQueueOpen(false)
                }} />
              <LikeButton label="Лайк текущему треку" aria-pressed={liked} disabled={!track || likeDisabled}
                onClick={toggleLike} />
            </div>
          </div>
        </div>
        <div className="full-track-info">
          <h1 className="truncate" title={track?.title}>{track?.title ?? 'Трек не выбран'}</h1>
          <p className="muted truncate" title={track?.artist ?? undefined}>{track?.artist || 'Неизвестный исполнитель'}</p>
        </div>
        <Timeline audio={playback.audioProps.ref} duration={playback.duration}
          trackDuration={track?.durationSeconds ?? null} restoredPosition={playback.restoredPosition} seek={playback.seek} />
        {playback.error && <p className="muted" role="alert">{playback.error}</p>}
      </div>
      {lyricsOpen && <div className="full-player-side" hidden={queueOpen}>
        <LyricsPanel key={JSON.stringify([track?.id, url, track?.available])} track={track} active={!queueOpen} compact
          audio={playback.audioProps.ref} canSeek={playback.duration !== null && !loading} seek={playback.seek}
          mode="sync" />
      </div>}
      {queueOpen && <div className="full-player-side">
        <QueuePanel id="full-playback-queue" playback={playback} open close={closeQueue} closeButton={queueClose} />
      </div>}
    </div>
    <div ref={more} id="full-player-menu" className="sound-menu full-player-menu" popover="auto" aria-label="Дополнительно">
      <div className="full-player-menu-actions" role="group" aria-label="Действия плеера">
        <SleepMenu playback={playback} />
        <IconButton icon="mini" label="Открыть мини-плеер" onClick={() => {
          more.current?.hidePopover()
          openMini()
        }} />
        <DiscoButton {...disco} />
      </div>
      {disco.error && <p role="alert">{disco.error}</p>}
    </div>
  </>
}
