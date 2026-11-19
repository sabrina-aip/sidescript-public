import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import * as storage from './storage.js'
import * as auth from './auth.js'
import { roleFor, canEdit } from './permissions.js'
import { sanitizeCategories, newDocState, validateState, duplicateState } from './docmodel.js'
import { sanitizeFields, sanitizeColor } from './script.js'
import { makeEmbed } from './embed.js'
import { currentState, openRoom, getRoom } from './collab.js'
import { checkOrigin, originError } from './origin.js'

// ---------------------------------------------------------------- privacy / security headers

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const BASE_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=()',
  // Ask every crawler / AI scraper not to index, archive or train on anything.
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai',
}

// Known AI / scraping crawlers are refused outright (everything needs a login anyway).
const BOT_UA =
  /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|CCBot|Google-Extended|GoogleOther|Bytespider|PerplexityBot|Perplexity-User|Amazonbot|Applebot-Extended|meta-externalagent|FacebookBot|Diffbot|cohere-ai|YouBot|Omgilibot|ImagesiftBot|Timpibot|AI2Bot|Kangaroo Bot|PetalBot|DataForSeoBot|Scrapy|img2dataset/i

const ROBOTS = 'User-agent: *\nDisallow: /\n'

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message)
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) fail(413, 'Request too large')
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    fail(400, 'Invalid JSON')
  }
}

const clientIp = (req) => auth.clientIp(req)

function docView(meta, username, users) {
  const role = roleFor(meta, username)
  return {
    id: meta.id,
    title: meta.title,
    owner: meta.owner,
    ownerName: users[meta.owner]?.displayName || meta.owner,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    trashed: !!meta.trashed,
    role,
    shares: role === 'owner' ? meta.shares || {} : undefined,
  }
}

function requireDoc(id, user, need = 'read') {
  const meta = storage.getDoc(id)
  const role = meta && roleFor(meta, user.username)
  if (!role) fail(404, 'Document not found')
  if (need === 'edit' && !canEdit(role)) fail(403, 'You have view-only access')
  if (need === 'owner' && role !== 'owner') fail(403, 'Only the owner can do that')
  return { meta, role }
}

// ---------------------------------------------------------------- routes

const routes = []
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts })

route('GET', /^\/api\/status$/, async (req, res, { user }) => {
  const users = await storage.getUsers()
  json(res, 200, { needsSetup: Object.keys(users).length === 0, user })
}, { public: true })

route('POST', /^\/api\/setup$/, async (req, res) => {
  const ip = clientIp(req)
  if (auth.loginBlocked(ip)) fail(429, 'Too many attempts. Try again in 15 minutes.')
  const body = await readBody(req)
  if (Object.keys(await storage.getUsers()).length > 0) fail(409, 'Already set up')
  // Without this, whoever reaches a fresh server first could make themselves admin.
  if (!auth.checkSetupCode(body.setupCode)) {
    auth.recordLoginFailure(ip)
    fail(403, 'Wrong setup code. It is printed in the server log when Sidescript starts.')
  }
  const username = String(body.username || '').trim().toLowerCase()
  if (!auth.USERNAME_RE.test(username)) fail(400, 'Username: 2–32 characters, a–z 0–9 . _ -')
  if (String(body.password || '').length < 10) fail(400, 'Password must be at least 10 characters')
  const hash = await auth.hashPassword(body.password)
  await storage.updateUsers((users) => {
    if (Object.keys(users).length > 0) fail(409, 'Already set up')
    users[username] = { displayName: String(body.displayName || username).slice(0, 60), passwordHash: hash, isAdmin: true, color: '#6d5dfc', createdAt: new Date().toISOString(), sessionVersion: 0 }
  })
  const token = await auth.createSession(username, 0)
  json(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(token, config.sessionDays * 86400) })
}, { public: true })

route('POST', /^\/api\/login$/, async (req, res) => {
  const ip = clientIp(req)
  if (auth.loginBlocked(ip)) fail(429, 'Too many attempts. Try again in 15 minutes.')
  const body = await readBody(req)
  const username = String(body.username || '').trim().toLowerCase()
  const users = await storage.getUsers()
  const u = users[username]
  const ok = u && !u.disabled ? await auth.verifyPassword(String(body.password || ''), u.passwordHash) : await auth.verifyAgainstNothing(String(body.password || ''))
  if (!ok) {
    auth.recordLoginFailure(ip)
    fail(401, 'Wrong username or password')
  }
  auth.clearLoginFailures(ip)
  const token = await auth.createSession(username, u.sessionVersion || 0)
  json(res, 200, { user: auth.publicUser(username, u) }, { 'Set-Cookie': auth.sessionCookie(token, config.sessionDays * 86400) })
}, { public: true })

