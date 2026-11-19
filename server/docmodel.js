/**
 * Shape of a Sidescript document (one Y.Doc):
 *   XmlFragment 'default'   rich text (TipTap / ProseMirror)
 *   Map 'meta'              { title }
 *   Map 'categories'        id -> { id, name, color, kind, order }   (the highlight key)
 *   Map 'notes'             annotationId -> { id, category, text, url, citation, attachments, author, ... }
 *   Map 'comments'          threadId -> { id, author, text, createdAt, resolved, replies }
 */
import * as Y from 'yjs'
import { seedScript } from './script.js'

// Word-level highlight layers. (What's on screen for a whole beat is the beat's Visual field.)
export const DEFAULT_CATEGORIES = [
  // Light-row highlighter colours (client/src/editor/model.ts has the palette).
  { id: 'sources', name: 'Citations', color: '#a7ce5b', kind: 'citation', order: 0 },
  { id: 'overlay', name: 'Graphics', color: '#95b3ee', kind: 'image', order: 1 },
  { id: 'ideas', name: 'Tasks', color: '#ff767f', kind: 'note', order: 2 },
]

const KINDS = new Set(['note', 'image', 'citation', 'link', 'media', 'file'])

export function sanitizeCategories(list) {
  if (!Array.isArray(list)) return null
  const out = []
  for (const [i, c] of list.slice(0, 50).entries()) {
    if (!c || typeof c !== 'object') continue
    const id = String(c.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
    const color = /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : null
    if (!id || !color) continue
    out.push({ id, name: String(c.name || 'Untitled').slice(0, 60), color, kind: KINDS.has(c.kind) ? c.kind : 'note', order: i })
  }
  return out
}

export function newDocState({ title, categories, fields, sectionColor }) {
  const doc = new Y.Doc()
  doc.transact(() => {
    doc.getMap('meta').set('title', title)
    const cats = doc.getMap('categories')
    for (const c of categories?.length ? categories : DEFAULT_CATEGORIES) cats.set(c.id, { ...c })
    seedScript(doc, { fields, sectionColor })
  })
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

/** Validates an uploaded Yjs state (from a .sidescript backup). Throws if invalid. */
export function validateState(buf, title) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, buf)
  if (title) doc.getMap('meta').set('title', title)
  const out = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return out
}

/** Copy of a doc's state with a new title and media URLs pointed at the new doc. */
export function duplicateState(buf, fromId, toId, title) {
  const doc = new Y.Doc()
  if (buf) Y.applyUpdate(doc, buf)
  const from = `/api/docs/${fromId}/media/`
  const to = `/api/docs/${toId}/media/`
  doc.transact(() => {
    doc.getMap('meta').set('title', title)
    const walk = (node) => {
      if (node instanceof Y.XmlElement) {
        const src = node.getAttribute('src')
        if (typeof src === 'string' && src.startsWith(from)) node.setAttribute('src', to + src.slice(from.length))
      }
      if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) node.toArray().forEach(walk)
    }
    walk(doc.getXmlFragment('default'))
    const notes = doc.getMap('notes')
    for (const [id, note] of notes.entries()) {
      if (!note?.attachments?.length) continue
      const attachments = note.attachments.map((a) => (a?.url?.startsWith(from) ? { ...a, url: to + a.url.slice(from.length) } : a))
      notes.set(id, { ...note, attachments })
    }
  })
  const out = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return out
}
