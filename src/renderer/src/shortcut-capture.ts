const keyNames: Record<string, string> = {
  Space: 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
}

export function captureShortcut(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'getModifierState'>): string | null {
  if (event.metaKey || event.getModifierState('AltGraph')) return null
  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (modifiers.length < 2) return null
  const { code } = event
  const key = /^(?:Key[A-Z]|Digit[0-9])$/.test(code) ? code.at(-1)
    : /^F(?:[1-9]|1\d|2[0-4])$/.test(code) ? code
      : Object.hasOwn(keyNames, code) ? keyNames[code] : undefined
  return key ? [...modifiers, key].join('+') : null
}
