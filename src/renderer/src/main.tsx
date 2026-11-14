import { createRoot } from 'react-dom/client'
import type { MiniPlayerApi, MustplayApi, Theme } from '../../shared/contracts'
import { App } from './app'
import { MiniPlayer } from './mini-player'
import './styles.css'

declare global {
  interface Window {
    mustplay: MustplayApi
    miniPlayer?: MiniPlayerApi
  }
}

const colorScheme = matchMedia('(prefers-color-scheme: light)')
const theme: Theme = colorScheme.matches ? 'light' : 'dark'
document.documentElement.dataset.theme = theme
if (window.miniPlayer) {
  colorScheme.addEventListener('change', event => {
    document.documentElement.dataset.theme = event.matches ? 'light' : 'dark'
  })
}
createRoot(document.getElementById('root')!).render(
  window.miniPlayer ? <MiniPlayer api={window.miniPlayer} /> : <App initialTheme={theme} />,
)
