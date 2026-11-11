import type { BigIntStats } from 'node:fs'

type IdentityField = 'dev' | 'ino' | 'birthtimeNs' | 'size' | 'mtimeNs' | 'ctimeNs'
export type FileIdentity = Pick<BigIntStats, IdentityField>

export function fileIdentity(stat: BigIntStats): FileIdentity {
  const { dev, ino, birthtimeNs, size, mtimeNs, ctimeNs } = stat
  return { dev, ino, birthtimeNs, size, mtimeNs, ctimeNs }
}

export function sameFile(before: FileIdentity, after: BigIntStats): boolean {
  return after.isFile() && sameIdentity(before, after)
}

export function sameIdentity(before: FileIdentity, after: FileIdentity): boolean {
  return before.dev === after.dev && before.ino === after.ino &&
    before.birthtimeNs === after.birthtimeNs && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

export function moveKey(file: FileIdentity): string | undefined {
  if (file.ino === 0n || file.birthtimeNs <= 0n) return undefined
  return `${file.dev}:${file.ino}:${file.birthtimeNs}:${file.size}:${file.mtimeNs}`
}
