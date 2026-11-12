import { useEffect, useState } from 'react'
import type { ModuleChange, ModulePhase, ModuleStatus } from '../../shared/modules'
import { Icon } from './icons'

const phaseLabel: Record<ModulePhase, string> = {
  checking: 'Проверяем выпуск Stable…',
  confirming: 'Ожидаем подтверждения…',
  downloading: 'Скачиваем yt-dlp…',
  verifying: 'Проверяем подпись и целостность…',
  testing: 'Проверяем работу с Archive.org и SoundCloud…',
  applying: 'Сохраняем изменения…',
}

const stateLabel: Record<ModuleStatus['state'], string> = {
  installed: 'Установлен', missing: 'Не установлен', damaged: 'Требует внимания', unsupported: 'Недоступен',
}

export function useYtDlp(active: boolean) {
  const [status, setStatus] = useState<ModuleStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!active) return
    let mounted = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await window.musicPlayer.ytDlp.status()
        if (mounted) setStatus(result)
      } catch {
        if (mounted) setError('Не удалось получить состояние модуля.')
      } finally {
        if (mounted) timer = setTimeout(() => void poll(), 600)
      }
    }
    void poll()
    return () => { mounted = false; clearTimeout(timer) }
  }, [active])

  async function act(action: ModuleChange | 'check' | 'cancel') {
    if (action !== 'cancel') {
      if (pending || status?.phase) return
      setPending(true)
    }
    setError('')
    try {
      await window.musicPlayer.ytDlp[action]()
    } catch {
      setError('Действие недоступно. Дождитесь завершения текущей операции и повторите попытку.')
    } finally {
      if (action !== 'cancel') setPending(false)
    }
  }
  return { status, busy: pending || !!status?.phase, error, act }
}

export function ModuleFeedback({ module }: { module: ReturnType<typeof useYtDlp> }) {
  const { status, busy, error, act } = module
  const phase = status?.phase
  return <>
    {busy && <div className="module-progress">
      <p role="status">{phase ? phaseLabel[phase] : 'Выполняем операцию…'}</p>
      {phase !== 'confirming' && <progress aria-label="Ход операции" value={status?.progress?.bytes}
        max={status?.progress?.total} />}
      {status?.progress && <p>{Math.floor(100 * status.progress.bytes / status.progress.total)}%</p>}
      {phase && phase !== 'applying' && phase !== 'confirming' &&
        <button type="button" className="secondary" onClick={() => void act('cancel')}>Отменить операцию</button>}
    </div>}
    {status?.diagnostic && <p className="notice" role="alert">{status.diagnostic}</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {!busy && !error && status?.message && <p className="notice" role={status.message.error ? 'alert' : 'status'}>
      {status.message.text}</p>}
  </>
}

export function ModuleSettings({ active }: { active: boolean }) {
  const module = useYtDlp(active)
  const { status, busy, act } = module
  const check = status?.lastChecked
  const installed = status?.installedVersion
  return <section className="module-settings">
    <header className="section-heading"><div><h1>Настройки</h1></div></header>
    <section aria-labelledby="modules-heading">
      <h2 id="modules-heading">Модули</h2>
      <article className="module-card" aria-labelledby="ytdlp-heading">
        <header>
          <span className="empty-mark"><Icon name="download" /></span>
          <div><h3 id="ytdlp-heading">yt-dlp</h3><p>Анализ ссылок Archive.org и SoundCloud</p></div>
          <span className="module-state" data-state={status?.state}>{status ? stateLabel[status.state] : 'Загрузка…'}</span>
        </header>
        <dl className="module-facts">
          <div><dt>Установленная версия</dt><dd>{installed ?? '—'}</dd></div>
          <div><dt>Канал обновлений</dt><dd>Stable</dd></div>
          <div><dt>Последний выпуск</dt><dd>{status?.latestVersion ?? '—'}</dd></div>
          <div><dt>Последняя проверка</dt><dd>{check ? new Date(check.date).toLocaleString('ru-RU', {
            dateStyle: 'short', timeStyle: 'short',
          }) : 'Ещё не проводилась'}</dd></div>
        </dl>
        {check && <p className="module-check-result">{!check.ok ? 'Не удалось проверить обновления.' :
          status.updateAvailable ? 'Доступен новый выпуск. Совместимость проверяется при обновлении.' :
            installed ? 'Обновлений нет.' : 'Выпуск Stable найден.'}</p>}
        {status?.state === 'unsupported' && <p className="notice">Модуль доступен на Windows x64.</p>}
        <ModuleFeedback module={module} />
        {status && status.state !== 'unsupported' && <div className="download-actions module-actions">
          {status.state === 'missing' && <button type="button" className="primary" disabled={busy}
            onClick={() => void act('install')}>Установить модуль</button>}
          {status.updateAvailable && <button type="button" className="primary" disabled={busy}
            onClick={() => void act('update')}>Обновить</button>}
          <button type="button" className="secondary" disabled={busy} onClick={() => void act('check')}>Проверить обновления</button>
          {(installed || status.state === 'damaged') && <button type="button" className="secondary" disabled={busy}
            onClick={() => void act('reinstall')}>Переустановить</button>}
          {installed && <>
            {status.previousVersion && <button type="button" className="secondary" disabled={busy}
              onClick={() => void act('rollback')}>Восстановить {status.previousVersion}</button>}
            <button type="button" className="secondary" disabled={busy} onClick={() => void act('remove')}>Удалить модуль</button>
          </>}
        </div>}
      </article>
    </section>
  </section>
}
