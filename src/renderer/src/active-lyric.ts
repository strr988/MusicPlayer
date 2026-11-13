import type { LyricLine } from '../../shared/contracts'

export function activeLyric(lines: LyricLine[], position: number): number {
  let start = 0
  let end = lines.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    if (lines[middle].seconds <= position) start = middle + 1
    else end = middle
  }
  return start - 1
}
