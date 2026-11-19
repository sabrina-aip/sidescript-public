import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v))

export const config = {
  root,
  // Bind to localhost by default: put a TLS reverse proxy (Caddy / nginx) in front.
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8080),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  clientDir: path.join(root, 'client', 'dist'),
  // Set COOKIE_SECURE=1 when served over HTTPS (recommended in production).
  cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024,
  // How often (at most) a version-history snapshot is written while a doc is being edited.
  snapshotIntervalMs: Number(process.env.SNAPSHOT_MINUTES || 10) * 60 * 1000,
  // Debounce for writing the live document state to disk.
  saveDebounceMs: Number(process.env.SAVE_DEBOUNCE_MS || 1000),
  // Extra page origins allowed to talk to the API, comma separated
  // (e.g. "https://docs.example.com"). Only needed if your proxy hides the real host.
  allowedOrigins: String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\/$/, ''))
    .filter(Boolean),
  // Testing only: let "Fetch details" reach private/local addresses. Never enable in production.
  citeAllowPrivate: bool(process.env.CITE_ALLOW_PRIVATE, false),
  sessionDays: Number(process.env.SESSION_DAYS || 30),
  // Addresses of reverse proxies whose X-Forwarded-For header is believed when working out
  // a visitor's IP (used to rate-limit sign-in). "loopback" (the default) covers a proxy on
  // the same machine; list other proxy IPs comma separated, or set "off" if nothing is in front.
  trustProxy: String(process.env.TRUST_PROXY ?? 'loopback')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // One-time code needed to create the first admin account in the browser. Leave unset to have
  // a random one generated and printed to the server log on start-up.
  setupCode: process.env.SETUP_CODE || '',
}
