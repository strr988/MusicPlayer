export interface AudioEffects {
  context: AudioContext
  analyser: AnalyserNode
  setReverb(enabled: boolean): void
  setMuted(muted: boolean): void
  resetReverb(): void
}

function roomImpulse(context: BaseAudioContext): AudioBuffer {
  const length = Math.round(context.sampleRate * 1.35)
  const impulse = context.createBuffer(2, length, context.sampleRate)
  const delay = Math.round(context.sampleRate * 0.024)
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const samples = impulse.getChannelData(channel)
    let seed = 391 + channel * 1297
    let noise = 0
    for (let frame = delay; frame < length; frame++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      noise = noise * 0.54 + (seed / 2147483648 - 1) * 0.46
      samples[frame] = noise * (1 - frame / length) ** 3.2
    }
  }
  return impulse
}

export function createAudioEffects(element: HTMLAudioElement): AudioEffects {
  // The element still owns transport and volume. Its decoded output enters this graph once.
  const context = new AudioContext()
  const dry = context.createGain()
  const wet = context.createGain()
  const output = context.createGain()
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.38
  analyser.minDecibels = -85
  analyser.maxDecibels = -24
  wet.gain.value = 0
  const source = context.createMediaElementSource(element)
  source.connect(dry).connect(output).connect(context.destination)
  source.connect(analyser)
  wet.connect(output)

  let impulse: AudioBuffer | undefined
  let room: ConvolverNode | undefined
  let enabled = false

  function resetReverb() {
    if (room) {
      source.disconnect(room)
      room.disconnect()
      room = undefined
    }
    if (!enabled) return
    impulse ??= roomImpulse(context)
    room = context.createConvolver()
    room.buffer = impulse
    source.connect(room).connect(wet)
  }

  return {
    context, analyser, resetReverb,
    setMuted(muted) { output.gain.value = muted ? 0 : 1 },
    setReverb(next) {
      if (next === enabled) return
      enabled = next
      if (next && !room) resetReverb()
      for (const [parameter, value] of [[dry.gain, next ? 0.84 : 1], [wet.gain, next ? 0.32 : 0]] as const) {
        parameter.cancelScheduledValues(context.currentTime)
        parameter.setTargetAtTime(value, context.currentTime, 0.025)
      }
      if (!next && room) {
        // Let the wet gain fade before removing the convolution branch.
        const current = room
        setTimeout(() => { if (!enabled && room === current) resetReverb() }, 150)
      }
    },
  }
}
