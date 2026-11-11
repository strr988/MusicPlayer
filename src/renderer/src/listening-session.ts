import type { PlaybackEventInput, PlaybackEventType } from '../../shared/contracts'

// Counts active wall time, never position jumps. Pause, buffering and seek suspend it.
export class ListeningSession {
  private started = false
  private finished = false
  private activeSince: number | null = null
  private seconds = 0

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
      this.seconds += Math.max(0, this.now() - this.activeSince) / 1000
      this.activeSince = null
    }
  }

  finish(reason: 'manual' | 'ended' | 'error', duration: number): void {
    if (this.finished) return
    this.suspend()
    this.finished = true
    if (!this.started && reason !== 'error') return
    const type = reason === 'manual' ? 'skipped' : reason === 'error' ? 'error' :
      Number.isFinite(duration) && duration > 0 && this.seconds >= duration * 0.9 ? 'completed' : 'ended'
    this.send(type)
  }

  private send(type: PlaybackEventType): void {
    this.emit({ trackId: this.trackId, sessionId: this.sessionId, type, listenedSeconds: this.seconds })
  }
}
