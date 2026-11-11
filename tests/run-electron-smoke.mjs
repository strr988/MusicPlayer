import { mkdirSync, writeSync } from 'node:fs'
import { app } from 'electron'
import { verify } from './electron-smoke.mjs'
import '../out/main/index.js'

const [folder, profile, phase] = process.argv.slice(2)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

void verify(folder, profile, phase).then(() => {
  if (phase === 'downloads-recovery-commit') {
    writeSync(1, 'download import committed\n')
    process.kill(process.pid, 'SIGKILL')
  } else app.quit()
}, (error) => {
  console.error(error)
  app.exit(1)
})
