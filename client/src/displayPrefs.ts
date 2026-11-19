/**
 * How scripts look to you: font, text size, Pages or Pageless, paper size, orientation and
 * margins. Personal (saved in your account preferences, so they follow you to every device) and
 * never shared: each collaborator sees scripts their own way. Printing and downloads use the
 * settings of whoever prints or downloads.
 * A copy is kept in this browser so scripts open in the right layout straight away.
 */
import { useSyncExternalStore } from 'react'
import { api } from './api'
import { DEFAULT_LAYOUT, normalizeLayout, type PageLayout } from './editor/layout'

const KEY = 'sidescript:display'
let current: PageLayout = DEFAULT_LAYOUT
const listeners = new Set<() => void>()

function apply(next: PageLayout, remember = true) {
  current = next
  if (remember)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* private mode: fine */
    }
  listeners.forEach((l) => l())
}

export function initDisplayPrefs() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) current = normalizeLayout(JSON.parse(raw))
  } catch {
    /* ignore */
  }
}

/** After sign-in: take the settings saved with the account. */
export function loadDisplayFromAccount(prefs: { display?: unknown } | undefined) {
  if (prefs?.display && typeof prefs.display === 'object') apply(normalizeLayout(prefs.display))
}

let saveTimer: number | undefined
export function setDisplay(patch: Partial<PageLayout>) {
  apply(normalizeLayout({ ...current, ...patch }))
  // Save to the account shortly after the last change (the size stepper can fire quickly).
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void api('PUT', '/api/me/prefs', { display: current }).catch(() => {}), 400)
}

export const useDisplayPrefs = () =>
  useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => current,
  )
