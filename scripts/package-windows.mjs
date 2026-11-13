import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

assert.equal(process.platform, 'win32', 'Build this package on Windows')
assert.equal(process.arch, 'x64', 'Build this package with x64 Node.js and Electron')
assert.ok(process.env.npm_execpath, 'Run pnpm package:windows')
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const { name, productName, version, type, main } = manifest
const electronDir = dirname(electron)
const electronVersion = (await readFile(join(electronDir, 'version'), 'utf8')).trim()
assert.equal(electronVersion, manifest.devDependencies.electron)
// Validate the actual PE machine type. Node and Electron can be installed independently.
const executable = await open(electron)
try {
  const offset = Buffer.alloc(4)
  await executable.read(offset, { position: 0x3c })
  const header = Buffer.alloc(6)
  await executable.read(header, { position: offset.readUInt32LE() })
  assert.equal(header.toString('ascii', 0, 4), 'PE\0\0')
  assert.equal(header.readUInt16LE(4), 0x8664, 'Expected x64 Electron')
} finally {
  await executable.close()
}

const release = join(root, 'release')
await mkdir(release, { recursive: true })
assert.ok(!(await lstat(release)).isSymbolicLink(), 'Expected a local release directory')
const releasePath = await realpath(release)
const staging = await mkdtemp(join(releasePath, '.windows-'))
const appFolder = `Music Player ${version}`
const zipName = `MusicPlayer-${version}-win-x64.zip`
const tar = join(process.env.SystemRoot, 'System32', 'tar.exe')

try {
  const packageDir = join(staging, appFolder)
  await cp(electronDir, packageDir, { recursive: true })
  await rename(join(packageDir, 'electron.exe'), join(packageDir, 'Music Player.exe'))
  await rename(join(packageDir, 'electron_wer.dll'), join(packageDir, 'Music Player_wer.dll'))
  await rm(join(packageDir, 'resources', 'default_app.asar'))
  const appDir = join(packageDir, 'resources', 'app')
  await mkdir(appDir)
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name, productName, version, type, main }, null, 2) + '\n')
  await cp(join(root, 'out'), join(appDir, 'out'), { recursive: true })

  const depsDir = join(staging, 'dependencies')
  await mkdir(depsDir)
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await cp(join(root, file), join(depsDir, file))
  }
  execFileSync(process.execPath, [process.env.npm_execpath, '--dir', depsDir, 'install',
    '--prod', '--offline', '--frozen-lockfile', '--ignore-scripts',
    '--config.node-linker=hoisted', '--store-dir', join(root, '.pnpm-store')], { stdio: 'inherit' })
  const modules = join(appDir, 'node_modules')
  await mkdir(modules)
  for (const item of await readdir(join(depsDir, 'node_modules'), { withFileTypes: true })) {
    if (!item.name.startsWith('.')) {
      assert.ok(item.isDirectory(), `Expected a physical package directory: ${item.name}`)
      await cp(join(item.parentPath, item.name), join(modules, item.name), { recursive: true })
    }
  }
  await cp(join(root, 'docs', 'WINDOWS_RELEASE.md'), join(packageDir, 'DEMO.md'))
  await cp(join(root, 'docs', 'PLAYER_EXPERIENCE.md'), join(packageDir, 'PLAYER_EXPERIENCE.md'))

  const archive = join(staging, zipName)
  execFileSync(tar, ['-a', '-cf', archive, '-C', staging, appFolder], { stdio: 'inherit' })
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  const checksum = hash.digest('hex')
  await rename(archive, join(releasePath, zipName))
  await writeFile(join(releasePath, `${zipName}.sha256`), `${checksum}  ${zipName}\n`)
  console.log(`${join(releasePath, zipName)}\nSHA-256 ${checksum}`)
} finally {
  const actual = await realpath(staging)
  assert.equal(dirname(actual), releasePath)
  assert.ok(basename(actual).startsWith('.windows-'))
  await rm(actual, { recursive: true, force: true })
}
