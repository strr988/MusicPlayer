import { useEffect, useRef } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { Icon } from './icons'

type CapturableAudio = HTMLAudioElement & { captureStream?: () => MediaStream }

export function WavePulse({ audio, playing, intensity }: {
  audio: RefObject<HTMLAudioElement | null>
  playing: boolean
  intensity: number
}) {
  const artwork = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element: CapturableAudio | null = audio.current
    const target = artwork.current
    if (!playing || !element?.captureStream || !target) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let dispose = () => {}

    function update() {
      dispose()
      dispose = () => {}
      if (reducedMotion.matches || !element || !target) return
      const stream = element.captureStream?.()
      if (!stream) return
      const context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.55
      analyser.minDecibels = -78
      analyser.maxDecibels = -22
      const frequency = new Uint8Array(analyser.frequencyBinCount)
      const signal = new Float32Array(analyser.fftSize)
      const bassBins = Math.max(1, Math.floor(180 * analyser.fftSize / context.sampleRate))
      let frame = 0
      let level = 0
      let echo = 0
      let source: MediaStreamAudioSourceNode | undefined
      let disposed = false

      dispose = () => {
        disposed = true
        cancelAnimationFrame(frame)
        stream.removeEventListener('addtrack', connect)
        source?.disconnect()
        for (const track of stream.getTracks()) track.stop()
        target.style.removeProperty('--wave-level')
        target.style.removeProperty('--wave-echo')
        void context.close().catch(() => {})
      }

      function draw() {
        if (disposed || !target || !element) return
        let energy = 0
        if (context.state === 'running' && !element.muted && element.volume > 0) {
          analyser.getByteFrequencyData(frequency)
          analyser.getFloatTimeDomainData(signal)
          let squares = 0
          for (const sample of signal) squares += sample * sample
          let bass = 0
          for (let index = 1; index <= bassBins; index++) bass = Math.max(bass, frequency[index])
          const loudness = Math.sqrt(squares / signal.length)
          energy = Math.min(1, loudness * 1.6 + bass / 400) * Math.sqrt(element.volume)
        }
        level += (energy - level) * (energy > level ? 0.44 : 0.13)
        echo += (level - echo) * 0.16
        target.style.setProperty('--wave-level', level.toFixed(3))
        target.style.setProperty('--wave-echo', echo.toFixed(3))
        frame = requestAnimationFrame(draw)
      }

      function connect() {
        if (disposed || source || !stream?.getAudioTracks().length) return
        source = context.createMediaStreamSource(stream)
        source.connect(analyser)
        // Capture is for analysis only. The audio element still controls the original output.
        void context.resume().catch(() => {})
        frame = requestAnimationFrame(draw)
      }

      stream.addEventListener('addtrack', connect)
      connect()
    }

    function refresh() {
      try { update() } catch { dispose() }
    }

    refresh()
    reducedMotion.addEventListener('change', refresh)
    return () => {
      reducedMotion.removeEventListener('change', refresh)
      dispose()
    }
  }, [audio, playing])

  return <div ref={artwork} className="wave-art" aria-hidden="true"
    style={{ '--wave-intensity': intensity / 100 } as CSSProperties}><Icon name="wave" /></div>
}
