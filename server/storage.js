/**
 * File-based storage. Everything lives in plain files under DATA_DIR so it is
 * easy to inspect, back up (rsync / restic / tar) and move between servers.
 *
 *   data/
 *     secret.key                 HMAC key for session cookies
 *     users.json                 accounts (scrypt password hashes)
 *     docs/<id>/meta.json        title, owner, sharing, trash flag
 *     docs/<id>/state.bin        current Yjs document state
 *     docs/<id>/history/*.bin    version snapshots (never pruned)
 *     docs/<id>/media/*          uploaded images / audio / video / files
 *
 * SAFETY RULES — this module is the only code that touches DATA_DIR:
 *   1. Nothing is ever deleted. There is no unlink/rm of user data anywhere.
 *      "Delete" in the UI only sets `trashed: true` in meta.json.
 *   2. Every write is atomic: write to a temp file, fsync, rename over the
 *      target, fsync the directory. A crash mid-write leaves the old file intact.
 *   3. Version snapshots are append-only; old ones are never overwritten.
 *   4. A file that fails to parse is renamed aside (kept), never discarded.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import * as Y from 'yjs'
import { config } from './config.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

const DOC_ID_RE = /^[a-f0-9-]{36}$/
// Version files: <timestamp>[-label].<kind>, kind = bin (older, full, uncompressed),
// full.gz (full copy) or delta.gz (changes since the previous version).
const SNAP_RE = /^(\d{8}T\d{6}\d{3}Z)(?:-([a-z0-9-]{0,60}))?\.(bin|full\.gz|delta\.gz)$/
const MEDIA_RE = /^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/

export const isDocId = (id) => typeof id === 'string' && DOC_ID_RE.test(id)
export const isMediaName = (n) => typeof n === 'string' && MEDIA_RE.test(n)

const dataPath = (...p) => path.join(config.dataDir, ...p)
const docPath = (id, ...p) => {
  if (!isDocId(id)) throw new Error('invalid document id')
  return dataPath('docs', id, ...p)
}

async function fsyncDir(dir) {
  let fh
  try {
    fh = await fsp.open(dir, 'r')
    await fh.sync()
  } catch {
    /* not supported on some platforms (e.g. Windows) */
  } finally {
    await fh?.close()
  }
}

/** Atomically replace `file` with `data`. */
export async function atomicWrite(file, data) {
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  const fh = await fsp.open(tmp, 'wx', 0o600)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fsp.rename(tmp, file)
  await fsyncDir(dir)
}

/** Write a file that must not already exist (used for append-only history). */
async function writeNew(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const fh = await fsp.open(file, 'wx', 0o600)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fsyncDir(path.dirname(file))
}

/** Move a broken file aside instead of overwriting or deleting it. */
async function quarantine(file) {
  const dest = `${file}.corrupt-${Date.now()}`
  await fsp.rename(file, dest)
  console.error(`[storage] could not parse ${file}; kept it as ${dest}`)
}

async function readJSON(file, fallback) {
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return fallback
    throw e
  }
  try {
    return JSON.parse(raw)
  } catch {
    await quarantine(file)
    return fallback
  }
}

const writeJSON = (file, obj) => atomicWrite(file, JSON.stringify(obj, null, 2))

const stamp = (ms = Date.now()) => new Date(ms).toISOString().replace(/[-:.]/g, '').replace(/(\d{6})(\d{3})Z$/, '$1$2Z')

// ---------------------------------------------------------------- init

export async function initStorage() {
  await fsp.mkdir(dataPath('docs'), { recursive: true, mode: 0o700 })
  // Fail fast if the data dir is not writable rather than silently losing edits later.
  await fsp.access(config.dataDir, fs.constants.W_OK)
  await loadIndex()
}

export async function getSecret() {
  const file = dataPath('secret.key')
  try {
    return await fsp.readFile(file)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    const key = crypto.randomBytes(32)
    await writeNew(file, key)
    return key
  }
}

// ---------------------------------------------------------------- users

let usersCache = null
let usersWrite = Promise.resolve()

export async function getUsers() {
  if (!usersCache) usersCache = await readJSON(dataPath('users.json'), {})
  return usersCache
}

/** Mutate the user table under a write lock. */
export async function updateUsers(fn) {
  const run = usersWrite.then(async () => {
    const users = await getUsers()
    const result = await fn(users)
    await writeJSON(dataPath('users.json'), users)
    return result
  })
  usersWrite = run.catch(() => {})
  return run
}

// ---------------------------------------------------------------- docs

