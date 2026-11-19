import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { PROTOCOL_VERSION } from '../collab.js'
import WebSocket from 'ws'
import http from 'node:http'
import * as script from '../script.js'

const root = path.resolve(import.meta.dirname, '../..')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidescript-test-'))
const port = 40000 + Math.floor(Math.random() * 10000)
const base = `http://127.0.0.1:${port}`
let proc

function startServer() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SAVE_DEBOUNCE_MS: '50', NODE_ENV: 'test', CITE_ALLOW_PRIVATE: '1', SETUP_CODE: 'test-setup-code' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve) => proc.stdout.on('data', (d) => d.toString().includes('running') && resolve()))
}
const stopServer = () => new Promise((r) => (proc.once('exit', r), proc.kill('SIGTERM')))

const cookies = {}
async function api(who, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-sidescript': '1', cookie: cookies[who] || '' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const set = res.headers.get('set-cookie')
  if (set) cookies[who] = set.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** Minimal Yjs client speaking the same protocol as the browser provider. */
function connect(who, docId, version = PROTOCOL_VERSION) {
  const doc = new Y.Doc()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${docId}?v=${version}`, { headers: { cookie: cookies[who] } })
  ws.binaryType = 'arraybuffer'
  const acks = []
  let synced
  const syncedP = new Promise((r) => (synced = r))
  ws.on('message', (data) => {
    const dec = decoding.createDecoder(new Uint8Array(data))
    const type = decoding.readVarUint(dec)
    if (type === 0) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, 0)
      const sub = syncProtocol.readSyncMessage(dec, enc, doc, 'remote')
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc))
      if (sub === 0) {
        const e2 = encoding.createEncoder()
        encoding.writeVarUint(e2, 0)
        syncProtocol.writeSyncStep1(e2, doc)
        ws.send(encoding.toUint8Array(e2))
      }
      if (sub === 1) synced()
    } else if (type === 8) acks.push(decoding.readVarUint(dec))
  })
  doc.on('update', (u, origin) => {
    if (origin === 'remote') return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0)
    syncProtocol.writeUpdate(enc, u)
    ws.send(encoding.toUint8Array(enc))
  })
  const flush = (seq) =>
    new Promise((resolve) => {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, 7)
      encoding.writeVarUint(enc, seq)
      ws.send(encoding.toUint8Array(enc))
      const t = setInterval(() => acks.includes(seq) && (clearInterval(t), resolve()), 10)
    })
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('unexpected-response', (_, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    ws.on('error', reject)
  })
  const closed = new Promise((r) => ws.on('close', (code) => r(code)))
  return { doc, ws, opened, synced: syncedP, flush, closed, close: () => ws.close() }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let docId

before(startServer)
after(async () => {
  await stopServer()
  fs.rmSync(dataDir, { recursive: true, force: true }) // test temp dir only
})

test('first-run setup creates an admin and refuses a second setup', async () => {
  const s = await api('alice', 'GET', '/api/status')
  assert.equal(s.body.needsSetup, true)
  const noCode = await api('mallory', 'POST', '/api/setup', { username: 'mallory', password: 'correct-horse-1' })
  assert.equal(noCode.status, 403)
  const wrong = await api('mallory', 'POST', '/api/setup', { setupCode: 'guess', username: 'mallory', password: 'correct-horse-1' })
  assert.equal(wrong.status, 403)
  assert.equal((await api('alice', 'GET', '/api/status')).body.needsSetup, true)
  const r = await api('alice', 'POST', '/api/setup', { setupCode: 'TEST-SETUP-CODE', username: 'alice', password: 'correct-horse-1', displayName: 'Alice' })
  assert.equal(r.status, 200)
  const again = await api('mallory', 'POST', '/api/setup', { setupCode: 'test-setup-code', username: 'mallory', password: 'correct-horse-1' })
  assert.equal(again.status, 409)
  assert.equal((await api('alice', 'POST', '/api/users', { username: 'bob', password: 'bob-password-1' })).status, 201)
  assert.equal((await api('bob', 'POST', '/api/login', { username: 'bob', password: 'bob-password-1' })).status, 200)
})

test('sign-in lockout is per visitor behind a proxy, not for everyone', async () => {
  const login = (ip, password) =>
    fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sidescript': '1', 'x-forwarded-for': ip },
      body: JSON.stringify({ username: 'bob', password }),
    }).then((r) => r.status)
  for (let i = 0; i < 10; i++) assert.equal(await login('203.0.113.7', 'wrong-password'), 401)
  assert.equal(await login('203.0.113.7', 'bob-password-1'), 429)
  // A spoofed left-most entry doesn't dodge the limit: the proxy-appended address is used.
  assert.equal(await login('198.51.100.1, 203.0.113.7', 'bob-password-1'), 429)
  // Someone else, through the same proxy, can still sign in.
  assert.equal(await login('203.0.113.8', 'bob-password-1'), 200)
})

test('requests without the CSRF header or session are refused', async () => {
  const res = await fetch(base + '/api/docs', { method: 'POST', headers: { cookie: cookies.alice } })
  assert.equal(res.status, 403)
  assert.equal((await api('nobody', 'GET', '/api/docs')).status, 401)
  const bot = await fetch(base + '/', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.0)' } })
  assert.equal(bot.status, 403)
  const home = await fetch(base + '/robots.txt')
  assert.match(home.headers.get('x-robots-tag'), /noai/)
})

test('origin check works behind proxies but still blocks other sites', async () => {
  const post = (headers) =>
    fetch(base + '/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-sidescript': '1', cookie: cookies.alice, ...headers }, body: '{}' })
  // Same host
  assert.equal((await post({ origin: base })).status, 200)
  // Proxy rewrote Host but passed X-Forwarded-Host (Vite dev proxy, nginx default + forwarded header)
  assert.equal((await post({ origin: 'https://docs.example.com', 'x-forwarded-host': 'docs.example.com' })).status, 200)
  // A different website
  const evil = await post({ origin: 'https://evil.example' })
  assert.equal(evil.status, 403)
  assert.match((await evil.json()).error, /ALLOWED_ORIGINS/)
  // WebSocket from another site is refused
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/00000000-0000-0000-0000-000000000000`, { headers: { cookie: cookies.alice, origin: 'https://evil.example' } })
  const code = await new Promise((r) => ws.on('unexpected-response', (_, res) => r(res.statusCode)))
  assert.equal(code, 403)
})

