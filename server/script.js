/**
 * Script structure. Every Sidescript document is a script:
 *
 *   XmlFragment 'default'
 *     section   (id)            a folder of beats, e.g. "Act I"
 *       sectionTitle            the section's title text
 *       beat    (id)            a folder for one chunk of dialogue
 *         paragraph / list / … the dialogue (annotated with highlights)
 *
 *   Map 'beats'     beatId    -> Y.Map { fieldId: value }      beat data (scene, visual, status…)
 *   Map 'sections'  sectionId -> { goals: [{ id, text, done }] }
 *   Map 'fields'    'list'    -> [FieldDef]                    the field key
 *
 * The SERVER is the only place that repairs structure (wrapping stray text
 * into beats). Doing it in one place means two browsers can never both repair
 * the same text and duplicate it. Repairs only ever move text into beats;
 * nothing is dropped.
 */
import * as Y from 'yjs'
import crypto from 'node:crypto'

export const newId = () => crypto.randomBytes(6).toString('base64url')

export const DEFAULT_FIELDS = [
  {
    id: 'visual',
    name: 'Visual',
    type: 'visual',
    options: [
      { id: 'aroll', label: 'A-Roll', color: '#f2d67a' },
      { id: 'vlog', label: 'Vlog', color: '#ff767f' },
      { id: 'broll', label: 'B-Roll', color: '#95b3ee' },
      { id: 'montage', label: 'Montage', color: '#333740' },
      { id: 'call', label: 'Call', color: '#d5d1c9' },
      { id: 'gfx', label: 'GFX', color: '#a7ce5b' },
    ],
  },
  { id: 'scene', name: 'Scene', type: 'text' },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'pending', label: 'pending', color: '#d5d1c9' },
      { id: 'shoot', label: 'shoot required', color: '#ff767f' },
      { id: 'pendingupload', label: 'pending upload', color: '#f2d67a' },
      { id: 'uploaded', label: 'uploaded', color: '#a7ce5b' },
      { id: 'edited', label: 'edited', color: '#333740' },
    ],
  },
]

const el = (name, attrs = {}, children = []) => {
  const e = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (children.length) e.insert(0, children)
  return e
}
const paragraph = () => el('paragraph', {}, [])
export const makeBeat = (children = [paragraph()]) => el('beat', { id: newId() }, children)
export const makeSection = (titleChildren = [], beats = []) => el('section', { id: newId() }, [el('sectionTitle', {}, titleChildren), ...beats])

const isEl = (n, name) => n instanceof Y.XmlElement && n.nodeName === name
const cloneChildren = (n) => n.toArray().map((c) => c.clone())

const HEX = /^#[0-9a-fA-F]{6}$/
const cleanId = (v) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)

/** Validate a field key (from a user's saved default). Returns null if unusable. */
export function sanitizeFields(list) {
  if (!Array.isArray(list)) return null
  const out = []
  for (const f of list.slice(0, 12)) {
    const id = cleanId(f?.id)
    const type = ['text', 'select', 'visual'].includes(f?.type) ? f.type : null
    if (!id || !type || out.some((x) => x.id === id)) continue
    const field = { id, name: String(f.name || id).slice(0, 40), type }
    if (type !== 'text') {
      field.options = (Array.isArray(f.options) ? f.options : [])
        .slice(0, 30)
        .map((o) => ({ id: cleanId(o?.id), label: String(o?.label || '').slice(0, 40), color: HEX.test(o?.color) ? o.color : '#94a3b8' }))
        .filter((o) => o.id)
    }
    out.push(field)
  }
  return out // an empty list is valid: Dialogue only
}
export const sanitizeColor = (c) => (HEX.test(c) ? c : null)

/** Fill in a fresh document. */
export function seedScript(doc, { fields, sectionColor } = {}) {
  doc.getXmlFragment('default').insert(0, [makeSection([], [makeBeat()])])
  const map = doc.getMap('fields')
  if (!map.has('list')) map.set('list', Array.isArray(fields) ? fields : DEFAULT_FIELDS)
  if (sectionColor) map.set('sectionColor', sectionColor)
}

/** Does the document need structural repair? Cheap: only looks two levels deep. */
export function needsRepair(doc) {
  const frag = doc.getXmlFragment('default')
  if (frag.length === 0) return true
  for (const s of frag.toArray()) {
    if (!isEl(s, 'section')) return true
    const kids = s.toArray()
    if (!isEl(kids[0], 'sectionTitle')) return true
    for (let i = 1; i < kids.length; i++) if (!isEl(kids[i], 'beat')) return true
  }
  return !doc.getMap('fields').has('list')
}

/**
 * Wrap any text that isn't inside a beat into beats. Old free-form documents
 * become scripts: each heading starts a section, each paragraph a beat (lists,
 * quotes and images stay with the paragraph before them).
 */
export function repairScript(doc) {
  const frag = doc.getXmlFragment('default')
  doc.transact(() => {
    if (!doc.getMap('fields').has('list')) doc.getMap('fields').set('list', DEFAULT_FIELDS)

    // 1. Top level: only sections.
    let lastSection = null
    let strayBeat = null
    let i = 0
    while (i < frag.length) {
      const c = frag.get(i)
      if (isEl(c, 'section')) {
        lastSection = c
        strayBeat = null
        i++
        continue
      }
      const heading = isEl(c, 'heading') || isEl(c, 'sectionTitle')
      if (heading || !lastSection) {
        const sec = makeSection(heading ? cloneChildren(c) : [])
        frag.insert(i, [sec])
        i++
        lastSection = sec
        strayBeat = null
        if (heading) {
          frag.delete(i, 1)
          continue
        }
      }
      if (isEl(c, 'beat')) {
        lastSection.push([c.clone()])
        strayBeat = null
      } else {
        if (!strayBeat || isEl(c, 'paragraph')) {
          strayBeat = makeBeat([])
          lastSection.push([strayBeat])
        }
        strayBeat.push([c.clone()])
      }
      frag.delete(i, 1)
    }
    if (frag.length === 0) frag.insert(0, [makeSection([], [makeBeat()])])

    // 2. Inside sections: a title first, then only beats.
    for (const sec of frag.toArray()) {
      if (!isEl(sec.get(0), 'sectionTitle')) sec.insert(0, [el('sectionTitle')])
      let j = 1
      let wrap = null
      while (j < sec.length) {
        const c = sec.get(j)
        if (isEl(c, 'beat')) {
          wrap = null
          j++
          continue
        }
        if (isEl(c, 'sectionTitle')) {
          // A second title (e.g. from a merge): keep its text as a beat.
          const b = makeBeat([el('paragraph', {}, cloneChildren(c))])
          sec.insert(j, [b])
          sec.delete(j + 1, 1)
          wrap = null
          j++
          continue
        }
        if (!wrap) {
          wrap = makeBeat([])
          sec.insert(j, [wrap])
          j++
        }
        wrap.push([c.clone()])
        sec.delete(j, 1)
      }
    }
  }, 'repair')
}
