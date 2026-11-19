/**
 * Shared state for the script node views: the Yjs maps that hold beat data,
 * plus local (per-browser) UI state such as which folders are collapsed.
 * Node views are plain DOM (no React) so 100+ beats stay cheap.
 */
import * as Y from 'yjs'
import { getFieldList, type FieldDef } from './fields'

type Listener = () => void

/**
 * Origin tag for this user's own data edits (beat fields, field key). The editor's
 * undo manager tracks it, so Ctrl+Z undoes data changes alongside text changes.
 * Other people's changes arrive with other origins and are never undone.
 */
export const DATA_ORIGIN = 'sidescript-data'

export interface ScriptContext {
  docId: string
  canEdit: boolean
  /** True once the script has loaded; beats created after that are drawn immediately. */
  ready: boolean
  beats: Y.Map<Y.Map<any>>
  sections: Y.Map<any>
  fields: Y.Map<any>
  fieldList: () => FieldDef[]
  /** Subscribe to one beat's data; returns unsubscribe. */
  onBeat: (id: string, fn: Listener) => () => void
  onFields: (fn: Listener) => () => void
  onSections: (fn: Listener) => () => void
  getValue: (beatId: string, fieldId: string) => any
  setValue: (beatId: string, fieldId: string, value: any) => void
  /** Run a data edit as one undoable step. */
  transact: (fn: () => void) => void
  copyBeat: (fromId: string, toId: string) => void
  collapsed: CollapseStore
  /** Beats picked for bulk editing (local to this browser). */
  selection: SelectionStore
  /** Beat ids in document order (provided by the editor). */
  order: () => string[]
  setOrder: (fn: () => string[]) => void
  /** Set one field on many beats in a single change. `value` may depend on the beat's position. */
  setMany: (ids: string[], fieldId: string, value: (index: number, current: any) => any) => void
  upload: (file: File) => Promise<{ url: string; thumb?: string }>
}

export class CollapseStore {
  private set: Set<string>
  private listeners = new Map<string, Set<Listener>>()
  private key: string
  constructor(docId: string) {
    this.key = `sidescript:collapsed:${docId}`
    let saved: string[] = []
    try {
      saved = JSON.parse(localStorage.getItem(this.key) || '[]')
    } catch {
      /* ignore */
    }
    this.set = new Set(saved)
  }
  has = (id: string) => this.set.has(id)
  toggle = (id: string, value = !this.set.has(id)) => {
    if (value) this.set.add(id)
    else this.set.delete(id)
    try {
      localStorage.setItem(this.key, JSON.stringify([...this.set]))
    } catch {
      /* ignore */
    }
    this.listeners.get(id)?.forEach((f) => f())
    this.listeners.get('*')?.forEach((f) => f())
  }
  setMany = (ids: string[], value: boolean) => ids.forEach((id) => this.toggle(id, value))
  on = (id: string, fn: Listener) => {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set())
    this.listeners.get(id)!.add(fn)
    return () => this.listeners.get(id)?.delete(fn)
  }
}

export class SelectionStore {
  private ids = new Set<string>()
  private anchor: string | null = null
  private listeners = new Set<Listener>()
  version = 0
  constructor(private order: () => string[]) {}
  has = (id: string) => this.ids.has(id)
  get size() {
    return this.ids.size
  }
  /** Selected ids in document order. */
  list = () => this.order().filter((id) => this.ids.has(id))
  private emit() {
    this.version++
    this.listeners.forEach((f) => f())
  }
  toggle = (id: string) => {
    if (this.ids.has(id)) this.ids.delete(id)
    else this.ids.add(id)
    this.anchor = id
    this.emit()
  }
  /** Shift-click: select everything between the last clicked beat and this one. */
  range = (id: string) => {
    const order = this.order()
    const a = this.anchor ? order.indexOf(this.anchor) : -1
    const b = order.indexOf(id)
    if (a < 0 || b < 0) return this.toggle(id)
    for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) this.ids.add(x)
    this.anchor = id
    this.emit()
  }
  set = (ids: string[]) => {
    this.ids = new Set(ids)
    this.anchor = ids[ids.length - 1] ?? null
    this.emit()
  }
  clear = () => {
    if (!this.ids.size) return
    this.ids.clear()
    this.anchor = null
    this.emit()
  }
  on = (fn: Listener) => (this.listeners.add(fn), () => this.listeners.delete(fn))
}

export function createScriptContext(doc: Y.Doc, opts: { docId: string; canEdit: boolean; upload: ScriptContext['upload'] }): ScriptContext {
  const beats = doc.getMap<Y.Map<any>>('beats')
  const sections = doc.getMap<any>('sections')
  const fields = doc.getMap<any>('fields')
  const beatListeners = new Map<string, Set<Listener>>()
  const fieldListeners = new Set<Listener>()
  const sectionListeners = new Set<Listener>()

  // One deep observer for all beats; route changes to the affected beat views only.
  beats.observeDeep((events) => {
    const ids = new Set<string>()
    for (const e of events) {
      if (e.target === beats) e.changes.keys.forEach((_, k) => ids.add(k))
      else if (typeof e.path[0] === 'string') ids.add(e.path[0])
    }
    ids.forEach((id) => beatListeners.get(id)?.forEach((f) => f()))
  })
  fields.observe(() => fieldListeners.forEach((f) => f()))
  sections.observe(() => sectionListeners.forEach((f) => f()))

  const ensure = (id: string) => {
    let m = beats.get(id)
    if (!m) {
      m = new Y.Map()
      beats.set(id, m)
    }
    return m
  }

  let orderFn: () => string[] = () => []
  const order = () => orderFn()

  return {
    docId: opts.docId,
    canEdit: opts.canEdit,
    ready: false,
    beats,
    sections,
    fields,
    fieldList: () => getFieldList(fields),
    onBeat: (id, fn) => {
      if (!beatListeners.has(id)) beatListeners.set(id, new Set())
      beatListeners.get(id)!.add(fn)
      return () => beatListeners.get(id)?.delete(fn)
    },
    onFields: (fn) => (fieldListeners.add(fn), () => fieldListeners.delete(fn)),
    onSections: (fn) => (sectionListeners.add(fn), () => sectionListeners.delete(fn)),
    getValue: (beatId, fieldId) => beats.get(beatId)?.get(fieldId),
    setValue: (beatId, fieldId, value) => {
      doc.transact(() => {
        const m = ensure(beatId)
        if (value === undefined || value === null || value === '') m.delete(fieldId)
        else m.set(fieldId, value)
      }, DATA_ORIGIN)
    },
    transact: (fn) => doc.transact(fn, DATA_ORIGIN),
    copyBeat: (fromId, toId) => {
      const src = beats.get(fromId)
      if (!src || beats.has(toId)) return
      doc.transact(() => {
        const m = ensure(toId)
        src.forEach((v, k) => m.set(k, v))
      }, 'sidescript-bookkeeping')
    },
    collapsed: new CollapseStore(opts.docId),
    selection: new SelectionStore(order),
    order,
    setOrder: (fn) => {
      orderFn = fn
    },
    setMany: (ids, fieldId, value) => {
      doc.transact(() => {
        ids.forEach((id, i) => {
          const m = ensure(id)
          const v = value(i, m.get(fieldId))
          if (v === undefined || v === null || v === '') m.delete(fieldId)
          else m.set(fieldId, v)
        })
      }, DATA_ORIGIN)
    },
    upload: opts.upload,
  }
}
