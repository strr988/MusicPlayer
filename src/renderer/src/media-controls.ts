import { useEffect, useEffectEvent } from 'react'
import type { usePlayback } from './playback'

export function useMediaControls(playback: ReturnType<typeof usePlayback>): void {
  const { track, playing, canGoBack, canGoNext } = playback
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.shiftKey ||
        event.isComposing || (event.target instanceof HTMLElement &&
        (event.target.isContentEditable || event.target.closest('input, textarea, select, button, a, [role="textbox"]')))) return
    if (event.code === 'Space' && !event.altKey && playback.ready) playback.toggle()
    else if (event.altKey && event.code === 'ArrowLeft' && playback.canGoBack) playback.step(-1)
    else if (event.altKey && event.code === 'ArrowRight' && playback.canGoNext) playback.step(1)
    else return
    event.preventDefault()
  })
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])

  const onMediaAction = useEffectEvent(({ action, seekTime }: MediaSessionActionDetails) => {
    if (action === 'play') playback.resume()
    if (action === 'pause') playback.pause()
    if (action === 'previoustrack' && playback.canGoBack) playback.step(-1)
    if (action === 'nexttrack' && playback.canGoNext) playback.step(1)
    if (action === 'seekto' && seekTime !== undefined) playback.seek(seekTime)
  })
  useEffect(() => {
    if (!navigator.mediaSession || !track) return
    const actions: MediaSessionAction[] = ['play', 'pause', 'seekto']
    if (canGoBack) actions.push('previoustrack')
    if (canGoNext) actions.push('nexttrack')
    const registered = actions.filter(action => {
      try {
        navigator.mediaSession.setActionHandler(action, details => onMediaAction(details))
        return true
      } catch {
        return false
      }
    })
    return () => registered.forEach(action => navigator.mediaSession.setActionHandler(action, null))
  }, [!!track, canGoBack, canGoNext])
  useEffect(() => {
    if (!navigator.mediaSession) return
    navigator.mediaSession.metadata = track ? new MediaMetadata({
      title: track.title, artist: track.artist ?? '', album: track.album ?? '',
    }) : null
    return () => { navigator.mediaSession.metadata = null }
  }, [track])
  useEffect(() => {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = track ? (playing ? 'playing' : 'paused') : 'none'
  }, [track, playing])
}
