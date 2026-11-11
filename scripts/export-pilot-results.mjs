import { writeFile } from 'node:fs/promises'
import { aggregateRuns, algorithmVersions, catalogSize, check, compareRun, hasFields, integer, mean, methods, metricsOnly, readJson } from './recommendation-research.mjs'
import { presentationOrder, validateKey } from './pilot-session.mjs'

function validateRatings(ratings, key) {
  check(hasFields(ratings, ['kind', 'schemaVersion', 'sessionId', 'blocks']) &&
    ratings.kind === 'pilot-ratings' && ratings.schemaVersion === 2 && ratings.sessionId === key.sessionId &&
    Array.isArray(ratings.blocks) && ratings.blocks.length === 3, 'Invalid ratings document or mismatched session')
  return ratings.blocks.map(block => {
    check(Array.isArray(block) && block.length === key.count, 'Incorrect number of positions in a block')
    return block.map(answer => {
      if (hasFields(answer, ['status']) && ['missing', 'audio-error'].includes(answer.status)) {
        return { status: answer.status }
      }
      check(hasFields(answer, ['status', 'rating', 'familiarity']) && answer.status === 'rated' &&
        integer(answer.rating, 1, 5) && [null, 'yes', 'no'].includes(answer.familiarity), 'Invalid rating or missing-data code')
      return { status: 'rated', rating: answer.rating, familiarity: answer.familiarity }
    })
  })
}

const score = answers => mean(answers.filter(answer => answer.status === 'rated').map(answer => answer.rating))
const [output, ...files] = process.argv.slice(2)
check(output && files.length > 0 && files.length % 2 === 0,
  'Usage: node scripts/export-pilot-results.mjs <new-report.json|--check> <key.json> <ratings.json> [...]')

const ids = new Set()
const slots = new Set()
const evaluations = []
const technical = []
let parameters
for (let index = 0; index < files.length; index += 2) {
  const key = validateKey(await readJson(files[index]))
  const blocks = validateRatings(await readJson(files[index + 1]), key)
  check(!ids.has(key.sessionId) && !slots.has(key.slot), 'Duplicate session or presentation slot')
  ids.add(key.sessionId)
  slots.add(key.slot)
  const current = { count: key.count, mode: key.snapshot.mode, excerptSeconds: key.excerptSeconds }
  parameters ??= current
  check(JSON.stringify(parameters) === JSON.stringify(current), 'Inconsistent pilot conditions')
  const order = presentationOrder(key.slot)
  evaluations.push(Object.fromEntries(order.map((method, position) => [method, blocks[position]])))
  if (output !== '--check') {
    technical.push({
      seed: key.snapshot.seed, now: key.snapshot.now, catalog: catalogSize(key.snapshot), order,
      methods: metricsOnly(compareRun(key.snapshot, key.count)),
    })
  }
}

const summaries = Object.fromEntries(methods.map(method => {
  const blocks = evaluations.map(row => row[method])
  const answers = blocks.flat()
  return [method, {
    participantsWithRatings: blocks.filter(block => score(block) !== null).length,
    meanRating: mean(blocks.map(score).filter(value => value !== null)),
    rated: answers.filter(answer => answer.status === 'rated').length,
    missing: answers.filter(answer => answer.status === 'missing').length,
    audioErrors: answers.filter(answer => answer.status === 'audio-error').length,
    familiarityMissing: answers.filter(answer => answer.status === 'rated' && answer.familiarity === null).length,
  }]
}))
const evaluated = evaluations.filter(row => methods.some(method => score(row[method]) !== null)).length
if (output === '--check') {
  console.log(JSON.stringify({ validSessions: evaluations.length, sessionsWithRatings: evaluated, methods: summaries }, null, 2))
} else {
  const report = {
    schemaVersion: 2,
    kind: evaluated ? 'pilot-report' : 'algorithm-benchmark',
    algorithmVersions,
    parameters: { ...parameters, timingSamples: 100, warmup: 20 },
    technical: { sessions: technical, aggregate: aggregateRuns(technical.map(session => session.methods)) },
    userExperiment: 'no-user-ratings',
  }
  if (evaluated) {
    report.userExperiment = {
      participants: evaluated,
      submittedSessions: evaluations.length,
      incompleteSessions: evaluations.filter(row => methods.some(method => row[method].some(answer => answer.status !== 'rated'))).length,
      ratedRecommendations: Object.values(summaries).reduce((sum, method) => sum + method.rated, 0),
      methods: summaries,
      ratings: evaluations,
      paired: Object.fromEntries(['random', 'preferences'].map(method => {
        const differences = evaluations.flatMap(row => {
          const wave = score(row.wave)
          const other = score(row[method])
          return wave === null || other === null ? [] : [wave - other]
        })
        return [method, { participants: differences.length, mean: mean(differences), differences }]
      })),
    }
  } else {
    report.submittedSessions = evaluations.length
    report.missingData = summaries
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
}
