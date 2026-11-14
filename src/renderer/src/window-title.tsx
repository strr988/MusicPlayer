import logo from '../assets/mustplay.png'

export function WindowTitle({ mini = false }: { mini?: boolean }) {
  return <header className="window-title">
    <img src={logo} alt="" width="22" height="22" draggable={false} />
    <strong>mustplay</strong>
    {mini && <span>Мини-плеер</span>}
  </header>
}
