import { useEffect, useState, useSyncExternalStore } from 'react'

export const uid = () => crypto.randomUUID()
export const shortId = () => crypto.randomUUID().slice(0, 8)

export function timeAgo(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`
  return new Date(iso).toLocaleDateString()
}

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export const safeFilename = (s: string) => (s || 'Untitled').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'Untitled'

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** Hex colour -> rgba() string. */
export function tint(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

export function bytesToBase64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
export function base64ToBytes(b64: string) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------- tiny router

const listeners = new Set<() => void>()
window.addEventListener('popstate', () => listeners.forEach((l) => l()))

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  listeners.forEach((l) => l())
}

export function usePath() {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => location.pathname,
  )
}

// ---------------------------------------------------------------- local (per-browser) settings

export function useLocalState<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v))
    } catch {
      /* private mode */
    }
  }, [key, v])
  return [v, setV] as const
}

// ---------------------------------------------------------------- toasts

type Toast = { id: number; text: string; tone?: 'error'; action?: ToastAction }
let toasts: Toast[] = []
const toastListeners = new Set<() => void>()
export interface ToastAction {
  label: string
  run: () => void
}
export function toast(text: string, tone?: 'error', action?: ToastAction) {
  const t = { id: Math.random(), text, tone, action }
  toasts = [...toasts, t]
  toastListeners.forEach((l) => l())
  const drop = () => {
    toasts = toasts.filter((x) => x !== t)
    toastListeners.forEach((l) => l())
  }
  // Messages with a button stay long enough to use it.
  setTimeout(drop, action ? 7000 : 3500)
  return drop
}
export function dismissToast(id: number) {
  toasts = toasts.filter((x) => x.id !== id)
  toastListeners.forEach((l) => l())
}
export function useToasts() {
  return useSyncExternalStore(
    (cb) => (toastListeners.add(cb), () => toastListeners.delete(cb)),
    () => toasts,
  )
}

/** Small WebP preview of an image (longest side `max` px), made in the browser before upload. */
export async function makeThumbnail(file: Blob, max = 480): Promise<Blob | null> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.type === 'image/gif') return null
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
    if (scale === 1 && file.size < 200 * 1024) return null // already small
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    return await new Promise((res) => canvas.toBlob((b) => res(b), 'image/webp', 0.82))
  } catch {
    return null
  }
}