const structure = (doc) =>
  doc
    .getXmlFragment('default')
    .toArray()
    .map((s) => [s.nodeName, ...s.toArray().map((c) => (c.nodeName === 'beat' ? `beat:${c.toArray().map((p) => p.nodeName).join('+')}` : c.nodeName))])

test('new documents are scripts: one section with one beat, plus the field key', async () => {
  const r = await api('alice', 'POST', '/api/docs', { title: 'New script' })
  const c = connect('alice', r.body.doc.id)
  await c.opened
  await c.synced
  assert.deepEqual(structure(c.doc), [['section', 'sectionTitle', 'beat:paragraph']])
  assert.deepEqual(c.doc.getMap('fields').get('list').map((f) => f.id), ['visual', 'scene', 'status'])
  c.close()
})

test('saved default fields and section colour are used for new documents (and validated)', async () => {
  const fields = [
    { id: 'visual', name: 'Shot', type: 'visual', options: [{ id: 'cu', label: 'Close-up', color: '#ff0000' }] },
    { id: 'status', name: 'Status', type: 'select', options: [{ id: 'done', label: 'done', color: 'not-a-colour' }] },
  ]
  assert.equal((await api('alice', 'PUT', '/api/me/prefs', { fields, sectionColor: '#123456' })).status, 200)
  assert.equal((await api('alice', 'PUT', '/api/me/prefs', { sectionColor: 'red; background:url(x)' })).status, 400)
  const r = await api('alice', 'POST', '/api/docs', { title: 'From defaults' })
  const c = connect('alice', r.body.doc.id)
  await c.opened
  await c.synced
  const list = c.doc.getMap('fields').get('list')
  assert.equal(list[0].name, 'Shot')
  assert.equal(list[1].options[0].color, '#94a3b8') // invalid colour replaced
  assert.equal(c.doc.getMap('fields').get('sectionColor'), '#123456')
  c.close()
  await api('alice', 'PUT', '/api/me/prefs', { fields: script.DEFAULT_FIELDS, sectionColor: null })
})

test('browsers running old app code are refused (they would drop unknown nodes)', async () => {
  const r = await api('alice', 'POST', '/api/docs', { title: 'Gate' })
  const c = connect('alice', r.body.doc.id, 0)
  assert.equal(await c.closed, 4426)
})

