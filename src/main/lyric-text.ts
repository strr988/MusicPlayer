import type { LyricLine, Lyrics } from '../shared/contracts'

export const lyricSizeLimit = 256 * 1024
export const lyricLineLimit = 2_000
const timestamp = /^\[(\d{1,4}):([0-5]\d)(?:[.:](\d{1,3}))?\]\s*/
const metadata = /^\[[a-z][a-z0-9_-]*:.*\]\s*$/i

export function cleanText(text: string): string | null {
  if (text.length > lyricSizeLimit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/.test(text)) return null
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim() || null
}

export function plainLyrics(raw: string): Lyrics | null {
  const text = cleanText(raw)
  return text ? { kind: 'plain', text } : null
}

export function timedLyrics(lines: LyricLine[], offsetMs = 0): Lyrics | null {
  if (lines.length > lyricLineLimit || !lines.some(line => line.text) ||
      lines.reduce((size, line) => size + line.text.length, 0) > lyricSizeLimit) return null
  // An empty timestamp ends the previous line during an instrumental break.
  const cues = lines.map(line => ({ ...line, seconds: Math.max(0, (Math.round(line.seconds * 1000) - offsetMs) / 1000) }))
    .sort((a, b) => a.seconds - b.seconds)
  return { kind: 'timed', lines: cues }
}

export function parseLrc(raw: string): Lyrics | null {
  const text = cleanText(raw)
  if (!text) return null
  const lines: LyricLine[] = []
  const untimed: string[] = []
  let offsetMs = 0
  for (const row of text.split('\n')) {
    const offset = /^\[offset:\s*([+-]?\d{1,9})\s*\]$/i.exec(row.trim())
    if (offset) {
      offsetMs = Number(offset[1])
      continue
    }
    let line = row.trimStart()
    const times: number[] = []
    for (let match = timestamp.exec(line); match; match = timestamp.exec(line)) {
      times.push(Number(match[1]) * 60 + Number(match[2]) + Number('0.' + (match[3] ?? '0')))
      if (lines.length + times.length > lyricLineLimit) return null
      line = line.slice(match[0].length)
    }
    if (times.length) {
      const words = line.replace(/<\d{1,4}:[0-5]\d(?:[.:]\d{1,3})?>/g, '').trim()
      for (const seconds of times) lines.push({ seconds, text: words })
    } else if (!metadata.test(line) && !/^\s*\[\s*\d+[:\]]/.test(line)) {
      untimed.push(row)
    }
  }
  return timedLyrics(lines, offsetMs) ?? plainLyrics(untimed.join('\n'))
}
