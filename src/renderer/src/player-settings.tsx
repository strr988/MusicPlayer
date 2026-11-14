import { useEffect, useId, useRef, useState } from 'react'
import { defaultWavePulse, interfaceScales, maxWavePulse, shortcutActions } from '../../shared/contracts'
import type { InterfaceScale, ShortcutAction, ShortcutBinding, ShortcutBindings } from '../../shared/contracts'
import type { useCursorSettings } from './cursor'
import type { useDiscoMode } from './disco'
import { captureShortcut } from './shortcut-capture'

const shortcutLabels: Record<ShortcutAction, string> = {
  toggle: 'Воспроизведение / пауза', next: 'Следующий трек', previous: 'Предыдущий трек',
  volumeUp: 'Громче', volumeDown: 'Тише', mute: 'Отключить / включить звук',
}
const mediaKeys: Partial<Record<ShortcutAction, string>> = {
  toggle: 'MediaPlayPause', next: 'MediaNextTrack', previous: 'MediaPreviousTrack',
}
const shortcutErrors = {
  invalid: 'Нажмите две или три клавиши из Ctrl, Alt и Shift вместе с буквой, цифрой, F-клавишей, пробелом или стрелкой.',
  duplicate: 'Это сочетание уже назначено другому действию.',
  unavailable: 'Windows не зарегистрировала сочетание. Возможно, оно занято.',
}

export function PlayerSettings({ wavePulse, changeWavePulse, disco, cursor }: {
  wavePulse: number | null
  changeWavePulse: (value: number) => void
  disco: ReturnType<typeof useDiscoMode>
  cursor: ReturnType<typeof useCursorSettings>
}) {
  return <section aria-label="Настройки плеера">
    <header className="section-heading">
      <h1>Настройки</h1>
    </header>
    <div className="player-settings">
      <InterfaceSettings disco={disco} cursor={cursor} />
      <section className="settings-card">
        <h2>Моя волна</h2>
        <label className="pulse-setting">
          <span>Сила пульсации</span>
          <span className="muted" aria-hidden="true">{wavePulse === 0 ? 'Выключена' : `${wavePulse ?? defaultWavePulse}%`}</span>
          <input type="range" aria-label="Сила пульсации" min={0} max={maxWavePulse} step={5}
            value={wavePulse ?? defaultWavePulse} disabled={wavePulse === null}
            aria-valuetext={wavePulse === 0 ? 'Выключена' : `${wavePulse ?? defaultWavePulse}%`}
            onChange={event => changeWavePulse(event.currentTarget.valueAsNumber)} />
        </label>
      </section>
      <ShortcutSettings />
    </div>
  </section>
}

function InterfaceSettings({ disco, cursor }: { disco: ReturnType<typeof useDiscoMode>; cursor: ReturnType<typeof useCursorSettings> }) {
  const [scale, setScale] = useState<InterfaceScale>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.mustplay.getInterfaceScale().then(value => {
      if (active) setScale(value)
    }).catch(() => {
      if (active) setError('Не удалось загрузить масштаб.')
    })
    return () => { active = false }
  }, [])

  async function changeScale(value: InterfaceScale) {
    setSaving(true)
    setError('')
    try {
      await window.mustplay.setInterfaceScale(value)
      setScale(value)
    } catch {
      setError('Не удалось сохранить масштаб.')
    } finally {
      setSaving(false)
    }
  }

  return <section className="settings-card">
    <h2>Интерфейс</h2>
    <label className="settings-option">
      <span>Масштаб интерфейса</span>
      <select className="settings-input player-select" aria-label="Масштаб интерфейса" value={scale ?? ''} disabled={scale === undefined || saving}
        onChange={event => void changeScale(Number(event.currentTarget.value) as InterfaceScale)}>
        {scale === undefined && <option value="">—</option>}
        {interfaceScales.map(value => <option key={value} value={value}>{value}%</option>)}
      </select>
    </label>
    {error && <p role="alert">{error}</p>}
    <label className="settings-option">
      <span>Курсор</span>
      <select className="settings-input player-select" value={cursor.settings?.selected.id ?? ''}
        disabled={cursor.busy || !cursor.settings} onChange={event => void cursor.change(event.currentTarget.value)}>
        {!cursor.settings && <option value="">—</option>}
        {cursor.settings?.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
      </select>
    </label>
    <div className="settings-actions">
      <button type="button" className="secondary" disabled={cursor.busy || !cursor.settings}
        onClick={() => void cursor.importPreset()}>Импортировать пресет курсора</button>
    </div>
    <p className="muted">Выберите JSON-пресет mustplay. Чтобы вернуть курсор Windows, выберите «Системный».</p>
    {cursor.error && <p role="alert">{cursor.error}</p>}
    <label className="settings-option disco-setting">
      <span>Диско-режим</span>
      <input type="checkbox" role="switch" checked={disco.enabled ?? false} disabled={disco.enabled === null || disco.saving}
        onChange={event => void disco.change(event.currentTarget.checked)} />
    </label>
    <p className="muted">Мягкие волны пульсируют под басовые удары.</p>
    {disco.error && <p role="alert">{disco.error}</p>}
  </section>
}