test('old free-form documents are converted to scripts, keeping every word and a backup version', () => {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('default')
  const p = (t) => {
    const e = new Y.XmlElement('paragraph')
    e.insert(0, [new Y.XmlText(t)])
    return e
  }
  const h = (t) => {
    const e = new Y.XmlElement('heading')
    e.setAttribute('level', 2)
    e.insert(0, [new Y.XmlText(t)])
    return e
  }
  const list = new Y.XmlElement('bulletList')
  frag.insert(0, [p('Intro line'), h('Act I'), p('First beat'), list, p('Second beat'), h('Act II'), p('Third beat')])
  const textBefore = frag.toString().replace(/<[^>]+>/g, '')
  assert.ok(script.needsRepair(doc))
  script.repairScript(doc)
  assert.ok(!script.needsRepair(doc))
  assert.deepEqual(structure(doc), [
    ['section', 'sectionTitle', 'beat:paragraph'],
    ['section', 'sectionTitle', 'beat:paragraph+bulletList', 'beat:paragraph'],
    ['section', 'sectionTitle', 'beat:paragraph'],
  ])
  assert.equal(frag.toString().replace(/<[^>]+>/g, ''), textBefore) // no text lost or duplicated
  // Stray text inside a section (e.g. from an old offline copy) is wrapped, not dropped.
  const sec = frag.get(0)
  sec.insert(1, [p('stray')])
  script.repairScript(doc)
  assert.deepEqual(structure(doc)[0], ['section', 'sectionTitle', 'beat:paragraph', 'beat:paragraph'])
  assert.match(frag.toString(), /stray/)
})

test('an old document opened on the server is converted once, after saving a version', async () => {
  const old = new Y.Doc()
  const para = new Y.XmlElement('paragraph')
  para.insert(0, [new Y.XmlText('legacy words')])
  old.getXmlFragment('default').insert(0, [para])
  const r = await api('alice', 'POST', '/api/docs', { title: 'Legacy', state: Buffer.from(Y.encodeStateAsUpdate(old)).toString('base64') })
  const c = connect('alice', r.body.doc.id)
  await c.opened
  await c.synced
  assert.deepEqual(structure(c.doc), [['section', 'sectionTitle', 'beat:paragraph']])
  assert.match(c.doc.getXmlFragment('default').toString(), /legacy words/)
  const v = await api('alice', 'GET', `/api/docs/${r.body.doc.id}/history`)
  assert.ok(v.body.versions.some((x) => x.label === 'before script conversion'))
  c.close()
})

test('new documents are seeded with the default highlight key', async () => {
  const r = await api('alice', 'POST', '/api/docs', { title: 'Script' })
  assert.equal(r.status, 201)
  docId = r.body.doc.id
  const c = connect('alice', docId)
  await c.opened
  await c.synced
  assert.deepEqual([...c.doc.getMap('categories').keys()].sort(), ['ideas', 'overlay', 'sources'])
  c.close()
})

test('edits sync between collaborators and are acknowledged only once on disk', async () => {
  await api('alice', 'PUT', `/api/docs/${docId}/shares`, { username: 'bob', role: 'editor' })
  const a = connect('alice', docId)
  const b = connect('bob', docId)
  await Promise.all([a.opened, b.opened, a.synced, b.synced])
  a.doc.getText('t').insert(0, 'hello ')
  b.doc.getText('t').insert(0, 'world')
  await wait(150)
  assert.equal(a.doc.getText('t').toString(), b.doc.getText('t').toString())
  await a.flush(1)
  const onDisk = new Y.Doc()
  Y.applyUpdate(onDisk, fs.readFileSync(path.join(dataDir, 'docs', docId, 'state.bin')))
  assert.equal(onDisk.getText('t').toString(), a.doc.getText('t').toString())
  a.close()
  b.close()
})

test('viewers can read but their edits are ignored', async () => {
  await api('alice', 'PUT', `/api/docs/${docId}/shares`, { username: 'bob', role: 'viewer' })
  const b = connect('bob', docId)
  await b.opened
  await b.synced
  const before = b.doc.getText('t').toString()
  assert.ok(before.length > 0)
  b.doc.getText('t').insert(0, 'VANDALISM ')
  await b.flush(1)
  const a = connect('alice', docId)
  await a.opened
  await a.synced
  assert.equal(a.doc.getText('t').toString(), before)
  a.close()
  b.close()
})

