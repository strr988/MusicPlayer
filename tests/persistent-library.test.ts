import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Library } from '../src/main/library'

const mp3 = new URL('./fixtures/01-tone.mp3', import.meta.url)
const flac = new URL('./fixtures/02-tone.flac', import.meta.url)
let temp: string
let folder: string
let databasePath: string
let library: Library | undefined

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'music-player-sqlite-'))
  folder = join(temp, 'music')
  await mkdir(folder)
  databasePath = join(temp, 'library.sqlite3')
})

afterEach(async () => {
  library?.close()
  library = undefined
  await rm(temp, { recursive: true, force: true })
})

function openLibrary(): Library {
  library?.close()
  library = undefined
  library = new Library(databasePath)
  return library
}

it('persists tracks, source IDs and canonical folders across reopening and overlapping imports', async () => {
  const nested = join(folder, 'nested')
  await mkdir(nested)
  await copyFile(mp3, join(nested, 'tone.mp3'))
  await copyFile(flac, join(folder, 'tone.flac'))
  const first = openLibrary()
  const imported = await first.importFolder(folder)
  const sourceIds = imported.tracks.map(({ id }) => first.getSourceId(id))
  const reopened = openLibrary()
  await reopened.refreshAvailability()
  expect(reopened.getTracks()).toEqual(imported.tracks)
  const results = await Promise.all([reopened.importFolder(nested), reopened.importFolder(folder)])
  for (const result of results) expect(result.tracks).toEqual(imported.tracks)
  expect(reopened.getTracks().map(({ id }) => reopened.getSourceId(id))).toEqual(sourceIds)

  using db = new DatabaseSync(databasePath, { readOnly: true })
  expect(db.prepare('SELECT COUNT(*) AS count FROM imported_folders').get()).toEqual({ count: 2 })
  expect(db.prepare('SELECT COUNT(*) AS count FROM sources WHERE available = 1').get()).toEqual({ count: 2 })
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
})

it('retains the track when moving a file on the same volume and revokes the old media ID', async () => {
  const from = join(folder, 'tone.mp3')
  const destination = join(temp, 'new-folder')
  const to = join(destination, 'renamed.mp3')
  await mkdir(destination)
  await copyFile(mp3, from)
  const first = openLibrary()
  const imported = await first.importFolder(folder)
  const id = imported.tracks[0].id
  const oldSource = first.getSourceId(id)!
  await rename(from, to)

  const reopened = openLibrary()
  await reopened.refreshAvailability()
  expect(await reopened.getAvailableSource(oldSource)).toBeUndefined()
  expect((await reopened.importFolder(destination)).tracks).toEqual(imported.tracks)
  const newSource = reopened.getSourceId(id)!
  expect(newSource).not.toBe(oldSource)
  expect(await reopened.getAvailableSource(newSource)).toMatchObject({ path: await realpath(to) })
  expect(await reopened.getAvailableSource(oldSource)).toBeUndefined()
  expect(await readFile(to)).toEqual(await readFile(mp3))

  const upperCase = join(destination, 'RENAMED.mp3')
  await rename(to, upperCase)
  expect((await reopened.importFolder(destination)).tracks).toEqual(imported.tracks)
  expect(await reopened.getAvailableSource(reopened.getSourceId(id)!)).toMatchObject({ path: await realpath(upperCase) })

  await copyFile(upperCase, join(destination, 'copy.mp3'))
  const withCopy = await reopened.importFolder(destination)
  expect(withCopy.tracks).toHaveLength(2)
  expect(withCopy.tracks[0].id).toBe(id)
})

it('persists missing and changed-file availability and restores a track on successful reimport', async () => {
  const mp3Path = join(folder, 'tone.mp3')
  const flacPath = join(folder, 'tone.flac')
  await copyFile(mp3, mp3Path)
  await copyFile(flac, flacPath)
  const first = openLibrary()
  const { tracks } = await first.importFolder(folder)
  const mp3Id = tracks.find(({ format }) => format === 'mp3')!.id
  const oldSource = first.getSourceId(mp3Id)!
  await rm(flacPath)
  await writeFile(mp3Path, 'corrupt')

  const reopened = openLibrary()
  await reopened.refreshAvailability()
  expect(reopened.getTracks()).toEqual(tracks)
  expect(await reopened.getAvailableSource(oldSource)).toBeUndefined()
  expect((await reopened.importFolder(folder)).issues).toEqual([{ entry: 'tone.mp3', reason: 'file-unreadable' }])

  using db = new DatabaseSync(databasePath, { readOnly: true })
  expect(db.prepare('SELECT available FROM sources ORDER BY available').all()).toEqual([{ available: 0 }, { available: 0 }])
  const audio = await readFile(mp3)
  const title = audio.indexOf('Test Tone MP3')
  expect(title).toBeGreaterThanOrEqual(0)
  audio.write('Edit Tone MP3', title)
  await writeFile(mp3Path, audio)
  const updated = await reopened.importFolder(folder)
  expect(updated.tracks).toHaveLength(2)
  expect(updated.tracks).toContainEqual(expect.objectContaining({ id: mp3Id, title: 'Edit Tone MP3' }))
  expect(reopened.getSourceId(mp3Id)).not.toBe(oldSource)
  expect(await reopened.getAvailableSource(reopened.getSourceId(mp3Id)!)).toBeDefined()
  expect(await reopened.getAvailableSource(oldSource)).toBeUndefined()
})

it('rolls back a failed migration and refuses a newer schema without overwriting its data', () => {
  using db = new DatabaseSync(databasePath)
  db.exec("CREATE TABLE sources (value TEXT); INSERT INTO sources VALUES ('keep me');")
  expect(() => openLibrary()).toThrow(/sources already exists/)
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([{ name: 'sources' }])
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })

  db.exec('PRAGMA user_version = 99')
  expect(() => openLibrary()).toThrow(/Unsupported library schema 99/)
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 99 })
  expect(db.prepare('SELECT value FROM sources').get()).toEqual({ value: 'keep me' })
})

it('rolls back the whole scan on a database error and permits retry', async () => {
  await copyFile(mp3, join(folder, 'tone.mp3'))
  const current = openLibrary()
  using db = new DatabaseSync(databasePath)
  db.exec(`CREATE TRIGGER fail_source BEFORE INSERT ON sources BEGIN
    SELECT RAISE(ABORT, 'test failure'); END`)
  await expect(current.importFolder(folder)).rejects.toThrow(/test failure/)
  expect(current.getTracks()).toEqual([])
  expect(db.prepare('SELECT * FROM imported_folders').all()).toEqual([])
  expect(db.prepare('SELECT * FROM sources').all()).toEqual([])

  db.exec('DROP TRIGGER fail_source')
  expect((await current.importFolder(folder)).tracks).toHaveLength(1)
})

