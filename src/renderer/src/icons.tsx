import { useRef } from 'react'
import type { ComponentProps, ReactNode } from 'react'

const drawings = {
  music: <><path d="M9 18V5l11-2v13M9 9l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></>,
  library: <><rect x="3" y="4" width="4" height="16" rx="1" /><rect x="10" y="4" width="4" height="16" rx="1" /><path d="m17 5 4 14" /></>,
  wave: <path d="M3 10v4m4-8v12m5-15v18m5-14v10m4-7v4" />,
  playlists: <path d="M3 5h17M3 10h17M3 15h9m4-1 5 3-5 3z" />,
  lyrics: <path d="M5 4h14v13H9l-4 3zm4 5h6m-6 4h4" />,
  settings: <path d="M4 6h16M8 3v6m-4 3h16m-5-3v6M4 18h16M10 15v6" />,
  effects: <path d="M4 10v4m4-7v10m4-13v16m4-12v8m4-6v4" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  moon: <path d="M20.9 13.2A9 9 0 0 1 10.8 3.1 9 9 0 1 0 20.9 13.2Z" />,
  pin: <path d="M9 4h6l-1 6 4 4H6l4-4zm3 10v7" />,
  expand: <path d="M14 4h6v6m0-6-7 7M10 20H4v-6m0 6 7-7" />,
  collapse: <path d="m6 9 6 6 6-6" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  mini: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M12 12h6v4h-6z" /></>,
  folder: <path d="M3 19h18V7h-9L9 4H3zM12 10v6m-3-3h6" />,
  refresh: <path d="M20 4v5h-5M4 20v-5h5m11-6a8 8 0 0 0-13-3m-3 9a8 8 0 0 0 13 3" />,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
  up: <path d="M12 20V4m-6 6 6-6 6 6" />,
  down: <path d="M12 4v16m-6-6 6 6 6-6" />,
  left: <path d="m14 6-6 6 6 6" />,
  right: <path d="m10 6 6 6-6 6" />,
  heart: <path d="M12 20 4.5 12.8a4.7 4.7 0 0 1 6.6-6.7l.9.9.9-.9a4.7 4.7 0 0 1 6.6 6.7Z" />,
  nextInQueue: <path d="M4 5h16M12 20V9m-5 5 5-5 5 5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  addToPlaylist: <path d="M3 5h15M3 10h15M3 15h8m6-3v8m-4-4h8" />,
  queue: <><path d="M3 5h18M3 10h18M3 15h9" /><path d="m16 14 5 3-5 3z" fill="currentColor" strokeLinejoin="round" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  play: <path d="m8 5 12 7-12 7z" fill="currentColor" />,
  pause: <><path d="M8 5v14m8-14v14" strokeWidth="3" /></>,
  previous: <><path d="m18 5-10 7 10 7z" fill="currentColor" /><path d="M5 5v14" /></>,
  next: <><path d="m6 5 10 7-10 7z" fill="currentColor" /><path d="M19 5v14" /></>,
  shuffle: <path d="M3 6h3c4 0 6 12 11 12h4m-4-4 4 4-4 4M3 18h3c1.2 0 2.2-1 3-2.4M14 8c.8-1.1 1.8-2 3-2h4m-4-4 4 4-4 4" />,
  repeat: <path d="m16 2 4 4-4 4m4-4H7a4 4 0 0 0-4 4v2m5 10-4-4 4-4m-4 4h13a4 4 0 0 0 4-4v-2" />,
  volume: <path d="M3 9h4l5-4v14l-5-4H3zm13 0a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12" />,
  mute: <path d="M3 9h4l5-4v14l-5-4H3zm13 1 5 5m0-5-5 5" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof drawings

export function LikeButton({ onClick, ...props }: Omit<ComponentProps<typeof IconButton>, 'icon'>) {
  const pulse = useRef<HTMLSpanElement>(null)
  return <IconButton {...props} icon="heart" decoration={<span ref={pulse} className="like-burst" aria-hidden="true" />}
    onClick={event => {
      onClick?.(event)
      if (props['aria-pressed'] !== false || matchMedia('(prefers-reduced-motion: reduce)').matches) return
      event.currentTarget.querySelector('svg')?.animate(
        [{ transform: 'scale(.8)' }, { transform: 'scale(1.42)', offset: .38 }, { transform: 'scale(.94)', offset: .75 }, { transform: 'scale(1)' }],
        { duration: 420, easing: 'ease-out' },
      )
      pulse.current?.animate(
        [{ opacity: .85, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.65)' }],
        { duration: 520, easing: 'ease-out' },
      )
    }} />
}

export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" data-icon={name} aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"
    fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    {drawings[name]}
  </svg>
}

export function IconButton({ icon, label, title = label, className, decoration, ...props }: ComponentProps<'button'> & {
  icon: IconName
  label: string
  decoration?: ReactNode
}) {
  return <button type="button" className={className ? 'icon-button ' + className : 'icon-button'}
    aria-label={label} title={title} {...props}>{decoration}<Icon name={icon} /></button>
}
