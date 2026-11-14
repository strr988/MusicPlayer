import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { LibraryTrack, Lyrics, LyricLine, LyricsMode } from '../../shared/contracts'
import { activeLyric } from './active-lyric'
import { Artwork } from './artwork'
import { EmptyState } from './empty-state'

export function LyricsPanel({ track, active, audio, canSeek, seek, mode, changeMode, close, compact = false }: {
  track: LibraryTrack | undefined
  active: boolean
  audio: RefObject<HTMLAudioElement | null>
  canSeek: boolean
  seek: (seconds: number) => void
  mode: LyricsMode
  changeMode?: (mode: LyricsMode) => void
  close?: () => void
  compact?: boolean
}) {
  const trackId = track?.id
  const available = track?.available
  const [result, setResult] = useState<{ lyrics: Lyrics | null } | 'error'>()
  const closeOnEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) close?.()
  })
  useEffect(() => {
    if (!active || mode !== 'sync' || !close) return
    const keydown = (event: KeyboardEvent) => closeOnEscape(event)
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [active, mode, !!close])
  useEffect(() => {
    if (!trackId || !available) return
    let current = true
    void window.mustplay.getLyrics(trackId).then(lyrics => {
      if (current) setResult({ lyrics })
    }).catch(() => {
      if (current) setResult('error')
    })
    return () => { current = false }
  }, [trackId, available])

  const lyrics = result && result !== 'error' ? result.lyrics : null
  const synchronized = lyrics?.kind === 'timed' && mode === 'sync'
  let body
  if (!track) {
    body = <EmptyState icon="lyrics" title="Трек не выбран">Запустите трек из библиотеки, плейлиста или «Моей волны».</EmptyState>
  } else if (!available || (result && result !== 'error' && !result.lyrics)) {
    body = <EmptyState icon="lyrics" title="Текст не найден">Добавьте LRC или TXT с именем трека рядом с аудиофайлом.</EmptyState>
  } else if (result === 'error') {
    body = <p role="alert">Не удалось прочитать текст песни.</p>
  } else if (!result) {
    body = <p className="muted" role="status">Читаем текст…</p>
  } else if (synchronized) {
    body = <TimedLyrics lines={lyrics.lines} active={active} audio={audio} canSeek={canSeek} seek={seek}
      showFollowButton={!compact} />
  } else if (lyrics) {
    const text = lyrics.kind === 'plain' ? lyrics.text : lyrics.lines.map(line => line.text).join('\n').trim()
    body = <>
      {mode === 'sync' && <p className="lyrics-note muted">У этого текста нет временных меток.</p>}
      <div className="lyrics-plain" tabIndex={0}>{text}</div>
    </>
  }
  const heading = mode === 'sync' ? 'Текстомузыка' : 'Текст песни'
  return <section id={compact ? 'full-player-lyrics' : 'song-lyrics'} aria-label={heading}
    className={mode === 'sync' || compact ? 'text-music' : undefined}>
    {(!compact || mode === 'read') && <header className="section-heading lyrics-heading">
      <div className="min-w-0">
        {compact ? <h2>{heading}</h2> : <h1>{heading}</h1>}
        {track && !compact && <div className="lyrics-track">
          <Artwork key={track.artworkUrl} url={track.artworkUrl} eager />
          <div className="min-w-0">
            <p className="track-name truncate" title={track.title}>{track.title}</p>
            {track.artist && <p className="muted truncate" title={track.artist}>{track.artist}</p>}
          </div>
        </div>}
      </div>
      {changeMode && lyrics?.kind === 'timed' && <button type="button" className="secondary" onClick={() => changeMode(mode === 'sync' ? 'read' : 'sync')}>
        {mode === 'sync' ? 'Читать текст' : 'Текстомузыка'}
      </button>}
    </header>}
    {body}
  </section>
}

function TimedLyrics({ lines, active, audio, canSeek, seek, showFollowButton }: {
  lines: LyricLine[]
  active: boolean
  audio: RefObject<HTMLAudioElement | null>
  canSeek: boolean
  seek: (seconds: number) => void
  showFollowButton: boolean
}) {
  const [current, setCurrent] = useState(-1)
  const [follow, setFollow] = useState(true)
  const currentLine = useRef<HTMLLIElement>(null)
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const element = audio.current
    if (!active || !element) return
    const update = () => setCurrent(element.hasAttribute('src') ? activeLyric(lines, element.currentTime) : -1)
    update()
    const events = ['timeupdate', 'seeking', 'emptied'] as const
    for (const event of events) element.addEventListener(event, update)
    return () => { for (const event of events) element.removeEventListener(event, update) }
  }, [active, audio, lines])
  useEffect(() => {
    if (!active || !follow) return
    const line = currentLine.current
    const scroller = list.current
    if (!scroller) return
    const top = line ? scroller.scrollTop + line.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top + (line.offsetHeight - scroller.clientHeight) / 2 : 0
    scroller.scrollTo({
      top,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    })
  }, [current, follow, active])

  return <>
    {showFollowButton && <div className="lyrics-toolbar">
      <button type="button" className={follow ? "primary" : "secondary"} aria-pressed={follow} onClick={() => setFollow(!follow)}>
        Следить за текстом
      </button>
    </div>}
    <ol ref={list} className="lyrics-lines" aria-label="Строки текста" onWheel={() => setFollow(false)}
      onTouchMove={() => setFollow(false)} onKeyDown={event => {
        if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) setFollow(false)
      }} onPointerDown={event => {
        if (event.target === event.currentTarget) setFollow(false)
      }} tabIndex={0}>
      {lines.map(({ seconds, text }, index) => <li key={index} ref={index === current ? currentLine : undefined}>
        {text && <button type="button" disabled={!canSeek} aria-current={index === current ? 'true' : undefined}
          data-past={index < current} onClick={() => { seek(seconds); setFollow(true) }}>{text}</button>}
      </li>)}
    </ol>
  </>
}
