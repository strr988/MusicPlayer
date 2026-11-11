import { writeFile } from 'node:fs/promises'
import { check, hasFields, mean, methods, readJson } from './recommendation-research.mjs'

const [input, output, ...extra] = process.argv.slice(2)
check(input && output && !extra.length, 'Usage: node scripts/plot-pilot-results.mjs pilot-report.json new-chart.svg')
const report = await readJson(input)
const study = report?.userExperiment
check(report?.schemaVersion === 2 && report.kind === 'pilot-report' && Array.isArray(study?.ratings),
  'Expected an exported pilot report with participant ratings')
const labels = { random: 'Random', preferences: 'Preference Baseline', wave: 'Personal Wave' }
const rows = study.ratings.map(row => {
  check(hasFields(row, methods), 'Invalid methods in participant record')
  return Object.fromEntries(methods.map(method => {
    check(Array.isArray(row[method]), 'Invalid method ratings')
    const values = row[method].filter(answer => answer?.status === 'rated').map(answer => answer.rating)
    check(values.every(value => Number.isInteger(value) && value >= 1 && value <= 5), 'Invalid rating in report')
    return [method, values]
  }))
})
const count = rows.filter(row => methods.some(method => row[method].length)).length
check(count > 0 && study.participants === count, 'Invalid sample size')

const x = (value, min, max) => 240 + (value - min) / (max - min) * 460
function axis(y, values) {
  return '<path d="M240 ' + y + 'H700" stroke="#9ca3af"/>' + values.map(value =>
    '<text x="' + x(value, values[0], values.at(-1)) + '" y="' + (y + 20) + '" text-anchor="middle">' + value + '</text>').join('')
}
function row(label, y, values, min, max, rated = null) {
  const hits = new Map()
  const dots = values.map(value => {
    const position = x(value, min, max).toFixed(1)
    const hit = hits.get(position) ?? 0
    hits.set(position, hit + 1)
    const offset = (hit % 7 - 3) * 3
    return '<circle cx="' + position + '" cy="' + (y + offset) + '" r="4" fill="#2563eb" opacity=".5"/>'
  }).join('')
  const average = mean(values)
  const marker = average === null ? '' : '<circle cx="' + x(average, min, max) + '" cy="' + y +
    '" r="6" fill="none" stroke="#101827" stroke-width="2"/>'
  return '<text x="24" y="' + (y - 5) + '">' + label + '</text><text x="24" y="' + (y + 14) +
    '" fill="#4b5563">n=' + values.length + (rated === null ? '' : ', оценок=' + rated) + '</text>' + dots + marker
}

const ratings = methods.map((method, index) => {
  const scores = rows.map(item => mean(item[method])).filter(value => value !== null)
  return row(labels[method], 132 + index * 45, scores, 1, 5, rows.flatMap(item => item[method]).length)
}).join('')
const differences = ['random', 'preferences'].map((method, index) => {
  const paired = rows.filter(item => item.wave.length && item[method].length)
    .map(item => mean(item.wave) - mean(item[method]))
  return row('Wave − ' + labels[method], 356 + index * 45, paired, -4, 4)
}).join('')
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="740" height="505" viewBox="0 0 740 505" role="img" aria-labelledby="title">' +
  '<rect width="740" height="505" fill="white"/><g font-family="Arial,sans-serif" font-size="14" fill="#101827">' +
  '<text id="title" x="24" y="34" font-size="23" font-weight="bold">Слепой пилот · участников с оценками ' + count + '</text>' +
  '<text x="24" y="66">Точка — среднее участника. Кольцо — среднее по участникам.</text>' +
  '<text x="24" y="103" font-weight="bold">Соответствие вкусу · шкала 1–5</text>' + ratings + axis(246, [1, 2, 3, 4, 5]) +
  '<text x="24" y="323" font-weight="bold">Парные разницы оценок · только участники с обеими оценками</text>' +
  differences + axis(434, [-4, -2, 0, 2, 4]) +
  '<text x="24" y="482">Описательные результаты. Точки могут накладываться.</text></g></svg>\n'
await writeFile(output, svg, { flag: 'wx' })
