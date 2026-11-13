import { useCallback, useState } from 'react'
import { Icon } from './icons'

const visibilityListeners = new WeakMap<Element, (visible: boolean) => void>()
const observer = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) visibilityListeners.get(target)?.(isIntersecting)
})

export function Artwork({ url, eager = false, onLoad }: {
  url: string | null
  eager?: boolean
  onLoad?: (image: HTMLImageElement) => void
}) {
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(false)
  const observe = useCallback((element: HTMLSpanElement | null) => {
    if (!element) return
    visibilityListeners.set(element, setVisible)
    observer.observe(element)
    return () => {
      observer.unobserve(element)
      visibilityListeners.delete(element)
    }
  }, [])

  return (
    <span className="artwork" aria-hidden="true" ref={url && !failed && !eager ? observe : undefined}>
      <Icon name="music" />
      {url && !failed && (eager || visible) && (
        <img src={url} alt="" decoding="async" onLoad={onLoad && (event => onLoad(event.currentTarget))}
          onError={() => setFailed(true)} />
      )}
    </span>
  )
}
