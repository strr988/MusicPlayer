import { expect, it, vi } from 'vitest'
import { normalizeShortcut, Shortcuts } from '../src/main/shortcuts'

function registry() {
  const registered = new Map<string, () => void>()
  const register = vi.fn((accelerator: string, callback: () => void) => {
    if (accelerator === 'Ctrl+Alt+F11' || registered.has(accelerator)) return false
    registered.set(accelerator, callback)
    return true
  })
  const unregister = vi.fn((accelerator: string) => registered.delete(accelerator))
  return { registered, register, unregister }
}

it('normalizes aliases and rejects bare keys, common system modifiers and unrelated media keys', () => {
  expect(normalizeShortcut('toggle', 'shift + Control + f8')).toBe('Ctrl+Shift+F8')
  expect(normalizeShortcut('toggle', 'MediaPlayPause')).toBe('MediaPlayPause')
  expect(normalizeShortcut('previous', 'MediaPlayPause')).toBeUndefined()
  for (const value of ['A', 'Ctrl+C', 'Alt+F4', 'Super+Alt+A', 'Ctrl+Ctrl+G', 'Ctrl+Shift+__proto__', NaN, {}]) {
    expect(normalizeShortcut('toggle', value)).toBeUndefined()
  }
})

it('registers every action, rejects duplicate and OS conflicts and frees its registrations', () => {
  const os = registry()
  const dispatch = vi.fn()
  const persist = vi.fn()
  const shortcuts = new Shortcuts(os, dispatch, { toggle: 'MediaPlayPause', next: 'Ctrl+Alt+F11' }, persist)
  expect(shortcuts.get().next).toEqual({ accelerator: 'Ctrl+Alt+F11', registered: false })
  os.registered.get('MediaPlayPause')?.()
  expect(dispatch).toHaveBeenLastCalledWith('toggle')
  expect(shortcuts.set('mute', 'Shift+Ctrl+F8').status).toBe('saved')
  expect(shortcuts.set('volumeDown', 'control+shift+f8').status).toBe('duplicate')
  expect(shortcuts.set('toggle', 'Ctrl+Alt+F11').status).toBe('duplicate')
  expect(shortcuts.set('next', 'Ctrl+Alt+F11').status).toBe('unavailable')
  expect(shortcuts.set('previous', 'Ctrl+Shift+F9').status).toBe('saved')
  expect(shortcuts.set('volumeUp', 'Ctrl+Shift+F10').status).toBe('saved')
  expect(shortcuts.set('volumeDown', 'Ctrl+Shift+F11').status).toBe('saved')
  expect(shortcuts.set('toggle', 'Ctrl+Shift+F12').status).toBe('saved')
  expect(shortcuts.set('next', 'Ctrl+Alt+F10').status).toBe('saved')
  expect(os.registered.size).toBe(6)
  for (const callback of os.registered.values()) callback()
  expect(new Set(dispatch.mock.calls.flat())).toEqual(new Set(['toggle', 'previous', 'next', 'volumeUp', 'volumeDown', 'mute']))
  expect(shortcuts.set('mute', null).status).toBe('saved')
  expect(persist).toHaveBeenLastCalledWith('mute', null)
  expect(os.registered.has('Ctrl+Shift+F8')).toBe(false)
  shortcuts.dispose()
  expect(os.registered.size).toBe(0)
  expect(Object.values(shortcuts.get()).every(binding => !binding.registered)).toBe(true)
})

it('keeps an existing registration when the OS or persistence refuses a replacement', () => {
  const os = registry()
  const shortcuts = new Shortcuts(os, vi.fn(), { toggle: 'MediaPlayPause' }, () => { throw new Error('SQLite') })
  expect(shortcuts.set('toggle', 'Ctrl+Alt+F11').status).toBe('unavailable')
  expect(() => shortcuts.set('toggle', 'Ctrl+Shift+F8')).toThrow('SQLite')
  expect([...os.registered.keys()]).toEqual(['MediaPlayPause'])
  expect(shortcuts.get().toggle).toEqual({ accelerator: 'MediaPlayPause', registered: true })
})
