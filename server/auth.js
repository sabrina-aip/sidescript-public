import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { config } from './config.js'
import { getSecret, getUsers } from './storage.js'

const scrypt = promisify(crypto.scrypt)
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const COOKIE = 'ss_session'
export const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password, salt, 32, SCRYPT)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('$')
  if (alg !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, SCRYPT)
  return crypto.timingSafeEqual(key, expected)
}

// Spend the same time on unknown usernames so they can't be probed by timing.
let dummy
export async function verifyAgainstNothing(password) {
  dummy ??= hashPassword('dummy-password')
  await verifyPassword(password, await dummy)
  return false
}

const b64 = (buf) => Buffer.from(buf).toString('base64url')

/** Stateless signed session token: payload.signature. `v` lets a user revoke all sessions. */
export async function createSession(username, sessionVersion = 0) {
  const payload = b64(JSON.stringify({ u: username, v: sessionVersion, exp: Date.now() + config.sessionDays * 864e5 }))
  const sig = b64(crypto.createHmac('sha256', await getSecret()).update(payload).digest())
  return `${payload}.${sig}`
}

export async function readSession(token) {
  if (!token || typeof token !== 'string') return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = crypto.createHmac('sha256', await getSecret()).update(payload).digest()
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null
  let data
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString())
  } catch {
    return null
  }
  if (!data || data.exp < Date.now()) return null
  const users = await getUsers()
  const user = users[data.u]
  if (!user || user.disabled || (user.sessionVersion || 0) !== data.v) return null
  return publicUser(data.u, user)
}

export function publicUser(username, u) {
  return { username, displayName: u.displayName || username, color: u.color || '#6d5dfc', isAdmin: !!u.isAdmin }
}

export function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
      } catch {
        /* ignore malformed cookie */
      }
    }
  }
  return out
}

export function sessionCookie(token, maxAgeSec) {
  return [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    config.cookieSecure ? 'Secure' : '',
  ].filter(Boolean).join('; ')
}

export async function userFromRequest(req) {
  return readSession(parseCookies(req.headers.cookie)[COOKIE])
}

// ---------------------------------------------------------------- brute-force protection

const attempts = new Map()
const WINDOW = 15 * 60 * 1000
const MAX_FAILS = 10

// Forget expired entries so a spray of guesses from many addresses can't grow memory forever.
setInterval(() => {
  const now = Date.now()
  for (const [key, a] of attempts) if (now - a.first > WINDOW) attempts.delete(key)
}, 60 * 1000).unref()

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const bareIp = (ip) => String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '')

function isTrustedProxy(ip, trust) {
  if (!ip || trust.includes('off')) return false
  const bare = bareIp(ip)
  if (trust.includes('loopback') && (LOOPBACK.has(ip) || LOOPBACK.has(bare) || bare.startsWith('127.'))) return true
  return trust.some((t) => t !== 'loopback' && bareIp(t) === bare)
}

/**
 * The visitor's real IP. Behind a reverse proxy every connection comes from the proxy, so
 * rate limits keyed on the socket address would lock out everyone at once. When the
 * connection comes from a trusted proxy, walk X-Forwarded-For from the right (the entries
 * our own proxies appended) and take the first address that is not one of them. Entries a
 * client wrote itself sit further left and are never reached unless every proxy is trusted.
 */
export function clientIp(req, trust = config.trustProxy) {
  const socketIp = req.socket?.remoteAddress || ''
  if (!isTrustedProxy(socketIp, trust)) return bareIp(socketIp) || 'unknown'
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(hops[i], trust)) return bareIp(hops[i])
  }
  return bareIp(hops[0] || socketIp) || 'unknown'
}

// ---------------------------------------------------------------- first-run setup code

let setupCode = null

/** The one-time code that must be typed in to create the first admin in the browser. */
export function getSetupCode() {
  if (!setupCode) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O or 1/I lookalikes
    setupCode = config.setupCode || Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})(?!$)/g, '$1-')
  }
  return setupCode
}

export function checkSetupCode(given) {
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const a = crypto.createHash('sha256').update(norm(given)).digest()
  const b = crypto.createHash('sha256').update(norm(getSetupCode())).digest()
  return norm(given).length > 0 && crypto.timingSafeEqual(a, b)
}

export function loginBlocked(key) {
  const a = attempts.get(key)
  if (!a) return false
  if (Date.now() - a.first > WINDOW) {
    attempts.delete(key)
    return false
  }
  return a.count >= MAX_FAILS
}
export function recordLoginFailure(key) {
  const a = attempts.get(key)
  if (!a || Date.now() - a.first > WINDOW) attempts.set(key, { first: Date.now(), count: 1 })
  else a.count++
}
export const clearLoginFailures = (key) => attempts.delete(key)

// ---------------------------------------------------------------- admin from environment

/**
 * If ADMIN_PASSWORD is set, make sure that admin account exists with exactly that password.
 * Runs at every start, so changing the variable and restarting resets the password.
 * ADMIN_USERNAME defaults to "admin". Does nothing when ADMIN_PASSWORD is unset.
 */
export async function ensureAdminFromEnv(env = process.env, updateUsers) {
  const password = env.ADMIN_PASSWORD
  if (!password) return
  const username = String(env.ADMIN_USERNAME || 'admin').trim().toLowerCase()
  if (!USERNAME_RE.test(username)) return console.error('[admin] ADMIN_USERNAME must be 2–32 characters: a–z 0–9 . _ -')
  if (password.length < 10) return console.error('[admin] ADMIN_PASSWORD must be at least 10 characters; ignored')
  const message = await updateUsers(async (users) => {
    const existing = users[username]
    if (existing && existing.isAdmin && !existing.disabled && (await verifyPassword(password, existing.passwordHash))) return null
    users[username] = {
      color: '#6d5dfc',
      createdAt: new Date().toISOString(),
      ...existing,
      displayName: existing?.displayName || username,
      passwordHash: await hashPassword(password),
      isAdmin: true,
      disabled: false,
      // Changing the password signs the account out everywhere.
      sessionVersion: (existing?.sessionVersion || 0) + (existing ? 1 : 0),
    }
    return `[admin] "${username}" ${existing ? 'password reset' : 'created'} from ADMIN_PASSWORD`
  })
  if (message) console.log(message)
}
