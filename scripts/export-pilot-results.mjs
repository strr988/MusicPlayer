import { readFile, writeFile } from 'node:fs/promises'

const [input, output, ...extra] = process.argv.slice(2)
if (!input || !output || extra.length) {
  throw new Error('Usage: node scripts/export-pilot-results.mjs <pilot-input.json> <new-aggregate.json>')
}

const methods = ['A', 'B', 'C']
const participants = JSON.parse(await readFile(input, 'utf8'))
if (!Array.isArray(participants) || participants.length === 0) {
  throw new Error('Expected a nonempty array of completed participant records')
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const codes = new Set()
const positions = participants[0]?.A?.length
if (!Number.isSafeInteger(positions) || positions < 1) throw new Error('Expected a positive queue length')

const summaries = participants.map((record, index) => {
  const row = index + 1
  const code = typeof record?.code === 'string' ? record.code.trim() : ''
  if (!code || codes.has(code)) throw new Error(`Missing or duplicate participant code in record ${row}`)
  codes.add(code)
  return Object.fromEntries(methods.map(method => {
    const queue = record[method]
    if (!Array.isArray(queue) || queue.length !== positions) {
      throw new Error(`Expected ${positions} positions in record ${row}, method ${method}`)
    }
    const rated = queue.filter((item, index) => {
      if (item === null) return false
      if (!Number.isInteger(item?.rating) || item.rating < 1 || item.rating > 5 ||
          typeof item.skipped !== 'boolean' || typeof item.newLike !== 'boolean') {
        throw new Error(`Invalid outcome in record ${row}, method ${method}, position ${index + 1}`)
      }
      return true
    })
    if (rated.length === 0) throw new Error(`No rated positions in record ${row}, method ${method}`)
    return [method, {
      rating: mean(rated.map(item => item.rating)),
      skipRate: mean(rated.map(item => Number(item.skipped))),
      newLikeRate: mean(rated.map(item => Number(item.newLike))),
      rated: rated.length,
      excluded: queue.length - rated.length,
    }]
  }))
})

const aggregates = Object.fromEntries(methods.map(method => {
  const rows = summaries.map(summary => summary[method])
  return [method, {
    meanRating: mean(rows.map(row => row.rating)),
    meanSkipRate: mean(rows.map(row => row.skipRate)),
    meanNewLikeRate: mean(rows.map(row => row.newLikeRate)),
    rated: rows.reduce((sum, row) => sum + row.rated, 0),
    excluded: rows.reduce((sum, row) => sum + row.excluded, 0),
  }]
}))

const pairedRatingDifferences = Object.fromEntries(['A', 'B'].map(method => {
  const differences = summaries.map(summary => summary.C.rating - summary[method].rating)
  const average = mean(differences)
  const sumSquares = differences.reduce((sum, value) => sum + (value - average) ** 2, 0)
  return [`C-${method}`, {
    mean: average,
    sampleStandardDeviation: differences.length > 1 ? Math.sqrt(sumSquares / (differences.length - 1)) : null,
  }]
}))

await writeFile(output, JSON.stringify({
  schemaVersion: 1,
  kind: 'pilot-aggregates',
  participants: summaries.length,
  plannedPositionsPerMethod: positions,
  methods: aggregates,
  pairedRatingDifferences,
}, null, 2) + '\n', { flag: 'wx' })
