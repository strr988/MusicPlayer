export const longTitle = 'Последний поезд через город, где фонари гаснут только на рассвете — расширенная студийная версия'
export const catalogSize = 36

const titles = [
  longTitle, 'Полярная ночь', 'Километр тишины', 'Glass Harbor', 'Свет в окнах', 'Над линией воды',
  'Пустой перрон', 'Drift Signal', 'Северный ветер', 'Шум дождя', 'До первого трамвая', 'Orbit Sketch',
  'Письма издалека', 'Через пролив', 'Тихие улицы', 'Снова дома',
]
const artists = ['Лаборатория городского звука и поздних железнодорожных маршрутов', 'Орбита', 'Маяк', 'Low Current']
const albums = ['Северная линия — полное издание с полевыми записями и студийными сессиями', 'После полуночи', 'Переходы', 'Tidal Archive']

export function fixtureMetadata(index) {
  return {
    title: titles[index] ?? 'Полевая запись · ' + (index + 1),
    artist: artists[index % artists.length],
    album: albums[index % albums.length],
  }
}