/** In-memory index of meta.json for every document. */
const index = new Map()

async function loadIndex() {
  index.clear()
  const dirs = await fsp.readdir(dataPath('docs'), { withFileTypes: true })
  for (const d of dirs) {
    if (!d.isDirectory() || !isDocId(d.name)) continue
    const meta = await readJSON(docPath(d.name, 'meta.json'), null)
    if (meta) index.set(d.name, meta)
    else console.error(`[storage] document ${d.name} has no readable meta.json; its files are untouched`)
  }
}

export const listDocs = () => [...index.values()]
export const getDoc = (id) => (isDocId(id) ? index.get(id) ?? null : null)

const metaLocks = new Map()
export async function updateDoc(id, fn) {
  const prev = metaLocks.get(id) ?? Promise.resolve()
  const run = prev.then(async () => {
    const meta = index.get(id)
    if (!meta) throw new Error('not found')
    const next = { ...meta }
    await fn(next)
    await writeJSON(docPath(id, 'meta.json'), next)
    index.set(id, next)
    return next
  })
  metaLocks.set(id, run.catch(() => {}))
  return run
}

export async function createDoc({ owner, title, state }) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const meta = { id, title: title || 'Untitled document', owner, createdAt: now, updatedAt: now, trashed: false, shares: {} }
  await fsp.mkdir(docPath(id, 'history'), { recursive: true })
  await fsp.mkdir(docPath(id, 'media'), { recursive: true })
  if (state) await atomicWrite(docPath(id, 'state.bin'), state)
  await writeJSON(docPath(id, 'meta.json'), meta)
  index.set(id, meta)
  return meta
}

