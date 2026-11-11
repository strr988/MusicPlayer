import type { Track } from '../../shared/contracts'

export const sortFields = {
  title: 'Название',
  artist: 'Исполнитель',
  album: 'Альбом',
  durationSeconds: 'Длительность',
} as const

export type SortField = keyof typeof sortFields
export type SortDirection = 'asc' | 'desc'

const textOrder = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase().normalize('NFC')
}

export function visibleTracks<T extends Track>(
  tracks: T[], query: string, field: SortField | '', direction: SortDirection,
): T[] {
  const needle = normalize(query.trim())
  const matches = needle ? tracks.filter(track =>
    [track.title, track.artist, track.album].some(text => text != null && normalize(text).includes(needle)),
  ) : tracks
  if (!field) return matches

  return matches.toSorted((first, second) => {
    const a = first[field]
    const b = second[field]
    if (a === null || a === '') return b === null || b === '' ? 0 : 1
    if (b === null || b === '') return -1
    const order = typeof a === 'number' && typeof b === 'number' ? a - b : textOrder.compare(String(a), String(b))
    return direction === 'asc' ? order : -order
  })
}
