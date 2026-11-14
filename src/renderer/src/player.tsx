import { repeatModes } from '../../shared/contracts'
import type { RepeatMode } from '../../shared/contracts'
import { Artwork } from './artwork'
import { Icon, IconButton, LikeButton } from './icons'
import type { usePlayback } from './playback'
import { Timeline } from './timeline'
import { SoundMenu } from './sound-menu'
import type { RefObject } from 'react'

const repeatLabels: Record<RepeatMode, string> = {
  off: 'Выключен', all: 'Вся очередь', one: 'Один трек',
}

export function Player({ playback, hasTracks, liked, likeDisabled, toggleLike, queueOpen, toggleQueue, queueButton,
  textMusicOpen, textMusicButton, toggleTextMusic, openFullPlayer, fullPlayerButton }: {
  playback: ReturnType<typeof usePlayback>
  hasTracks: boolean
  liked: boolean
  likeDisabled: boolean
  toggleLike: () => void
  queueOpen: boolean
  toggleQueue: () => void
  queueButton: RefObject<HTMLButtonElement | null>
  textMusicOpen: boolean
  textMusicButton: RefObject<HTMLButtonElement | null>
  toggleTextMusic: () => void
  openFullPlayer: () => void
  fullPlayerButton: RefObject<HTMLButtonElement | null>
}) {
  const { track, volume, queue, loading, mode, playlistName, waveNotice } = playback
  const level = Math.round((volume?.level ?? 1) * 100)
  const context = mode === 'wave' ? waveNotice || (loading ? 'Подбираем трек…' : 'Режим «Моя волна»')
    : loading ? 'Открываем трек…' : playlistName ? 'Плейлист «' + playlistName + '»' : ''

  return <footer className="player" aria-label="Воспроизведение">
    <audio {...playback.audioProps} preload="metadata" crossOrigin="anonymous" />
    <div className="now-playing">
      {track ? <button ref={fullPlayerButton} className="player-cover-button" type="button" aria-label="На весь экран"
        title="На весь экран" aria-haspopup="dialog" onClick={openFullPlayer}>
        <Artwork key={track.artworkUrl} url={track.artworkUrl} eager />
        <span className="player-cover-expand"><Icon name="expand" /></span>
      </button> : <Artwork url={null} eager />}
      <div className="player-track">
        <p className="track-name truncate" title={track?.title}>{track?.title ?? 'Трек не выбран'}</p>
        <p className="muted truncate" title={track?.artist ?? undefined}>{track?.artist || (track ? 'Неизвестный исполнитель' : 'Выберите трек в библиотеке')}</p>
        {context && <p className="player-context truncate" role="status" title={context}>{context}</p>}
      </div>
      <LikeButton label="Лайк текущему треку" aria-pressed={liked} disabled={!track || likeDisabled}
        onClick={toggleLike} />
    </div>
    <div className="transport">
      <TransportControls playback={playback} hasTracks={hasTracks} />
      <Timeline audio={playback.audioProps.ref} duration={playback.duration}
        trackDuration={track?.durationSeconds ?? null} restoredPosition={playback.restoredPosition} seek={playback.seek} />
    </div>
    <div className="player-tools">
      <SoundMenu sound={playback.sound} saving={playback.savingSoundEffect} error={playback.soundEffectError}
        changeEffect={playback.changeSoundEffect} changeReverb={playback.changeReverb} />
      <IconButton ref={textMusicButton} icon="lyrics" label="Текстомузыка" aria-pressed={textMusicOpen}
        aria-controls="song-lyrics" disabled={!track && !textMusicOpen} onClick={toggleTextMusic} />
      <div className="volume">
        <IconButton icon={volume?.muted ? 'mute' : 'volume'} label="Без звука" aria-pressed={volume?.muted ?? false}
          title={volume?.muted ? 'Включить звук' : 'Отключить звук'} disabled={!volume}
          onClick={() => volume && playback.changeVolume({ ...volume, muted: !volume.muted })} />
        <input aria-label="Громкость" type="range" min={0} max={100} step={1} value={level} disabled={!volume}
          aria-valuetext={level + '%'} title={level + '%'}
          onChange={event => volume && playback.changeVolume({ ...volume, level: event.currentTarget.valueAsNumber / 100 })} />
      </div>
      <button type="button" className="queue-toggle secondary" ref={queueButton} aria-expanded={queueOpen}
        aria-controls="playback-queue" aria-label={'Очередь (' + queue.pending.length + ')'}
        title={queueOpen ? 'Закрыть очередь' : 'Открыть очередь'} onClick={toggleQueue}>
        <Icon name="queue" /><span aria-hidden="true">{queue.pending.length}</span>
      </button>
    </div>
  </footer>
}

export function TransportControls({ playback, hasTracks }: {
  playback: ReturnType<typeof usePlayback>
  hasTracks: boolean
}) {
  const { queue, playing, loading, ready, mode } = playback
  const repeatLabel = queue.repeat === 'all' && mode === 'wave' ? 'Непрерывная волна' : repeatLabels[queue.repeat]
  return <div className="controls" role="group" aria-label="Управление воспроизведением">
    <IconButton icon="shuffle" label="Shuffle" aria-pressed={queue.shuffle && mode !== 'wave'}
      title={mode === 'wave' ? 'Порядок рекомендаций определяет «Моя волна»' : 'Перемешать ожидающие треки (Shuffle)'}
      disabled={!ready || mode === 'wave'} onClick={playback.changeShuffle} />
    <IconButton icon="previous" label="Предыдущий трек" disabled={!playback.canGoBack} onClick={() => playback.step(-1)} />
    <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Пауза' : 'Воспроизвести'} className="play-button"
      disabled={!hasTracks || loading || !ready} onClick={playback.toggle} />
    <IconButton icon="next" label="Следующий трек" disabled={!playback.canGoNext || !ready} onClick={() => playback.step(1)} />
    <label className="repeat-control icon-button" data-active={queue.repeat !== 'off'} title={'Повтор · ' + repeatLabel}>
      <Icon name="repeat" />
      {queue.repeat === 'one' && <span aria-hidden="true">1</span>}
      <select className="player-select" aria-label="Режим повтора" value={queue.repeat} disabled={!ready}
        onChange={event => playback.changeRepeat(event.currentTarget.value as RepeatMode)}>
        {repeatModes.map(item => <option key={item} value={item} disabled={item === 'all' && mode === 'wave'}>
          {item === 'all' && mode === 'wave' ? 'Непрерывная волна' : repeatLabels[item]}
        </option>)}
      </select>
    </label>
  </div>
}
