import { check, readJson } from './recommendation-research.mjs'
import { prepareSession } from './pilot-session.mjs'

const [snapshotPath, manifestPath, output, slot, count = '8', excerpt = '30', ...extra] = process.argv.slice(2)
check(snapshotPath && manifestPath && output && slot && !extra.length,
  'Usage: node scripts/prepare-pilot.mjs snapshot.json audio-map.json new-session-dir slot [count] [excerpt-seconds]')
await prepareSession({
  snapshot: await readJson(snapshotPath), manifestPath, output, slot: Number(slot), count: Number(count), excerptSeconds: Number(excerpt),
})
