import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  // Focus the first control once, when the dialog opens. (This must not re-run on
  // re-renders, or typing in a live-updating dialog would keep yanking focus back.)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input:not([type=color]), select, textarea, button:not(.modal-close)')?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export interface MenuItem {
  label: string
  icon?: ReactNode
  hint?: string
  /** Receives the menu's button, e.g. to anchor a confirmation to it. */
  onClick?: (trigger: HTMLElement) => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

export function Menu({ trigger, items, align = 'left', label }: { trigger: ReactNode; items: MenuItem[]; align?: 'left' | 'right'; label: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="menu-trigger" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label}>
        {trigger}
      </button>
      {open && (
        <div className={`menu ${align}`} role="menu">
          {items.map((it, i) =>
            it.separator ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={i}
                role="menuitem"
                className={`menu-item ${it.danger ? 'danger' : ''}`}
                disabled={it.disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setOpen(false)
                  it.onClick?.(ref.current!.querySelector<HTMLElement>('.menu-trigger')!)
                }}
              >
                <span className="menu-icon">{it.icon}</span>
                <span className="menu-label">{it.label}</span>
                {it.hint && <span className="menu-hint">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}

export function Avatar({ name, color, size = 28, title }: { name: string; color: string; size?: number; title?: string }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.42 }} title={title || name}>
      {(name || '?').trim().charAt(0).toUpperCase()}
    </span>
  )
}

export function Logo() {
  return (
    <span className="logo">
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="currentColor" />
        <rect x="8" y="9" width="16" height="3" rx="1.5" fill="var(--bg)" />
        <rect x="8" y="15" width="10" height="3" rx="1.5" fill="#f97316" />
        <rect x="8" y="21" width="13" height="3" rx="1.5" fill="#3b82f6" />
      </svg>
      <span>Sidescript</span>
    </span>
  )
}
