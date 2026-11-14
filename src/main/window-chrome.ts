import type { BrowserWindowConstructorOptions } from 'electron'
import type { Theme } from '../shared/contracts'

export const hasTitleBarOverlay = process.platform === 'win32' || process.platform === 'linux'

export function titleBarColors(theme: Theme) {
  return theme === 'light'
    ? { color: '#f1edf8', symbolColor: '#252032', height: 36 }
    : { color: '#18151e', symbolColor: '#f4eff8', height: 36 }
}

export function windowChrome(theme: Theme): BrowserWindowConstructorOptions {
  return hasTitleBarOverlay ? { titleBarStyle: 'hidden', titleBarOverlay: titleBarColors(theme) } : {}
}
