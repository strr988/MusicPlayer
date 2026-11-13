import { shortcutActions } from '../shared/contracts'
import type { ShortcutAction, ShortcutBinding, ShortcutBindings, ShortcutResult } from '../shared/contracts'

interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

const mediaKeys: Partial<Record<ShortcutAction, string>> = {
  toggle: 'MediaPlayPause', next: 'MediaNextTrack', previous: 'MediaPreviousTrack',
}
const modifierNames = ['Ctrl', 'Alt', 'Shift']
const modifierAliases: Record<string, string> = {
  ctrl: 'Ctrl', control: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl',
  alt: 'Alt', shift: 'Shift',
}
const specialKeys: Record<string, string> = {
  space: 'Space', left: 'Left', right: 'Right', up: 'Up', down: 'Down',
}

export function normalizeShortcut(action: ShortcutAction, input: unknown): string | null | undefined {
  if (input === null) return null
  if (typeof input !== 'string' || input.length > 64) return undefined
  const source = input.trim().toLowerCase()
  const media = mediaKeys[action]
  if (media?.toLowerCase() === source) return media
  const parts = source.split('+').map(part => part.trim())
  const key = parts.pop() ?? ''
  const modifiers = new Set(parts.map(part => Object.hasOwn(modifierAliases, part) ? modifierAliases[part] : ''))
  // Leave unmodified typing, Windows-key combinations and common one-modifier shortcuts to the OS and apps.
  if (modifiers.size < 2 || modifiers.size !== parts.length || modifiers.has('')) return undefined
  const primary = /^[a-z0-9]$|^f(?:[1-9]|1\d|2[0-4])$/.test(key) ? key.toUpperCase()
    : Object.hasOwn(specialKeys, key) ? specialKeys[key] : undefined
  if (!primary) return undefined
  return [...modifierNames.filter(name => modifiers.has(name)), primary].join('+')
}

export class Shortcuts {
  private readonly bindings: ShortcutBindings

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly dispatch: (action: ShortcutAction) => void,
    saved: Partial<Record<ShortcutAction, string>>,
    private readonly persist: (action: ShortcutAction, accelerator: string | null) => void,
  ) {
    this.bindings = Object.fromEntries(shortcutActions.map(action => [action, {
      accelerator: normalizeShortcut(action, saved[action]) ?? null, registered: false,
    }])) as ShortcutBindings
    for (const action of shortcutActions) {
      const binding = this.bindings[action]
      if (binding.accelerator && !shortcutActions.some(other =>
        this.bindings[other].registered && this.bindings[other].accelerator === binding.accelerator)) {
        binding.registered = this.register(action, binding.accelerator)
      }
    }
  }

  get(): ShortcutBindings {
    return structuredClone(this.bindings)
  }

  set(action: ShortcutAction, input: unknown): ShortcutResult {
    const accelerator = normalizeShortcut(action, input)
    if (accelerator === undefined) return { status: 'invalid' }
    const before = this.bindings[action]
    if (accelerator === before.accelerator && (before.registered || !accelerator)) {
      return { status: 'saved', binding: { ...before } }
    }
    if (accelerator && shortcutActions.some(other => other !== action && this.bindings[other].accelerator === accelerator)) {
      return { status: 'duplicate' }
    }
    if (accelerator && !this.register(action, accelerator)) return { status: 'unavailable' }
    try {
      this.persist(action, accelerator)
    } catch (error) {
      if (accelerator) this.registry.unregister(accelerator)
      throw error
    }
    if (before.accelerator && before.registered) this.registry.unregister(before.accelerator)
    const binding: ShortcutBinding = { accelerator, registered: accelerator !== null }
    this.bindings[action] = binding
    return { status: 'saved', binding: { ...binding } }
  }

  dispose(): void {
    for (const { accelerator, registered } of Object.values(this.bindings)) {
      if (accelerator && registered) this.registry.unregister(accelerator)
    }
    for (const binding of Object.values(this.bindings)) binding.registered = false
  }

  private register(action: ShortcutAction, accelerator: string): boolean {
    try {
      return this.registry.register(accelerator, () => this.dispatch(action))
    } catch {
      return false
    }
  }
}
