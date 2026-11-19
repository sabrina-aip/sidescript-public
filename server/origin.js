import { config } from './config.js'

/**
 * Is this request from a page served by this app?
 *
 * Browsers always send `Origin` on cross-site POSTs and on WebSocket handshakes.
 * We compare its host with the host the browser actually used. Behind a reverse
 * proxy (or the Vite dev proxy) the `Host` header may be rewritten to the
 * upstream address, so the proxy's `X-Forwarded-Host` is accepted too, as is
 * anything listed in ALLOWED_ORIGINS. Pages on other sites can't set
 * X-Forwarded-Host: a custom header triggers a CORS preflight, which this
 * server never approves, and WebSockets can't carry custom headers at all.
 */
export function checkOrigin(req) {
  const origin = req.headers.origin
  if (!origin || origin === 'null') return { ok: !origin, origin }
  let host
  try {
    host = new URL(origin).host.toLowerCase()
  } catch {
    return { ok: false, origin }
  }
  const candidates = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',')]
    .map((h) => (h || '').trim().toLowerCase())
    .filter(Boolean)
  if (candidates.includes(host)) return { ok: true }
  if (config.allowedOrigins.includes(origin.toLowerCase().replace(/\/$/, ''))) return { ok: true }
  return { ok: false, origin, seen: candidates }
}

export function originError(result) {
  return (
    `Cross-origin request refused: the page at ${result.origin} doesn't match the server address ` +
    `(${(result.seen || []).join(', ') || 'unknown'}). If you use a reverse proxy, make it pass the ` +
    `original Host (nginx: "proxy_set_header Host $host;") or set ALLOWED_ORIGINS=${result.origin}`
  )
}
