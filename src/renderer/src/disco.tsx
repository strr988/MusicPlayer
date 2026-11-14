import { useEffect, useEffectEvent, useState } from 'react'
import type { Ref } from 'react'
import type { AudioEffects } from './audio-effects'

export function DiscoLayer({ ref }: { ref: Ref<HTMLDivElement> }) {
  return <div className="disco-layer" ref={ref} aria-hidden="true"><i /><i /><i /></div>
}

export function paintDisco(layer: HTMLDivElement | null, strength: number): void {
  if (!layer) return
  layer.style.setProperty('--disco-strength', strength.toFixed(3))
  layer.toggleAttribute('data-moving', strength > 0)
}

function bandLevel(spectrum: Float32Array, binHz: number, low: number, high: number): number {
  const start = Math.max(1, Math.ceil(low / binHz))
  const end = Math.min(spectrum.length, Math.ceil(high / binHz))
  let peak = -Infinity
  for (let bin = start; bin < end; bin++) peak = Math.max(peak, spectrum[bin])
  return Math.max(0, Math.min(1, (peak + 72) / 49))
}

export function useDiscoMode(effects: { readonly current: AudioEffects | null }, active: boolean,
  onLevel: (strength: number) => void) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void window.mustplay.getDiscoMode().then(value => { if (live) setEnabled(value) }).catch(() => {
      if (live) setError('Не удалось загрузить диско-режим.')
    })
    return () => { live = false }
  }, [])
  async function change(next: boolean) {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      await window.mustplay.setDiscoMode(next)
      setEnabled(next)
    } catch {
      setError('Не удалось сохранить диско-режим.')
    } finally {
      setSaving(false)
    }
  }

  const showLevel = useEffectEvent(onLevel)
  useEffect(() => {
    const analyser = effects.current?.analyser
    if (!enabled || !active || !analyser) return
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const spectrum = new Float32Array(analyser.frequencyBinCount)
    const binHz = analyser.context.sampleRate / analyser.fftSize
    let bassAverage = 0
    let accent = 0
    let envelope = 0
    let lastPaint = -Infinity
    const reset = () => {
      bassAverage = accent = envelope = 0
      showLevel(0)
    }
    motion.addEventListener('change', reset)
    const timer = window.setInterval(() => {
      if (motion.matches) return
      const now = performance.now()
      analyser.getFloatFrequencyData(spectrum)
      const bass = bandLevel(spectrum, binHz, 35, 190)
      const presence = bandLevel(spectrum, binHz, 190, 2800)
      accent = Math.max(accent * 0.9, Math.max(0, bass - bassAverage - 0.06))
      bassAverage += (bass - bassAverage) * 0.1
      const target = Math.min(1, bass * 0.47 + presence * 0.26 + accent * 0.72)
      envelope += (target - envelope) * (target > envelope ? 0.42 : 0.13)
      if (now - lastPaint >= 115) {
        lastPaint = now
        showLevel(envelope < 0.015 ? 0 : envelope)
      }
    }, 30)
    return () => {
      clearInterval(timer)
      motion.removeEventListener('change', reset)
      reset()
    }
  }, [effects, enabled, active])

  return { enabled, saving, error, change }
}
