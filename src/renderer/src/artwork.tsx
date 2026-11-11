import { useCallback, useState } from 'react'

const visibilityListeners = new WeakMap<Element, (visible: boolean) => void>()
const observer = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) visibilityListeners.get(target)?.(isIntersecting)
})

export function Artwork({ url, eager = false }: { url: string | null; eager?: boolean }) {
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
      <span>♪</span>
      {url && !failed && (eager || visible) && (
        <img src={url} alt="" decoding="async" onError={() => setFailed(true)} />
      )}
    </span>
  )
}
