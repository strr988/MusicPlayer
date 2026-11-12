import { useEffect, useState } from 'react'
import type { DownloadJob, DownloadStatus, MetadataEdits, SourceMetadata } from '../../shared/music-sources'
import { sourceNames } from '../../shared/music-sources'
import { Icon } from './icons'

const statusLabel: Record<DownloadStatus, string> = {
  waiting: 'Ожидает', analyzing: 'Анализируется', ready: 'Готова к загрузке',
  downloading: 'Загружается', processing: 'Обрабатывается', completed: 'Завершена',
  cancelled: 'Отменена', failed: 'Ошибка',
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  return 'Не удалось выполнить действие.'
}

const api = () => window.musicPlayer.downloads
const megabytes = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 })
const metadataHint = 'Правки метаданных сохраняются в библиотеке Music Player. Теги аудиофайла не переписываются.'

export function Downloads({ active, onImport }: { active: boolean; onImport: () => Promise<void> }) {
  const [jobs, setJobs] = useState<DownloadJob[]>([])
  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')

  useEffect(() => {
    if (!active) return
    let mounted = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await api().list()
        if (mounted) { setJobs(result); setListError('') }
      } catch (failure) {
        if (mounted) setListError(errorText(failure))
      } finally {
        if (mounted) timer = setTimeout(() => void poll(), 500)
      }
    }
    void poll()
    return () => { mounted = false; clearTimeout(timer) }
  }, [active])

  async function analyze() {
    if (submitting) return
    const submitted = url
    setSubmitting(true)
    setError('')
    try {
      await api().analyze(submitted)
      setUrl(previous => previous === submitted ? '' : previous)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setSubmitting(false)
    }
  }

  return <section className="downloads">
    <header className="section-heading">
      <div><h1>Загрузки</h1><p>Публичные записи Archive.org и SoundCloud</p></div>
    </header>
    <form className="download-form" onSubmit={event => { event.preventDefault(); void analyze() }}>
      <label>Ссылка на запись
        <input value={url} onChange={event => setUrl(event.target.value)} type="url" required maxLength={2048}
          placeholder="Ссылка Archive.org или SoundCloud" />
      </label>
      <button className="primary" type="submit" disabled={submitting || !url.trim()}>
        <Icon name="search" />Анализировать ссылку
      </button>
    </form>
    {(error || listError) && <p className="notice" role="alert">{error || listError}</p>}
    {jobs.length > 0 && <ul className="download-list" aria-label="Задачи загрузки">
      {jobs.map(job => <DownloadRow key={job.id} job={job} onImport={onImport} />)}
    </ul>}
  </section>
}

function DownloadRow({ job, onImport }: { job: DownloadJob; onImport: () => Promise<void> }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { id, status, metadata, edits, progress, duplicate } = job
  const cancelable = ['waiting', 'analyzing', 'downloading', 'processing'].includes(status)
  const dismissible = job.canDismiss !== false && ['failed', 'cancelled', 'ready'].includes(status)
  const title = edits?.title === undefined ? metadata?.title : edits.title

  async function act(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError('')
    try { await action() } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }

  return <li className="download-row">
    <div className="download-row-heading">
      <div>
        <h2>{title || metadata?.sourceId || job.url}</h2>
        <p role="status">{status === 'ready' && (duplicate || metadata?.restriction) ?
          'Анализ завершён' : statusLabel[status]}</p>
      </div>
      <div className="download-actions">
        {cancelable && <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => api().cancel(id))}>Отменить</button>}
        {dismissible && <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => api().dismiss(id))}>Закрыть задачу</button>}
      </div>
    </div>
    {(status === 'analyzing' || status === 'downloading' || status === 'processing') && <>
      <progress aria-label={statusLabel[status]} value={progress?.total ? progress.bytes : undefined} max={progress?.total ?? undefined} />
      {progress && <p>{megabytes.format(progress.bytes / 1048576)} МиБ
        {progress.total && ` / ${megabytes.format(progress.total / 1048576)} МиБ`}</p>}
    </>}
    {status === 'ready' && metadata && <MetadataForm metadata={metadata} coverUrl={job.coverUrl} busy={busy}
      duplicate={!!duplicate} confirm={value => void act(() => api().confirm(id, value))}
      chooseCover={async () => {
        let cover: string | null = null
        await act(async () => { cover = await api().chooseCover(id) })
        return cover
      }} />}
    {status === 'completed' && <>
      <div className="download-actions">
        {!job.trackId && !job.importing && <button type="button" className="primary" disabled={busy}
          onClick={() => void act(async () => { if (await api().addToLibrary(id)) await onImport() })}>Добавить в библиотеку</button>}
        {job.importing && <>
          <span role="status">Импорт в библиотеку…</span>
          <button type="button" className="secondary" onClick={() => {
            void api().cancel(id).catch(failure => setError(errorText(failure)))
          }}>Отменить импорт</button>
        </>}
        {job.trackId && <span>В библиотеке</span>}
        <button type="button" className="secondary" disabled={busy || job.importing} onClick={() => void act(() => api().reveal(id))}>Показать файл</button>
      </div>
      {!job.trackId && <p className="download-provenance">{metadataHint}</p>}
    </>}
    {status === 'completed' && metadata && <details className="download-provenance">
      <summary>Источник и лицензия</summary>
      <SourceDetails metadata={metadata} />
    </details>}
    {(job.error || error) && <p className="notice" role="alert">{job.error || error}</p>}
  </li>
}