test('trash keeps every file; duplicate copies content', async () => {
  await wait(200)
  const files = fs.readdirSync(path.join(dataDir, 'docs', docId))
  const t = await api('alice', 'PATCH', `/api/docs/${docId}`, { trashed: true })
  assert.equal(t.body.doc.trashed, true)
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'docs', docId)), files)
  assert.ok(fs.existsSync(path.join(dataDir, 'docs', docId, 'state.bin')))
  assert.equal((await api('bob', 'PATCH', `/api/docs/${docId}`, { trashed: false })).status, 403)

  const d = await api('alice', 'POST', `/api/docs/${docId}/duplicate`)
  assert.equal(d.status, 201)
  const copy = new Y.Doc()
  Y.applyUpdate(copy, fs.readFileSync(path.join(dataDir, 'docs', d.body.doc.id, 'state.bin')))
  assert.match(copy.getText('t').toString(), /hello|world/)
  assert.equal(copy.getMap('meta').get('title'), 'Copy of Script')
})

test('media uploads are stored, range-served, sandboxed and permission-checked', async () => {
  const body = Buffer.from('0123456789abcdef')
  const up = await fetch(`${base}/api/docs/${docId}/media`, { method: 'POST', headers: { 'content-type': 'audio/mpeg', 'x-sidescript': '1', cookie: cookies.alice }, body })
  assert.equal(up.status, 201)
  const { url } = await up.json()
  const part = await fetch(base + url, { headers: { cookie: cookies.alice, range: 'bytes=4-7' } })
  assert.equal(part.status, 206)
  assert.equal(await part.text(), '4567')
  assert.match(part.headers.get('content-security-policy'), /sandbox/)
  const stranger = await fetch(base + url, { headers: { cookie: '' } })
  assert.equal(stranger.status, 401)
  const viewerUpload = await fetch(`${base}/api/docs/${docId}/media`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-sidescript': '1', cookie: cookies.bob }, body })
  assert.equal(viewerUpload.status, 403)
  const traversal = await fetch(`${base}/api/docs/${docId}/media/..%2F..%2Fusers.json`, { headers: { cookie: cookies.alice } })
  assert.equal(traversal.status, 404)
})

test('pasting a link embeds it: files are copied locally, pages become link cards; viewers cannot', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
  const site = http.createServer((req, res) => {
    if (req.url === '/still.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(png)
    if (req.url === '/clip.mp4') return res.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.alloc(2048, 1))
    res.writeHead(200, { 'content-type': 'text/html' }).end('<head><title>Story | Site</title><meta property="og:site_name" content="Site"><meta property="og:image" content="/still.png"><meta name="author" content="Ana Ruiz"><meta property="article:published_time" content="2021-05-01"></head>')
  })
  await new Promise((r) => site.listen(0, '127.0.0.1', r))
  const at = (path) => `http://127.0.0.1:${site.address().port}${path}`
  const r = await api('alice', 'POST', '/api/docs', { title: 'Embeds' })
  const id = r.body.doc.id
  try {
    const img = (await api('alice', 'POST', `/api/docs/${id}/embed`, { url: at('/still.png') })).body.attachment
    assert.equal(img.type, 'image/png')
    assert.match(img.url, new RegExp(`^/api/docs/${id}/media/`)) // served from our server, not the original site
    const local = await fetch(base + img.url, { headers: { cookie: cookies.alice } })
    assert.deepEqual(Buffer.from(await local.arrayBuffer()), png)
    const vid = (await api('alice', 'POST', `/api/docs/${id}/embed`, { url: at('/clip.mp4') })).body.attachment
    assert.equal(vid.type, 'video/mp4')
    const card = (await api('alice', 'POST', `/api/docs/${id}/embed`, { url: at('/article') })).body.attachment
    assert.equal(card.type, 'link')
    assert.equal(card.title, 'Story')
    assert.equal(card.site, 'Site')
    assert.equal(card.author, 'Ana Ruiz')
    assert.equal(card.date, '2021')
    assert.match(card.thumb, /^\/api\/docs\//) // preview image stored locally too
    await api('bob', 'POST', '/api/login', { username: 'bob', password: 'bob-password-1' })
    await api('alice', 'PUT', `/api/docs/${id}/shares`, { username: 'bob', role: 'viewer' })
    assert.equal((await api('bob', 'POST', `/api/docs/${id}/embed`, { url: at('/still.png') })).status, 403)
  } finally {
    site.close()
  }
})

test('history snapshots are written when everyone leaves, and survive restart', async () => {
  const v = await api('alice', 'GET', `/api/docs/${docId}/history`)
  assert.ok(v.body.versions.length >= 1)
  await stopServer()
  await startServer()
  await api('alice', 'POST', '/api/login', { username: 'alice', password: 'correct-horse-1' })
  const c = connect('alice', docId)
  await c.opened
  await c.synced
  assert.match(c.doc.getText('t').toString(), /hello/)
  c.close()
})
