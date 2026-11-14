import type { PlaybackEventInput, PlaybackEventType } from '../../shared/contracts'

// Counts active wall time, never position jumps. Pause, buffering and seek suspend it.
export class ListeningSession {
  private started = false
  private finished = false
  private activeSince: number | null = null
  private seconds = 0
  private trackSeconds = 0
  private rate = 1

  constructor(readonly trackId: string, readonly sessionId: string,
    private readonly emit: (event: PlaybackEventInput) => void,
    private readonly now = () => performance.now()) {}

  playing(): void {
    if (this.finished) return
    if (!this.started) {
      this.started = true
      this.send('started')
    }
    this.activeSince ??= this.now()
  }

  resume(): void {
    if (this.started && !this.finished) this.activeSince ??= this.now()
  }

  suspend(): void {
    if (this.activeSince !== null) {
      const elapsed = Math.max(0, this.now() - this.activeSince) / 1000
      this.seconds += elapsed
      this.trackSeconds += elapsed * this.rate
      this.activeSince = null
    }
  }

  setRate(rate: number): void {
    if (rate === this.rate) return
    const active = this.activeSince !== null
    this.suspend()
    this.rate = rate
    if (active) this.resume()
  }

  finish(reason: 'manual' | 'ended' | 'error', duration: number): void {
    if (this.finished) return
    this.suspend()
    this.finished = true
    if (!this.started && reason !== 'error') return
    const type = reason === 'manual' ? 'skipped' : reason === 'error' ? 'error' :
      Number.isFinite(duration) && duration > 0 && this.trackSeconds >= duration * 0.9 ? 'completed' : 'ended'
    this.send(type)
  }

  private send(type: PlaybackEventType): void {
    this.emit({ trackId: this.trackId, sessionId: this.sessionId, type, listenedSeconds: this.seconds })
  }
}