function MetadataForm({ metadata, coverUrl, duplicate, busy, confirm, chooseCover }: {
  metadata: SourceMetadata
  coverUrl?: string
  duplicate: boolean
  busy: boolean
  confirm: (value: MetadataEdits) => void
  chooseCover: () => Promise<string | null>
}) {
  const [edits, setEdits] = useState<MetadataEdits>({})
  const [customCover, setCustomCover] = useState<string | null>(null)
  const image = edits.artwork === 'remove' ? null : edits.artwork === 'custom' ? customCover : coverUrl
  const editable = !duplicate && metadata.downloadFormat !== null
  const duration = edits.durationSeconds === undefined ? metadata.durationSeconds : edits.durationSeconds
  return <form className="download-metadata" onSubmit={event => { event.preventDefault(); confirm(edits) }}>
    <div className="download-cover">
      {image ? <img src={image} alt="Обложка записи" /> : <span aria-label="Обложка отсутствует"><Icon name="music" /></span>}
      {editable && <div className="download-cover-controls">
        <button type="button" className="secondary" disabled={busy} onClick={async () => {
          const selected = await chooseCover()
          if (selected) { setCustomCover(selected); setEdits(previous => ({ ...previous, artwork: 'custom' })) }
        }}>Выбрать обложку</button>
        {image && <button type="button" className="secondary" disabled={busy}
          onClick={() => setEdits(previous => ({ ...previous, artwork: 'remove' }))}>Убрать</button>}
        {edits.artwork && coverUrl && <button type="button" className="secondary" disabled={busy}
          onClick={() => setEdits(({ artwork: _artwork, ...rest }) => rest)}>Исходная</button>}
      </div>}
    </div>
    <div className="download-fields">
      {([['title', 'Название'], ['artist', 'Исполнитель'], ['album', 'Альбом']] as const).map(([key, label]) =>
        <label key={key}>{label}
          <input readOnly={!editable} maxLength={240} placeholder="Нет данных"
            value={(edits[key] === undefined ? metadata[key] : edits[key]) ?? ''}
            onChange={event => setEdits(previous => ({ ...previous, [key]: event.target.value }))} />
        </label>)}
      <label>Длительность, с
        <input readOnly={!editable} type="number" step="any" min="0.01" max="86400" placeholder="Нет данных"
          value={duration ?? ''} onChange={event => {
            const value = event.target.valueAsNumber
            setEdits(previous => ({ ...previous, durationSeconds: Number.isFinite(value) ? value : null }))
          }} />
      </label>
    </div>
    <SourceDetails metadata={metadata} />
    {duplicate && <p className="notice">Эта запись уже есть в библиотеке или менеджере загрузок.</p>}
    {metadata.restriction && <p className="notice">{metadata.restriction}</p>}
    {editable && <p className="notice">{metadataHint}</p>}
    {editable && <div className="download-actions"><button className="primary" type="submit" disabled={busy}>
      <Icon name="download" />Скачать оригинал {metadata.downloadFormat?.toUpperCase()}
    </button></div>}
  </form>
}

function SourceDetails({ metadata }: { metadata: SourceMetadata }) {
  return <dl className="download-details">
    <dt>Источник</dt><dd>{sourceNames[metadata.provider]}</dd>
    <dt>Ссылка</dt><dd>{metadata.originalUrl}</dd>
    <dt>ID записи</dt><dd>{metadata.sourceId}</dd>
    {metadata.publisher && <><dt>Опубликовал</dt><dd>{metadata.publisher}</dd></>}
    <dt>{metadata.provider === 'soundcloud' ? 'Потоковые форматы' : 'Аудиоформаты'}</dt>
    <dd>{(metadata.provider === 'soundcloud' ? metadata.audioFormats :
      metadata.audioFormats.map(format => format.toUpperCase())).join(', ') || 'Нет данных'}</dd>
    <dt>Лицензия</dt><dd>{metadata.licenseUrl ?? metadata.licenseName ?? 'Нет подтверждённой открытой лицензии'}</dd>
  </dl>
}