route('POST', /^\/api\/logout$/, async (req, res) => {
  json(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie('', 0) })
}, { public: true })

route('GET', /^\/api\/me$/, async (req, res, { user }) => json(res, 200, { user }))

route('PATCH', /^\/api\/me$/, async (req, res, { user }) => {
  const body = await readBody(req)
  const next = await storage.updateUsers((users) => {
    const u = users[user.username]
    if (body.displayName !== undefined) u.displayName = String(body.displayName).trim().slice(0, 60) || user.username
    if (body.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(body.color)) u.color = body.color
    return auth.publicUser(user.username, u)
  })
  json(res, 200, { user: next })
})

route('POST', /^\/api\/me\/password$/, async (req, res, { user }) => {
  const body = await readBody(req)
  if (String(body.next || '').length < 10) fail(400, 'New password must be at least 10 characters')
  const users = await storage.getUsers()
  if (!(await auth.verifyPassword(String(body.current || ''), users[user.username].passwordHash))) fail(401, 'Current password is wrong')
  const hash = await auth.hashPassword(body.next)
  const v = await storage.updateUsers((all) => {
    const u = all[user.username]
    u.passwordHash = hash
    u.sessionVersion = (u.sessionVersion || 0) + 1 // signs out every other device
    return u.sessionVersion
  })
  const token = await auth.createSession(user.username, v)
  json(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(token, config.sessionDays * 86400) })
})

route('GET', /^\/api\/me\/prefs$/, async (req, res, { user }) => {
  const users = await storage.getUsers()
  json(res, 200, { prefs: users[user.username].prefs || {} })
})

/** Personal display settings (font, size, pages, paper, margins). Unknown values are dropped;
 * the client falls back to its defaults for anything missing. */
function sanitizeDisplay(d) {
  if (!d || typeof d !== 'object') return null
  const pick = (v, ok) => (typeof v === 'string' && ok.includes(v) ? v : undefined)
  const out = {
    mode: pick(d.mode, ['paged', 'pageless']),
    size: pick(d.size, ['letter', 'a4', 'legal', 'a5', 'executive', 'tabloid', 'a3']),
    orientation: pick(d.orientation, ['portrait', 'landscape']),
    margins: pick(d.margins, ['normal', 'narrow', 'moderate', 'wide']),
    font: pick(d.font, ['times', 'arial', 'comic', 'inconsolata', 'dyslexic']),
    fontSize: typeof d.fontSize === 'number' && d.fontSize >= 6 && d.fontSize <= 36 ? d.fontSize : undefined,
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined))
}

route('PUT', /^\/api\/me\/prefs$/, async (req, res, { user }) => {
  const body = await readBody(req)
  // Each part is optional: save the highlight key, the field key, or the section colour.
  const patch = {}
  if (body.categories !== undefined) patch.categories = sanitizeCategories(body.categories) ?? fail(400, 'Invalid key')
  if (body.fields !== undefined) patch.fields = sanitizeFields(body.fields) ?? fail(400, 'Invalid fields')
  if (body.display !== undefined) patch.display = sanitizeDisplay(body.display) ?? fail(400, 'Invalid display settings')
  if (body.theme !== undefined) patch.theme = ['system', 'light', 'dark', 'sepia'].includes(body.theme) ? body.theme : fail(400, 'Invalid theme')
  if (body.sectionColor !== undefined) patch.sectionColor = body.sectionColor === null ? undefined : sanitizeColor(body.sectionColor) ?? fail(400, 'Invalid colour')
  await storage.updateUsers((users) => {
    users[user.username].prefs = { ...(users[user.username].prefs || {}), ...patch }
  })
  json(res, 200, { ok: true })
})

route('GET', /^\/api\/users$/, async (req, res, { user }) => {
  const users = await storage.getUsers()
  json(res, 200, {
    users: Object.entries(users)
      .filter(([, u]) => !u.disabled || user.isAdmin)
      .map(([name, u]) => ({ ...auth.publicUser(name, u), disabled: user.isAdmin ? !!u.disabled : undefined })),
  })
})

route('POST', /^\/api\/users$/, async (req, res, { user }) => {
  if (!user.isAdmin) fail(403, 'Admins only')
  const body = await readBody(req)
  const username = String(body.username || '').trim().toLowerCase()
  if (!auth.USERNAME_RE.test(username)) fail(400, 'Username: 2–32 characters, a–z 0–9 . _ -')
  if (String(body.password || '').length < 10) fail(400, 'Password must be at least 10 characters')
  const hash = await auth.hashPassword(body.password)
  await storage.updateUsers((users) => {
    if (users[username]) fail(409, 'That username is taken')
    const palette = ['#e11d48', '#0891b2', '#7c3aed', '#16a34a', '#ea580c', '#2563eb', '#c026d3']
    users[username] = { displayName: String(body.displayName || username).slice(0, 60), passwordHash: hash, isAdmin: !!body.isAdmin, color: palette[Object.keys(users).length % palette.length], createdAt: new Date().toISOString(), sessionVersion: 0 }
  })
  json(res, 201, { ok: true })
})

