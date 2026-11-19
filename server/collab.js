/**
 * Real-time collaboration over WebSockets using the Yjs sync + awareness
 * protocols. One Room per open document holds the authoritative Y.Doc in
 * memory and persists it to disk (debounced) plus periodic history snapshots.
 *
 * Extra message types on top of the standard y-websocket protocol:
 *   FLUSH (client -> server, seq): "persist everything you have received from me"
 *   ACK   (server -> client, seq): "everything up to seq is safely on disk"
 * The client uses these to show an honest "Saved" indicator.
 */
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocketServer } from 'ws'
import { config } from './config.js'
import * as storage from './storage.js'
import { userFromRequest } from './auth.js'
import { roleFor } from './permissions.js'
import { checkOrigin, originError } from './origin.js'
import { needsRepair, repairScript } from './script.js'

/**
 * Browsers running older app code don't know the script node types and would
 * delete them from the shared document. They are refused until they reload.
 */
export const PROTOCOL_VERSION = 3 // 3: checklists

const MSG_SYNC = 0
const MSG_AWARENESS = 1
const MSG_FLUSH = 7
const MSG_ACK = 8

const rooms = new Map()

class Room {
  constructor(id) {
    this.id = id
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null)
    this.conns = new Map() // ws -> { role, clientIds:Set }
    this.dirty = false
    this.changedSinceSnapshot = false
    this.lastSnapshotAt = 0
    this.saveTimer = null
    this.saving = Promise.resolve()
    this.closed = false
  }

  async load() {
    const state = await storage.readState(this.id)
    if (state) {
      try {
        Y.applyUpdate(this.doc, state)
      } catch (e) {
        // Keep the unreadable file, recover from the latest snapshot.
        console.error(`[collab] state for ${this.id} is unreadable:`, e.message)
        await storage.quarantineState(this.id)
        const [latest] = await storage.listSnapshots(this.id)
        if (latest) Y.applyUpdate(this.doc, await storage.readSnapshot(this.id, latest.name))
        this.dirty = true
      }
    }
    const [latest] = await storage.listSnapshots(this.id)
    this.lastSnapshotAt = latest ? Date.parse(latest.at) : 0
    if (!latest && state) this.changedSinceSnapshot = true

    // Older free-form documents become scripts. Keep the original as a version first.
    if (needsRepair(this.doc)) {
      if (state) await storage.writeSnapshot(this.id, Y.encodeStateAsUpdate(this.doc), 'before script conversion')
      repairScript(this.doc)
      await storage.writeState(this.id, Y.encodeStateAsUpdate(this.doc))
    }

    this.doc.on('update', (update, origin) => {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeUpdate(enc, update)
      this.broadcast(encoding.toUint8Array(enc), origin)
      this.dirty = true
      this.changedSinceSnapshot = true
      this.scheduleSave()
      if (origin !== 'repair') this.scheduleRepair()
    })

    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const meta = this.conns.get(origin)
      if (meta) {
        for (const id of added) meta.clientIds.add(id)
        for (const id of removed) meta.clientIds.delete(id)
      }
      const changed = added.concat(updated, removed)
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_AWARENESS)
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed))
      this.broadcast(encoding.toUint8Array(enc))
    })
  }

  broadcast(msg, except) {
    for (const ws of this.conns.keys()) if (ws !== except) send(ws, msg)
  }

  /** Stray text (e.g. from an old offline copy) is wrapped into beats shortly after it arrives. */
  scheduleRepair() {
    clearTimeout(this.repairTimer)
    this.repairTimer = setTimeout(() => {
      if (!this.closed && needsRepair(this.doc)) repairScript(this.doc)
    }, 400)
  }

  scheduleSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), config.saveDebounceMs)
  }

  /** Serialised: concurrent calls queue up behind each other. */
  save({ snapshot = false } = {}) {
    clearTimeout(this.saveTimer)
    const run = this.saving.then(async () => {
      if (this.dirty) {
        this.dirty = false
        try {
          await storage.writeState(this.id, Y.encodeStateAsUpdate(this.doc))
        } catch (e) {
          this.dirty = true
          console.error(`[collab] failed to save ${this.id}:`, e)
          this.scheduleSave()
          throw e
        }
        const title = String(this.doc.getMap('meta').get('title') || '').slice(0, 200) || 'Untitled document'
        await storage.updateDoc(this.id, (m) => {
          m.title = title
          m.updatedAt = new Date().toISOString()
        })
      }
      const due = Date.now() - this.lastSnapshotAt >= config.snapshotIntervalMs
      if (this.changedSinceSnapshot && (snapshot || due)) {
        await storage.writeSnapshot(this.id, Y.encodeStateAsUpdate(this.doc))
        this.lastSnapshotAt = Date.now()
        this.changedSinceSnapshot = false
      }
    })
    this.saving = run.catch(() => {})
    return run
  }

  async snapshotNow(label) {
    await this.save()
    const name = await storage.writeSnapshot(this.id, Y.encodeStateAsUpdate(this.doc), label)
    this.lastSnapshotAt = Date.now()
    this.changedSinceSnapshot = false
    return name
  }

  join(ws, role) {
    this.conns.set(ws, { role, clientIds: new Set() })

    ws.on('message', (data) => {
      try {
        this.onMessage(ws, new Uint8Array(data))
      } catch (e) {
        console.error('[collab] bad message:', e.message)
        ws.close(1003, 'bad message')
      }
    })
    ws.on('close', () => this.leave(ws))

    // Server initiates: send our state vector so the client sends what we lack.
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, this.doc)
    send(ws, encoding.toUint8Array(enc))

    const states = this.awareness.getStates()
    if (states.size > 0) {
      const a = encoding.createEncoder()
      encoding.writeVarUint(a, MSG_AWARENESS)
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]))
      send(ws, encoding.toUint8Array(a))
    }
  }

  onMessage(ws, data) {
    const meta = this.conns.get(ws)
    if (!meta) return
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      const sub = decoding.readVarUint(decoder)
      if (sub === syncProtocol.messageYjsSyncStep1) {
        syncProtocol.readSyncStep1(decoder, enc, this.doc)
      } else if (meta.role === 'viewer') {
        // Read-only collaborators: their document changes are ignored server-side.
        return
      } else {
        syncProtocol.readUpdate(decoder, this.doc, ws)
      }
      if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc))
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws)
    } else if (type === MSG_FLUSH) {
      const seq = decoding.readVarUint(decoder)
      this.save().then(
        () => {
          const enc = encoding.createEncoder()
          encoding.writeVarUint(enc, MSG_ACK)
          encoding.writeVarUint(enc, seq)
          send(ws, encoding.toUint8Array(enc))
        },
        () => {}, // not acked: the client keeps showing "saving" and retries
      )
    }
  }

  leave(ws) {
    const meta = this.conns.get(ws)
    if (!meta) return
    this.conns.delete(ws)
    awarenessProtocol.removeAwarenessStates(this.awareness, [...meta.clientIds], null)
    if (this.conns.size === 0) {
      this.save({ snapshot: true }).finally(() => {
        if (this.conns.size === 0 && !this.closed) {
          this.closed = true
          rooms.delete(this.id)
          this.awareness.destroy()
          this.doc.destroy()
        }
      })
    }
  }

  /** Drop connections of users who lost access (e.g. unshared). */
  revoke(username) {
    for (const [ws, m] of this.conns) if (m.username === username) ws.close(4403, 'access revoked')
  }
}

