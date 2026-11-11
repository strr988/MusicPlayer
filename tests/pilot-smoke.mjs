import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

const [page, output, profile] = process.argv.slice(2)
app.setPath('userData', profile)

async function verify() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  const web = window.webContents
  const run = code => web.executeJavaScript(code, true)
  await window.loadFile(page)
  assert.equal(await run(`document.querySelector('#position').textContent`), 'Подборка 1 из 3 · Трек 1 из 1')
  const duration = await run(`(async () => {
    const audio = document.querySelector('audio')
    await audio.play()
    return audio.duration
  })()`)
  assert.ok(duration >= 4)
  const download = new Promise((resolve, reject) => {
    web.session.once('will-download', (_, item) => {
      item.setSavePath(output)
      once(item, 'done').then(([, state]) => {
        if (state === 'completed') resolve()
        else reject(new Error('Ratings download ' + state))
      }, reject)
    })
  })
  await run(`
    window.confirm = () => true
    document.querySelector('#rating').value = '4'
    document.querySelector('#next').click()
    document.querySelector('#rating').value = 'audio-error'
    document.querySelector('#next').click()
    document.querySelector('#save').click()
  `)
  await Promise.race([download, delay(5_000).then(() => { throw new Error('No ratings download was observed') })])
  const result = JSON.parse(await readFile(output, 'utf8'))
  assert.deepEqual(result.blocks, [[{ status: 'rated', rating: 4, familiarity: null }], [{ status: 'audio-error' }], [{ status: 'missing' }]])
  assert.deepEqual(Object.keys(result), ['kind', 'schemaVersion', 'sessionId', 'blocks'])
  await window.loadFile(page)
  await run(`window.confirm = () => true; document.querySelector('#exit').click()`)
  assert.equal(await run(`!!document.querySelector('audio, #rating, #save')`), false)
}

void verify().then(() => app.exit(0), error => {
  console.error(error)
  app.exit(1)
})
