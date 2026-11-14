import { useEffect, useEffectEvent, useState } from 'react'
import type { PlaybackCommand } from '../../shared/contracts'
import type { usePlayback } from './playback'

export function useDesktopPlayback(playback: ReturnType<typeof usePlayback>, hasTracks: boolean): boolean {
  const [miniVisible, setMiniVisible] = useState(false)
  const { track, currentEntryId, playing, ready, loading, duration, restoredPosition, volume, canGoBack, canGoNext,
    sound, savingSoundEffect, soundEffectError } = playback
  const audio = playback.audioProps.ref

  const dispatch = useEffectEvent((command: PlaybackCommand) => {
    switch (command.type) {
      case 'toggle': playback.toggle(); break
      case 'next': playback.step(1); break
      case 'previous': playback.step(-1); break
      case 'volumeUp': playback.adjustVolume(0.05); break
      case 'volumeDown': playback.adjustVolume(-0.05); break
      case 'mute': playback.toggleMute(); break
      case 'volume': playback.setVolumeLevel(command.level); break
      case 'sound-effect': playback.changeSoundEffect(command.effect); break
      case 'reverb': playback.changeReverb(command.effect, command.enabled); break
      case 'seek':
        if (currentEntryId === command.entryId && !loading) playback.seek(command.seconds)
        break
    }
  })
  useEffect(() => {
    const unsubscribeCommand = window.mustplay.onPlaybackCommand(command => dispatch(command))
    const unsubscribeVisibility = window.mustplay.onMiniVisibility(setMiniVisible)
    return () => {
      unsubscribeCommand()
      unsubscribeVisibility()
    }
  }, [])

  const publish = useEffectEvent(() => {
    void window.mustplay.publishMiniState({
      track: track ? { title: track.title.slice(0, 1024), artist: track.artist?.slice(0, 1024) ?? null, artworkUrl: track.artworkUrl } : null,
      entryId: currentEntryId,
      position: restoredPosition ?? audio.current?.currentTime ?? 0,
      duration: duration ?? track?.durationSeconds ?? null,
      seekable: duration !== null && !loading,
      playing, volume, canGoBack, canGoNext: ready && canGoNext, canPlay: hasTracks && ready && !loading,
      sound, savingSound: savingSoundEffect, soundError: soundEffectError,
    }).catch(error => console.error('Could not publish mini player state', error))
  })
  useEffect(() => {
    if (miniVisible) publish()
  }, [miniVisible, hasTracks, track, currentEntryId, playing, ready, loading, duration, restoredPosition, volume, canGoBack, canGoNext,
    sound, savingSoundEffect, soundEffectError])
  useEffect(() => {
    const element = audio.current
    if (!miniVisible || !element) return
    const update = () => publish()
    const events = ['timeupdate', 'seeked', 'emptied'] as const
    for (const event of events) element.addEventListener(event, update)
    return () => { for (const event of events) element.removeEventListener(event, update) }
  }, [audio, miniVisible])
  return miniVisible
}
