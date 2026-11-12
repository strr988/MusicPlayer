export const ytDlpChannels = {
  status: 'modules:yt-dlp:status',
  check: 'modules:yt-dlp:check',
  install: 'modules:yt-dlp:install',
  update: 'modules:yt-dlp:update',
  reinstall: 'modules:yt-dlp:reinstall',
  remove: 'modules:yt-dlp:remove',
  rollback: 'modules:yt-dlp:rollback',
  cancel: 'modules:yt-dlp:cancel',
} as const

export type ModuleChange = 'install' | 'update' | 'reinstall' | 'remove' | 'rollback'
export type ModulePhase = 'checking' | 'confirming' | 'downloading' | 'verifying' | 'testing' | 'applying'

export interface ModuleStatus {
  state: 'missing' | 'installed' | 'damaged' | 'unsupported'
  installedVersion: string | null
  previousVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  lastChecked: { date: string; ok: boolean } | null
  phase: ModulePhase | null
  progress: { bytes: number; total: number } | null
  diagnostic: string | null
  message: { text: string; error: boolean } | null
}

export type YtDlpModuleApi = Record<ModuleChange | 'check' | 'cancel', () => Promise<void>> & {
  status: () => Promise<ModuleStatus>
}