function send(ws, msg) {
  if (ws.readyState !== ws.OPEN) return
  ws.send(msg, (err) => err && ws.close())
}

const loading = new Map()
export async function getRoom(id) {
  if (rooms.has(id)) return rooms.get(id)
  if (!loading.has(id)) {
    loading.set(
      id,
      (async () => {
        const room = new Room(id)
        await room.load()
        rooms.set(id, room)
        return room
      })().finally(() => loading.delete(id)),
    )
  }
  return loading.get(id)
}

/** Current state of a doc, from memory if open, else from disk. */
export async function currentState(id) {
  const room = rooms.get(id)
  if (room) return Y.encodeStateAsUpdate(room.doc)
  return storage.readState(id)
}

export const openRoom = (id) => rooms.get(id)

export function attachCollab(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })

  server.on('upgrade', async (req, socket, head) => {
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
    try {
      const url = new URL(req.url, 'http://x')
      const m = /^\/ws\/([a-f0-9-]{36})$/.exec(url.pathname)
      if (!m) return reject(404, 'Not Found')
      // Same-origin only: browsers always send Origin on WebSocket requests.
      const o = checkOrigin(req)
      if (!o.ok) {
        console.warn(`[collab] ${originError(o)}`)
        return reject(403, 'Forbidden')
      }
      const user = await userFromRequest(req)
      if (!user) return reject(401, 'Unauthorized')
      const meta = storage.getDoc(m[1])
      const role = meta && roleFor(meta, user.username)
      if (!role) return reject(403, 'Forbidden')
      const room = await getRoom(m[1])
      const version = Number(url.searchParams.get('v') || 0)
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (version < PROTOCOL_VERSION) return ws.close(4426, 'reload required')
        ws.isAlive = true
        ws.on('pong', () => (ws.isAlive = true))
        room.join(ws, role === 'viewer' ? 'viewer' : 'editor')
        room.conns.get(ws).username = user.username
      })
    } catch (e) {
      console.error('[collab] upgrade failed:', e)
      reject(500, 'Internal Server Error')
    }
  })

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, 30000)
  wss.on('close', () => clearInterval(ping))
  return wss
}

/** Persist every open document (used on shutdown). */
export async function saveAll() {
  await Promise.allSettled([...rooms.values()].map((r) => r.save({ snapshot: true })))
}
