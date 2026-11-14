import type { BrowserWindowConstructorOptions } from 'electron'
import type { Theme } from '../shared/contracts'

export const hasTitleBarOverlay = process.platform === 'win32' || process.platform === 'linux'

export function titleBarColors(theme: Theme) {
  const light = theme === 'light'
  return {
    color: process.platform === 'win32' ? '#00000000' : light ? '#f1edf8' : '#18151e',
    symbolColor: light ? '#252032' : '#f4eff8',
    height: 36,
  }
}

export function windowChrome(theme: Theme): BrowserWindowConstructorOptions {
  return hasTitleBarOverlay ? { titleBarStyle: 'hidden', titleBarOverlay: titleBarColors(theme) } : {}
}
