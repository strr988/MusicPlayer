import { dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { ytDlpChannels } from '../../shared/modules'
import type { ModuleChange } from '../../shared/modules'
import type { ModuleManager, ModuleRelease } from './module-manager'

const labels = {
  install: 'Установить модуль', update: 'Обновить', reinstall: 'Переустановить',
  remove: 'Удалить модуль', rollback: 'Восстановить версию',
} satisfies Record<ModuleChange, string>

export function registerModuleIpc<Release extends ModuleRelease>(manager: ModuleManager<Release>,
  hasActiveDownloads: () => boolean, senderWindow: (event: IpcMainInvokeEvent) => BrowserWindow) {
  function handle(action: keyof typeof ytDlpChannels, run: (owner: BrowserWindow) => unknown) {
    ipcMain.handle(ytDlpChannels[action], (event, ...args: unknown[]) => {
      const owner = senderWindow(event)
      if (args.length !== 0) throw new Error('Некорректные параметры модуля.')
      return run(owner)
    })
  }
  handle('status', () => manager.status())
  handle('check', () => manager.check())
  handle('cancel', () => manager.cancel())
  for (const action of Object.keys(labels) as ModuleChange[]) {
    handle(action, owner => manager.change(action, hasActiveDownloads, async (version, signal) => {
      const detail = action === 'remove' ? 'Загруженные записи и музыкальная библиотека сохранятся.' :
        action === 'rollback' ? 'Music Player переключится на сохранённую версию.' :
          'Music Player скачает Windows x64 из официального выпуска GitHub, проверит подпись и выполнит пробный анализ Archive.org и SoundCloud. Сборка yt-dlp распространяется под GPLv3+.'
      const { response } = await dialog.showMessageBox(owner, {
        type: 'question', title: 'Модули Music Player', message: `${labels[action]} · yt-dlp ${version}`,
        detail, buttons: [labels[action], 'Отмена'], defaultId: 1, cancelId: 1, noLink: true, signal,
      })
      return response === 0
    }))
  }
}