/** Returns the stored Yjs state, or null for a brand-new document. */
export async function readState(id) {
  try {
    return await fsp.readFile(docPath(id, 'state.bin'))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

export const writeState = (id, buf) => atomicWrite(docPath(id, 'state.bin'), buf)

export async function quarantineState(id) {
  await quarantine(docPath(id, 'state.bin'))
}

// ---------------------------------------------------------------- history
//
// Versions are stored compactly without ever discarding one:
//   - the first version of each day (or after FULL_EVERY versions) is a full copy;
//   - every other version stores only the changes since the version before it.
// Both are gzipped. Reading version N merges the nearest full copy at or before N
// with the changes after it, up to N. Yjs updates merge exactly, so the result is
// identical to the document at that moment. A periodic full copy means a damaged
// change file can only affect versions up to the next full copy.

const FULL_EVERY_MS = Number(process.env.FULL_SNAPSHOT_HOURS || 24) * 3600 * 1000
const FULL_EVERY = 300 // also start a new full copy after this many change files
const stampToMs = (t) => Date.parse(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}.${t.slice(15, 18)}Z`)

/** Version files of a doc, oldest first. */
async function versionFiles(id) {
  let files = []
  try {
    files = await fsp.readdir(docPath(id, 'history'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  return files
    .map((f) => ({ f, m: SNAP_RE.exec(f) }))
    .filter((x) => x.m)
    .map(({ f, m }) => ({ name: f, stamp: m[1], label: m[2] || '', kind: m[3] === 'delta.gz' ? 'delta' : 'full', gz: m[3] !== 'bin' }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

async function readFileData(id, v) {
  const raw = await fsp.readFile(docPath(id, 'history', v.name))
  return v.gz ? new Uint8Array(await gunzip(raw)) : new Uint8Array(raw)
}

/** Per-doc memory of the newest version, so writing one doesn't re-read the chain. */
const chainInfo = new Map() // id -> { sv, lastFullMs, deltasSinceFull }

async function loadChainInfo(id) {
  if (chainInfo.has(id)) return chainInfo.get(id)
  const files = await versionFiles(id)
  if (!files.length) return null
  const latest = files[files.length - 1]
  let lastFull = files.length - 1
  while (lastFull > 0 && files[lastFull].kind !== 'full') lastFull--
  const state = await readSnapshot(id, latest.name)
  const info = { sv: Y.encodeStateVectorFromUpdate(state), lastFullMs: stampToMs(files[lastFull].stamp), deltasSinceFull: files.length - 1 - lastFull }
  chainInfo.set(id, info)
  return info
}

/** Save a version of the document (`state` = full Yjs state). Returns its name. */
export async function writeSnapshot(id, state, label = '', { now = Date.now(), forceFull = false } = {}) {
  const safe = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  const info = await loadChainInfo(id)
  const full = forceFull || !info || now - info.lastFullMs >= FULL_EVERY_MS || info.deltasSinceFull >= FULL_EVERY
  const data = full ? state : Y.diffUpdate(state, info.sv)
  const name = `${stamp(now)}${safe ? `-${safe}` : ''}.${full ? 'full' : 'delta'}.gz`
  await writeNew(docPath(id, 'history', name), await gzip(data, { level: 9 }))
  chainInfo.set(id, { sv: Y.encodeStateVectorFromUpdate(state), lastFullMs: full ? now : info.lastFullMs, deltasSinceFull: full ? 0 : info.deltasSinceFull + 1 })
  return name
}

export async function listSnapshots(id) {
  const out = []
  for (const v of await versionFiles(id)) {
    const { size } = await fsp.stat(docPath(id, 'history', v.name))
    out.push({ name: v.name, at: new Date(stampToMs(v.stamp)).toISOString(), label: v.label.replace(/-/g, ' '), size, kind: v.kind })
  }
  return out.reverse() // newest first
}

/** The full document state at a version (rebuilt from its full copy plus later changes). */
export async function readSnapshot(id, name) {
  if (!SNAP_RE.test(name)) throw new Error('invalid snapshot')
  const files = await versionFiles(id)
  const i = files.findIndex((v) => v.name === name)
  if (i < 0) throw Object.assign(new Error('Version not found'), { code: 'ENOENT' })
  let start = i
  while (start > 0 && files[start].kind !== 'full') start--
  if (files[start].kind !== 'full') throw new Error(`No full copy before ${name}`)
  const parts = []
  for (let k = start; k <= i; k++) parts.push(await readFileData(id, files[k]))
  return Buffer.from(parts.length === 1 ? parts[0] : Y.mergeUpdates(parts))
}

/**
 * For scripts/compact-history.js only. `replaceVerified` is the one place that removes a
 * version file: it writes the compact file, checks it rebuilds the exact same document,
 * and only then removes the old uncompressed file (backed up beforehand by the tool).
 */
export const _history = {
  versionFiles,
  stampToMs,
  FULL_EVERY_MS,
  FULL_EVERY,
  async replaceVerified(id, oldName, newName, data, expectedState) {
    const file = docPath(id, 'history', newName)
    await writeNew(file, await gzip(data, { level: 9 }))
    const a = new Y.Doc({ gc: false })
    const b = new Y.Doc({ gc: false })
    Y.applyUpdate(a, expectedState)
    Y.applyUpdate(b, await readSnapshot(id, newName))
    if (!Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b)) || JSON.stringify(a.toJSON()) !== JSON.stringify(b.toJSON())) {
      await fsp.rm(file) // our own just-written file; the original is untouched
      throw new Error(`verification failed for ${oldName}`)
    }
    await fsp.rm(docPath(id, 'history', oldName))
    await fsyncDir(docPath(id, 'history'))
    chainInfo.delete(id)
  },
}

// ---------------------------------------------------------------- media

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/webm': 'weba',
  'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov',
  'application/pdf': 'pdf', 'text/plain': 'txt',
}
export const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]))

/** Stream an upload into the doc's media folder, enforcing the size limit. */
export async function saveMedia(id, mime, stream) {
  const ext = EXT[mime] || 'bin'
  const name = `${crypto.randomUUID()}.${ext}`
  const dir = docPath(id, 'media')
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${name}.tmp`)
  const fh = await fsp.open(tmp, 'wx', 0o600)
  let size = 0
  try {
    for await (const chunk of stream) {
      size += chunk.length
      if (size > config.maxUploadBytes) throw Object.assign(new Error('file too large'), { status: 413 })
      await fh.write(chunk)
    }
    await fh.sync()
  } catch (e) {
    await fh.close()
    // The only removal in this module: an incomplete temp file of a rejected upload.
    await fsp.rm(tmp, { force: true })
    throw e
  }
  await fh.close()
  await fsp.rename(tmp, path.join(dir, name))
  return { name, size }
}

export function mediaFile(id, name) {
  if (!isMediaName(name)) return null
  return docPath(id, 'media', name)
}

export async function copyMedia(fromId, toId) {
  const src = docPath(fromId, 'media')
  const dest = docPath(toId, 'media')
  let files = []
  try {
    files = await fsp.readdir(src)
  } catch {
    return
  }
  for (const f of files) {
    if (isMediaName(f)) await fsp.copyFile(path.join(src, f), path.join(dest, f), fs.constants.COPYFILE_EXCL)
  }
}
