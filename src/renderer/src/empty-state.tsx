import type { ReactNode } from 'react'
import { Icon } from './icons'
import type { IconName } from './icons'

export function EmptyState({ icon, title, children, action }: {
  icon: IconName
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return <div className="empty-state">
    <span className="empty-mark"><Icon name={icon} /></span>
    <h2>{title}</h2>
    {children && <p>{children}</p>}
    {action}
  </div>
}
