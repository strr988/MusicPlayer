import { mkdirSync } from 'node:fs'
import { app } from 'electron'
import { verify } from './electron-smoke.mjs'
import '../out/main/index.js'

const [folder, profile, phase] = process.argv.slice(2)
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)

void verify(folder, profile, phase).then(() => app.quit(), (error) => {
  console.error(error)
  app.exit(1)
})