route('PATCH', /^\/api\/users\/([a-z0-9_.-]{2,32})$/, async (req, res, { user, params }) => {
  if (!user.isAdmin) fail(403, 'Admins only')
  const body = await readBody(req)
  const hash = body.password ? (String(body.password).length >= 10 ? await auth.hashPassword(body.password) : fail(400, 'Password must be at least 10 characters')) : null
  await storage.updateUsers((users) => {
    const u = users[params[0]]
    if (!u) fail(404, 'No such user')
    if (params[0] === user.username && body.disabled) fail(400, "You can't disable yourself")
    if (body.disabled !== undefined) u.disabled = !!body.disabled
    if (hash) u.passwordHash = hash
    u.sessionVersion = (u.sessionVersion || 0) + 1
  })
  json(res, 200, { ok: true })
})

// ---- documents

route('GET', /^\/api\/docs$/, async (req, res, { user }) => {
  const users = await storage.getUsers()
  const docs = storage
    .listDocs()
    .filter((m) => roleFor(m, user.username))
    .map((m) => docView(m, user.username, users))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  json(res, 200, { docs })
})

route('POST', /^\/api\/docs$/, async (req, res, { user }) => {
  const body = await readBody(req, 64 * 1024 * 1024)
  const title = String(body.title || 'Untitled document').slice(0, 200)
  let state
  if (body.state) {
    try {
      state = validateState(Buffer.from(String(body.state), 'base64'), title)
    } catch {
      fail(400, 'That file is not a valid Sidescript backup')
    }
  } else {
    const users = await storage.getUsers()
    const prefs = users[user.username].prefs || {}
    state = newDocState({ title, categories: prefs.categories, fields: prefs.fields, sectionColor: prefs.sectionColor })
  }
  const meta = await storage.createDoc({ owner: user.username, title, state })
  json(res, 201, { doc: docView(meta, user.username, await storage.getUsers()) })
})

route('GET', /^\/api\/docs\/([a-f0-9-]{36})$/, async (req, res, { user, params }) => {
  const { meta } = requireDoc(params[0], user)
  json(res, 200, { doc: docView(meta, user.username, await storage.getUsers()) })
})

route('PATCH', /^\/api\/docs\/([a-f0-9-]{36})$/, async (req, res, { user, params }) => {
  requireDoc(params[0], user, 'owner')
  const body = await readBody(req)
  // Trash is a flag only. There is deliberately no way to permanently delete from the app.
  const meta = await storage.updateDoc(params[0], (m) => {
    if (body.trashed !== undefined) {
      m.trashed = !!body.trashed
      m.trashedAt = m.trashed ? new Date().toISOString() : undefined
    }
  })
  json(res, 200, { doc: docView(meta, user.username, await storage.getUsers()) })
})

route('POST', /^\/api\/docs\/([a-f0-9-]{36})\/duplicate$/, async (req, res, { user, params }) => {
  const { meta: src } = requireDoc(params[0], user)
  const title = `Copy of ${src.title}`.slice(0, 200)
  const meta = await storage.createDoc({ owner: user.username, title })
  await storage.copyMedia(src.id, meta.id)
  await storage.writeState(meta.id, duplicateState(await currentState(src.id), src.id, meta.id, title))
  json(res, 201, { doc: docView(meta, user.username, await storage.getUsers()) })
})

route('PUT', /^\/api\/docs\/([a-f0-9-]{36})\/shares$/, async (req, res, { user, params }) => {
  requireDoc(params[0], user, 'owner')
  const body = await readBody(req)
  const username = String(body.username || '').toLowerCase()
  const users = await storage.getUsers()
  if (!users[username]) fail(404, 'No user with that username')
  if (username === user.username) fail(400, "You're the owner")
  const role = body.role === 'editor' || body.role === 'viewer' ? body.role : null
  const meta = await storage.updateDoc(params[0], (m) => {
    m.shares = { ...(m.shares || {}) }
    if (role) m.shares[username] = role
    else delete m.shares[username]
  })
  openRoom(params[0])?.revoke(username) // reconnect with the new role (or not at all)
  json(res, 200, { doc: docView(meta, user.username, users) })
})

route('GET', /^\/api\/docs\/([a-f0-9-]{36})\/history$/, async (req, res, { user, params }) => {
  requireDoc(params[0], user)
  json(res, 200, { versions: await storage.listSnapshots(params[0]) })
})

