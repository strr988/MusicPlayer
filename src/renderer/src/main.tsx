import { createRoot } from 'react-dom/client'
import type { MiniPlayerApi, MusicPlayerApi } from '../../shared/contracts'
import { App } from './app'
import { MiniPlayer } from './mini-player'
import './styles.css'

declare global {
  interface Window {
    musicPlayer: MusicPlayerApi
    miniPlayer?: MiniPlayerApi
  }
}

createRoot(document.getElementById('root')!).render(window.miniPlayer ? <MiniPlayer api={window.miniPlayer} /> : <App />)
