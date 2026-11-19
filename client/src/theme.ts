/**
 * Colour theme: personal (saved in your account preferences, so it follows you to any device,
 * and never affects collaborators). "system" follows the device's light/dark setting.
 * A copy is kept in this browser so the right theme shows instantly when the page loads.
 */
import { useSyncExternalStore } from 'react'
import { api } from './api'

export type Theme = 'system' | 'light' | 'dark' | 'sepia'
export const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: 'system', label: 'Match system', hint: 'Light or dark, following your device' },
  { id: 'light', label: 'Light', hint: 'Dark text on white' },
  { id: 'dark', label: 'Dark', hint: 'Light text on dark grey' },
  { id: 'sepia', label: 'Sepia', hint: 'Cream page, dark ink: lower glare, dyslexia-friendly' },
]
const KEY = 'sidescript:theme'
const isTheme = (v: unknown): v is Theme => THEMES.some((t) => t.id === v)

let current: Theme = 'system'
const listeners = new Set<() => void>()

function apply(t: Theme) {
  current = t
  if (t === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* private mode: fine */
  }
  listeners.forEach((l) => l())
}

/** Before the first render: use this browser's last theme. */
export function initTheme() {
  let t: unknown = 'system'
  try {
    t = localStorage.getItem(KEY)
  } catch {
    /* ignore */
  }
  apply(isTheme(t) ? t : 'system')
}

/** After sign-in: take the theme saved with the account. */
export function loadThemeFromAccount(prefs: { theme?: unknown } | undefined) {
  if (isTheme(prefs?.theme) && prefs!.theme !== current) apply(prefs!.theme)
}

export async function setTheme(t: Theme) {
  apply(t)
  await api('PUT', '/api/me/prefs', { theme: t }).catch(() => {})
}

export const useTheme = () =>
  useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => current,
  )
