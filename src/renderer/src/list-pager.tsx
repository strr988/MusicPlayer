import { IconButton } from './icons'

export const pageSize = 100

export function ListPager({ page, count, label, onPage }: {
  page: number
  count: number
  label: string
  onPage: (page: number) => void
}) {
  const first = page === 0
  const last = (page + 1) * pageSize >= count
  return <nav className="list-pager" aria-label={label}>
    <span className="muted" role="status">{page * pageSize + 1}–{Math.min((page + 1) * pageSize, count)} из {count}</span>
    <IconButton icon="left" label="Предыдущая страница" aria-disabled={first}
      onClick={() => { if (!first) onPage(page - 1) }} />
    <IconButton icon="right" label="Следующая страница" aria-disabled={last}
      onClick={() => { if (!last) onPage(page + 1) }} />
  </nav>
}
