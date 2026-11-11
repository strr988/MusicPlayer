import { expect, it } from 'vitest'
import type { Track } from '../src/shared/contracts'
import { visibleTracks } from '../src/renderer/src/library-view'

const base: Track = { id: '1', title: 'Ночнои\u0306 поезд', artist: 'North', album: 'Белый шум',
  durationSeconds: 200, genres: [], format: 'flac' }
const tracks: Track[] = [
  base,
  { ...base, id: '2', title: 'Трек 10', artist: 'NORTH', album: null, durationSeconds: 10 },
  { ...base, id: '3', title: 'Трек 2', artist: 'North', album: 'Белый шум', durationSeconds: 10 },
  { ...base, id: '4', title: 'Без тегов', artist: null, album: null, durationSeconds: null },
]
const ids = (matches: Track[]) => matches.map(track => track.id)

it.each([
  [' НОЧНОЙ ', ['1']],
  ['noRTh', ['1', '2', '3']],
  ['БЕЛЫЙ', ['1', '3']],
  ['БЕЗ ТЕГОВ', ['4']],
  ['—', []],
  ['\t', ['1', '2', '3', '4']],
])('searches normalized title, artist and album for %s', (query, expected) => {
  expect(ids(visibleTracks(tracks, query, '', 'asc'))).toEqual(expected)
})

it('combines search and sort, preserves ties and leaves missing values last in either direction', () => {
  expect(ids(visibleTracks(tracks, 'тРеК', 'title', 'asc'))).toEqual(['3', '2'])
  expect(ids(visibleTracks(tracks, 'тРеК', 'title', 'desc'))).toEqual(['2', '3'])
  expect(ids(visibleTracks(tracks, 'north', 'durationSeconds', 'asc'))).toEqual(['2', '3', '1'])
  expect(ids(visibleTracks(tracks, '', 'durationSeconds', 'desc'))).toEqual(['1', '2', '3', '4'])
  expect(ids(visibleTracks(tracks, '', 'artist', 'desc'))).toEqual(['1', '2', '3', '4'])
  expect(ids(visibleTracks(tracks, '', 'album', 'asc'))).toEqual(['1', '3', '2', '4'])
  expect(ids(visibleTracks(tracks, '', 'album', 'desc'))).toEqual(['1', '3', '2', '4'])
  expect(ids(tracks)).toEqual(['1', '2', '3', '4'])
})
