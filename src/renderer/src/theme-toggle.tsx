import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Theme } from '../../shared/contracts'
import { Icon } from './icons'

export function ThemeToggle({ initialTheme, reportError }: { initialTheme: Theme; reportError: (message: string) => void }) {
  const [theme, setTheme] = useState(initialTheme)
  const switching = useRef(false)
  const next = theme === 'dark' ? 'light' : 'dark'
  const label = next === 'light' ? 'Включить светлую тему' : 'Включить тёмную тему'

  async function toggle() {
    if (switching.current) return
    switching.current = true
    reportError('')
    const apply = async () => {
      await window.mustplay.setTheme(next)
      document.documentElement.dataset.theme = next
      flushSync(() => setTheme(next))
    }
    try {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches || !document.startViewTransition) {
        await apply()
      } else {
        await document.startViewTransition(apply).finished
      }
    } catch {
      reportError('Не удалось сохранить тему.')
    } finally {
      switching.current = false
    }
  }

  return <button type="button" className="theme-toggle" aria-label={label} title={label} onClick={() => void toggle()}>
    <Icon name={next === 'light' ? 'sun' : 'moon'} />
    <span>{next === 'light' ? 'Светлая тема' : 'Тёмная тема'}</span>
  </button>
}
