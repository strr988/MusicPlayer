import { createRoot } from 'react-dom/client'
import type { MusicPlayerApi } from '../../shared/contracts'
import { App } from './app'
import './styles.css'

declare global {
  interface Window {
    musicPlayer: MusicPlayerApi
  }
}

createRoot(document.getElementById('root')!).render(<App />)