function ShortcutSettings() {
  const [bindings, setBindings] = useState<ShortcutBindings>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void window.mustplay.getShortcuts().then(value => {
      if (active) setBindings(value)
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])

  return <section className="settings-card">
    <h2>Глобальные горячие клавиши</h2>
    <p className="muted">Нажмите «Записать сочетание», затем нужные клавиши. Например, Ctrl+Shift+F8.</p>
    {failed ? <p role="alert">Не удалось загрузить сочетания.</p>
      : !bindings ? <p className="muted" role="status">Загружаем сочетания…</p>
        : <div className="shortcut-list">{shortcutActions.map(action => <ShortcutRow key={action} action={action}
          binding={bindings[action]} onSave={binding => setBindings(current => current && { ...current, [action]: binding })} />)}</div>}
  </section>
}

function ShortcutRow({ action, binding, onSave }: {
  action: ShortcutAction
  binding: ShortcutBinding
  onSave: (binding: ShortcutBinding) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(binding.accelerator ?? '')
  const [recording, setRecording] = useState(false)
  const capture = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const media = mediaKeys[action]
  function stopCapture() {
    if (!capture.current) return
    capture.current = false
    setRecording(false)
    void window.mustplay.setShortcutCapture(false).catch(() => {})
  }

  useEffect(() => {
    if (!recording) return
    window.addEventListener('blur', stopCapture)
    return () => window.removeEventListener('blur', stopCapture)
  }, [recording])
  useEffect(() => () => {
    if (capture.current) {
      capture.current = false
      void window.mustplay.setShortcutCapture(false).catch(() => {})
    }
  }, [])

  async function startCapture() {
    if (capture.current) return
    capture.current = true
    setError('')
    try {
      await window.mustplay.setShortcutCapture(true)
      if (capture.current) setRecording(true)
    } catch {
      if (capture.current) {
        stopCapture()
        setError('Не удалось начать запись сочетания.')
      }
    }
  }

  async function save(accelerator: string | null) {
    setSaving(true)
    setError('')
    try {
      const result = await window.mustplay.setShortcut(action, accelerator)
      if (result.status === 'saved') {
        setDraft(result.binding.accelerator ?? '')
        onSave(result.binding)
      } else {
        setError(shortcutErrors[result.status])
      }
    } catch {
      setError('Не удалось сохранить сочетание.')
    } finally {
      setSaving(false)
    }
  }

  return <form className="shortcut-row" onSubmit={event => {
    event.preventDefault()
    if (draft && !recording) void save(draft)
  }}>
    <label htmlFor={id}>{shortcutLabels[action]}</label>
    <div className="settings-actions">
      <button className="secondary shortcut-capture" id={id} type="button" disabled={saving}
        aria-label={shortcutLabels[action] + ' — ' + (recording ? 'нажмите клавиши' : draft || 'записать сочетание')}
        aria-pressed={recording} aria-describedby={id + '-status'}
        onClick={() => recording ? stopCapture() : void startCapture()} onBlur={stopCapture}
        onKeyDown={event => {
          if (!recording || event.key === 'Tab') return
          event.preventDefault()
          if (event.repeat || event.nativeEvent.isComposing || ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(event.key)) return
          if (event.key === 'Escape') {
            stopCapture()
            setError('')
            return
          }
          const accelerator = captureShortcut(event.nativeEvent)
          if (!accelerator) {
            setError(shortcutErrors.invalid)
            return
          }
          setDraft(accelerator)
          setError('')
          stopCapture()
        }}>{recording ? 'Нажмите клавиши…' : draft || 'Записать сочетание'}</button>
      <button className="secondary" type="submit" disabled={saving || recording || !draft}>Сохранить</button>
      {media && <button className="secondary" type="button" disabled={saving}
        onClick={() => void save(media)}>Медиаклавиша</button>}
      {binding.accelerator && <button className="text-button" type="button" disabled={saving}
        onClick={() => void save(null)}>Отключить</button>}
    </div>
    <p className="muted" id={id + '-status'} role={error ? 'alert' : 'status'}>
      {error || (binding.accelerator ? binding.accelerator + (binding.registered ? ' · активно' : ' · недоступно') : 'Не назначено')}
    </p>
  </form>
}
