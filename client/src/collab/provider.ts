/**
 * WebSocket provider for Yjs, talking to server/collab.js.
 * Standard Yjs sync + awareness messages, plus FLUSH/ACK so "Saved" only
 * appears once the server has written our changes to disk.
 */
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const MSG_SYNC = 0
const MSG_AWARENESS = 1
const MSG_FLUSH = 7
const MSG_ACK = 8

/** Must match the server; bumped whenever the document structure changes. */
export const PROTOCOL_VERSION = 3 // 3: checklists

export type SaveStatus = 'connecting' | 'saving' | 'saved' | 'offline' | 'denied' | 'outdated'

export class SyncProvider {
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  status: SaveStatus = 'connecting'
  synced = false
  private url: string
  private ws: WebSocket | null = null
  private sentSeq = 0
  private ackedSeq = 0
  private flushTimer: number | undefined
  private retry = 0
  private retryTimer: number | undefined
  private destroyed = false
  private listeners = new Set<(s: SaveStatus) => void>()
  private syncListeners = new Set<() => void>()

  constructor(url: string, doc: Y.Doc) {
    this.url = url
    this.doc = doc
    this.awareness = new awarenessProtocol.Awareness(doc)
    doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
    window.addEventListener('beforeunload', this.onUnload)
    window.addEventListener('online', this.reconnectNow)
    this.connect()
  }

  onStatus(fn: (s: SaveStatus) => void) {
    this.listeners.add(fn)
    fn(this.status)
    return () => this.listeners.delete(fn)
  }
  onSynced(fn: () => void) {
    if (this.synced) fn()
    else this.syncListeners.add(fn)
  }

  get hasUnsaved() {
    return this.sentSeq > this.ackedSeq
  }

  private setStatus(s: SaveStatus) {
    if (this.status === s) return
    this.status = s
    this.listeners.forEach((f) => f(s))
  }

  private refreshStatus() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (!this.synced) this.setStatus('connecting')
    else this.setStatus(this.hasUnsaved ? 'saving' : 'saved')
  }

  private connect() {
    if (this.destroyed) return
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.synced = false
    this.setStatus(this.retry === 0 ? 'connecting' : 'offline')

    ws.onopen = () => {
      this.retry = 0
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeSyncStep1(enc, this.doc)
      ws.send(encoding.toUint8Array(enc))
      if (this.awareness.getLocalState() !== null) {
        const a = encoding.createEncoder()
        encoding.writeVarUint(a, MSG_AWARENESS)
        encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
        ws.send(encoding.toUint8Array(a))
      }
      this.refreshStatus()
    }

    ws.onmessage = (ev) => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer))
      const type = decoding.readVarUint(dec)
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, MSG_SYNC)
        const sub = syncProtocol.readSyncMessage(dec, enc, this.doc, this)
        if (encoding.length(enc) > 1) {
          // We answered the server's step 1 with everything it lacks (e.g. offline edits).
          ws.send(encoding.toUint8Array(enc))
          this.markSent()
        }
        if (sub === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true
          this.syncListeners.forEach((f) => f())
          this.syncListeners.clear()
        }
        this.refreshStatus()
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this)
      } else if (type === MSG_ACK) {
        this.ackedSeq = Math.max(this.ackedSeq, decoding.readVarUint(dec))
        this.refreshStatus()
      }
    }

    ws.onclose = (ev) => {
      this.ws = null
      this.synced = false
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID),
        this,
      )
      if (this.destroyed) return
      if (ev.code === 4403) return this.setStatus('denied')
      if (ev.code === 4426) return this.setStatus('outdated')
      this.setStatus('offline')
      // Unacked changes are re-sent automatically by the sync handshake on reconnect.
      const delay = Math.min(10000, 500 * 2 ** this.retry++)
      this.retryTimer = window.setTimeout(() => this.connect(), delay)
    }
  }

  private reconnectNow = () => {
    if (this.ws || this.destroyed) return
    clearTimeout(this.retryTimer)
    this.connect()
  }

  private markSent() {
    this.sentSeq++
    this.refreshStatus()
    clearTimeout(this.flushTimer)
    this.flushTimer = window.setTimeout(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_FLUSH)
      encoding.writeVarUint(enc, this.sentSeq)
      this.ws.send(encoding.toUint8Array(enc))
    }, 300)
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Kept locally (memory + IndexedDB) and sent when we reconnect.
      this.sentSeq = Math.max(this.sentSeq, this.ackedSeq + 1)
      return
    }
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeUpdate(enc, update)
    this.ws.send(encoding.toUint8Array(enc))
    this.markSent()
  }

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === this || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const changed = added.concat(updated, removed)
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed))
    this.ws.send(encoding.toUint8Array(enc))
  }

  private onUnload = (e: BeforeUnloadEvent) => {
    if (this.hasUnsaved) {
      e.preventDefault()
      e.returnValue = ''
    }
  }

  destroy() {
    this.destroyed = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.flushTimer)
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy')
    window.removeEventListener('beforeunload', this.onUnload)
    window.removeEventListener('online', this.reconnectNow)
    this.doc.off('update', this.onDocUpdate)
    this.awareness.destroy()
    this.ws?.close()
  }
}