route('POST', /^\/api\/docs\/([a-f0-9-]{36})\/history$/, async (req, res, { user, params }) => {
  requireDoc(params[0], user, 'edit')
  const body = await readBody(req)
  const room = await getRoom(params[0])
  const name = await room.snapshotNow(String(body.label || ''))
  json(res, 201, { name })
})

route('GET', /^\/api\/docs\/([a-f0-9-]{36})\/history\/([A-Za-z0-9-]+\.(?:bin|full\.gz|delta\.gz))$/, async (req, res, { user, params }) => {
  requireDoc(params[0], user)
  let buf
  try {
    buf = await storage.readSnapshot(params[0], params[1])
  } catch {
    fail(404, 'Version not found')
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' })
  res.end(buf)
})

route('POST', /^\/api\/docs\/([a-f0-9-]{36})\/media$/, async (req, res, { user, params }) => {
  requireDoc(params[0], user, 'edit')
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > config.maxUploadBytes) fail(413, `Files are limited to ${Math.round(config.maxUploadBytes / 1048576)} MB`)
  const { name, size } = await storage.saveMedia(params[0], mime, req)
  json(res, 201, { url: `/api/docs/${params[0]}/media/${name}`, size })
})

// Paste a link into an annotation: this server fetches it once and stores what it needs
// locally (no third-party lookup service; viewers never contact the linked site).
route('POST', /^\/api\/docs\/([a-f0-9-]{36})\/embed$/, async (req, res, { user, params }) => {
  requireDoc(params[0], user, 'edit')
  const body = await readBody(req)
  const attachment = await makeEmbed(params[0], body.url, { allowPrivate: config.citeAllowPrivate })
  json(res, 201, { attachment })
})

route('GET', /^\/api\/docs\/([a-f0-9-]{36})\/media\/([a-f0-9-]{36}\.[a-z0-9]{1,8})$/, async (req, res, { user, params }) => {
  requireDoc(params[0], user)
  const file = storage.mediaFile(params[0], params[1])
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    fail(404, 'Not found')
  }
  const ext = path.extname(file).slice(1)
  const type = storage.MIME[ext] || 'application/octet-stream'
  const inline = /^(image|audio|video)\//.test(type) || type === 'application/pdf'
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    // Uploaded files can never run script in the app's origin.
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1
    start = Math.max(0, start)
    end = Math.min(end, stat.size - 1)
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      return res.end()
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 })
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size })
  fs.createReadStream(file).pipe(res)
})

// ---------------------------------------------------------------- static client

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel.includes('\0')) return false
  let file = path.join(config.clientDir, path.normalize(rel).replace(/^([/\\])+/, ''))
  if (!file.startsWith(config.clientDir)) return false
  let stat = await fsp.stat(file).catch(() => null)
  const isAsset = /\.[a-z0-9]+$/i.test(rel)
  if (!stat || stat.isDirectory()) {
    if (isAsset) return false
    file = path.join(config.clientDir, 'index.html') // SPA fallback
    stat = await fsp.stat(file).catch(() => null)
    if (!stat) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('Client not built. Run `npm run build` (or use `npm run dev`).')
      return true
    }
  }
  const hashed = rel.startsWith('/assets/')
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') return res.end(), true
  fs.createReadStream(file).pipe(res)
  return true
}

// ---------------------------------------------------------------- main handler

export async function handle(req, res) {
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v)
  try {
    const url = new URL(req.url, 'http://x')
    const pathname = url.pathname

    if (BOT_UA.test(req.headers['user-agent'] || '')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      return res.end('Forbidden')
    }
    if (pathname === '/robots.txt' || pathname === '/ai.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end(ROBOTS)
    }

    if (pathname.startsWith('/api/')) {
      const r = routes.find((r) => r.method === req.method && r.pattern.test(pathname))
      if (!r) fail(404, 'Not found')
      // CSRF: state-changing requests must come from our own JS (custom header + same origin).
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.headers['x-sidescript'] !== '1') fail(403, 'Missing request header')
        const o = checkOrigin(req)
        if (!o.ok) {
          console.warn(`[http] ${originError(o)}`)
          fail(403, originError(o))
        }
      }
      const user = await auth.userFromRequest(req)
      if (!r.public && !user) fail(401, 'Please sign in')
      const params = r.pattern.exec(pathname).slice(1)
      await r.handler(req, res, { user, params, url })
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed')
    if (!(await serveStatic(req, res, pathname))) fail(404, 'Not found')
  } catch (e) {
    const status = e.status || 500
    if (status >= 500) console.error('[http]', e)
    if (!res.headersSent) json(res, status, { error: status >= 500 ? 'Server error' : e.message })
    else res.destroy()
  }
}
