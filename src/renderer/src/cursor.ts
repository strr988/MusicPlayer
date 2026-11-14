import { useEffect, useLayoutEffect, useState } from 'react'
import { playerOrigin } from '../../shared/contracts'
import type { CursorPreset, CursorSettings } from '../../shared/contracts'

export function useCursor(preset?: CursorPreset) {
  const id = preset?.id
  const ax = preset?.arrow?.x, ay = preset?.arrow?.y
  const px = preset?.pointer?.x, py = preset?.pointer?.y
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.cursor = ax === undefined ? id ?? 'mustplay' : 'custom'
    if (ax !== undefined && id) {
      root.style.setProperty('--cursor-arrow', 'url("' + playerOrigin + '/cursor/' + id + '/arrow") ' + ax + ' ' + ay)
      root.style.setProperty('--cursor-pointer', 'url("' + playerOrigin + '/cursor/' + id + '/pointer") ' + px + ' ' + py)
    }
    return () => {
      root.style.removeProperty('--cursor-arrow')
      root.style.removeProperty('--cursor-pointer')
    }
  }, [id, ax, ay, px, py])
}

export function useCursorSettings() {
  const [settings, setSettings] = useState<CursorSettings>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useCursor(settings?.selected)

  useEffect(() => {
    let active = true
    void window.mustplay.getCursorSettings().then(result => {
      if (active) setSettings(result)
    }).catch(() => { if (active) setError('Не удалось прочитать настройки курсора.') })
    return () => { active = false }
  }, [])

  async function save(action: () => Promise<CursorSettings | null>, failure: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const next = await action()
      if (next) setSettings(next)
    } catch {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  return {
    settings, busy, error,
    change: (id: string) => save(() => window.mustplay.setCursorPreset(id), 'Не удалось выбрать курсор.'),
    importPreset: () => save(() => window.mustplay.importCursorPreset(),
      'Не удалось импортировать пресет. Проверьте формат JSON, изображения PNG до 64 × 64 и лимит в 32 пресета.'),
  }
}
