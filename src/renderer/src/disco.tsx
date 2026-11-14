import { useEffect, useEffectEvent, useState } from 'react'
import type { Ref } from 'react'
import type { AudioEffects } from './audio-effects'

export function DiscoLayer({ ref }: { ref: Ref<HTMLDivElement> }) {
  return <div className="disco-layer" ref={ref} aria-hidden="true"><i /><i /><i /></div>
}

export function pulseDisco(layer: HTMLDivElement | null, strength: number): void {
  if (!layer || !strength || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  for (const [index, wave] of Array.from(layer.children).entries()) {
    wave.getAnimations().forEach(animation => animation.cancel())
    wave.animate([
      { opacity: 0, transform: 'scale(.65)' },
      { opacity: strength * (index === 1 ? 0.45 : 0.62), offset: 0.24 },
      { opacity: 0, transform: 'scale(1.65)' },
    ], { duration: 780 + index * 110, easing: 'cubic-bezier(.15,.55,.3,1)' })
  }
}

export function useDiscoMode(effects: { readonly current: AudioEffects | null }, active: boolean,
  onBeat: (strength: number) => void) {
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

  const beat = useEffectEvent(onBeat)
  useEffect(() => {
    const analyser = effects.current?.analyser
    if (!enabled || !active || !analyser) return
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const spectrum = new Float32Array(analyser.frequencyBinCount)
    const binHz = analyser.context.sampleRate / analyser.fftSize
    const start = Math.max(1, Math.ceil(35 / binHz))
    const end = Math.floor(175 / binHz)
    let average = 0
    let previous = 0
    let lastBeat = -Infinity
    let previousSample = performance.now()
    const timer = window.setInterval(() => {
      if (motion.matches) return
      const now = performance.now()
      analyser.getFloatFrequencyData(spectrum)
      let energy = 0
      for (let bin = start; bin <= end; bin++) energy = Math.max(energy, Math.min(1, 10 ** (spectrum[bin] / 35)))
      if (now - previousSample > 160) average = previous = 0
      previousSample = now
      if (now - lastBeat >= 230 && energy > Math.max(0.018, average * 1.35) && energy - previous > 0.009) {
        lastBeat = now
        beat(Math.min(1, 0.38 + energy * 2.8))
      }
      average += (energy - average) * 0.13
      previous = energy
    }, 32)
    return () => clearInterval(timer)
  }, [effects, enabled, active])

  return { enabled, saving, error, change }
}
