/**
 * A small confirmation bubble anchored to the button that asked for it — the app's own
 * replacement for the browser's confirm(). Plain DOM, so React and ProseMirror views can share it.
 *
 *   if (!(await confirmAt(button, { message: 'Delete this?', confirm: 'Delete', danger: true }))) return
 *
 * Resolves false on Cancel, Esc, a click elsewhere, scrolling away or resizing. Without an
 * anchor (e.g. a paste) it appears near the top of the window.
 */
export interface ConfirmOptions {
  title?: string
  message: string
  confirm?: string
  cancel?: string
  danger?: boolean
}

let closeOpen: ((ok: boolean) => void) | null = null

export function confirmAt(anchor: Element | null | undefined, o: ConfirmOptions): Promise<boolean> {
  closeOpen?.(false) // only one at a time
  const returnFocus = (anchor instanceof HTMLElement && anchor) || (document.activeElement as HTMLElement | null)
  return new Promise((resolve) => {
    const pop = document.createElement('div')
    pop.className = 'confirm-pop'
    pop.setAttribute('role', 'alertdialog')
    const id = 'cp' + Math.random().toString(36).slice(2, 8)
    pop.setAttribute('aria-labelledby', id)
    if (o.title) {
      const t = document.createElement('strong')
      t.className = 'confirm-title'
      t.textContent = o.title
      pop.append(t)
    }
    const msg = document.createElement('p')
    msg.id = id
    msg.textContent = o.message
    const row = document.createElement('div')
    row.className = 'confirm-actions'
    const no = document.createElement('button')
    no.type = 'button'
    no.className = 'btn small'
    no.textContent = o.cancel || 'Cancel'
    const yes = document.createElement('button')
    yes.type = 'button'
    yes.className = `btn small ${o.danger ? 'danger-fill' : 'primary'}`
    yes.textContent = o.confirm || 'OK'
    row.append(no, yes)
    pop.append(msg, row)
    document.body.append(pop)

    // Position: centred under the anchor (or above it if there's no room), kept on screen.
    const place = () => {
      const r = anchor?.isConnected ? anchor.getBoundingClientRect() : null
      const w = pop.offsetWidth
      const h = pop.offsetHeight
      const vw = document.documentElement.clientWidth
      const vh = window.innerHeight
      if (!r) {
        pop.style.left = `${Math.max(8, (vw - w) / 2)}px`
        pop.style.top = '72px'
        pop.dataset.side = 'none'
        return
      }
      const cx = r.left + r.width / 2
      const left = Math.min(vw - w - 8, Math.max(8, cx - w / 2))
      const below = r.bottom + 10 + h <= vh - 8 || r.top - 10 - h < 8
      pop.style.left = `${left}px`
      pop.style.top = `${below ? r.bottom + 10 : r.top - 10 - h}px`
      pop.dataset.side = below ? 'below' : 'above'
      pop.style.setProperty('--arrow-x', `${Math.min(w - 14, Math.max(14, cx - left))}px`)
    }
    place()

    const finish = (ok: boolean) => {
      if (closeOpen !== finish) return
      closeOpen = null
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('resize', cancel)
      window.removeEventListener('scroll', onScroll, true)
      pop.remove()
      if (!ok && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
      resolve(ok)
    }
    const cancel = () => finish(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't let the Esc also close a dialog underneath.
        e.preventDefault()
        e.stopPropagation()
        finish(false)
      } else if (e.key === 'Tab') {
        // Keep keyboard focus inside the bubble.
        e.preventDefault()
        ;(document.activeElement === yes ? no : yes).focus()
      }
    }
    const onDown = (e: MouseEvent) => {
      if (pop.contains(e.target as Node)) return
      // A click elsewhere cancels, and is not passed on (so it can't close a dialog underneath).
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
    const onScroll = (e: Event) => !pop.contains(e.target as Node) && finish(false)
    closeOpen = finish
    no.addEventListener('click', cancel)
    yes.addEventListener('click', () => finish(true))
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('resize', cancel)
    window.addEventListener('scroll', onScroll, true)
    yes.focus({ preventScroll: true })
  })
}
