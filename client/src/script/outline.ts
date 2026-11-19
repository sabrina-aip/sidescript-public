/**
 * The script's folder structure, for the outline drawer: read it, and move
 * beats / sections. Moves are ordinary editor transactions, so they sync to
 * collaborators and can be undone. A beat keeps its id, so its data
 * (scene, visual, status) and its highlights travel with it.
 */
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { emptySection, newId } from './nodes'

export interface OutlineBeat {
  id: string
  pos: number
  text: string
}
export interface OutlineSection {
  id: string
  pos: number
  title: string
  beats: OutlineBeat[]
}

export function readOutline(doc: PMNode): OutlineSection[] {
  const out: OutlineSection[] = []
  doc.forEach((sec, pos) => {
    if (sec.type.name !== 'section') return
    const s: OutlineSection = { id: sec.attrs.id, pos, title: '', beats: [] }
    sec.forEach((child, off) => {
      if (child.type.name === 'sectionTitle') s.title = child.textContent
      else if (child.type.name === 'beat') s.beats.push({ id: child.attrs.id, pos: pos + 1 + off, text: child.textBetween(0, child.content.size, ' ').slice(0, 120) })
    })
    out.push(s)
  })
  return out
}

function find(doc: PMNode, type: 'section' | 'beat', id: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null
  doc.forEach((sec, pos) => {
    if (found || sec.type.name !== 'section') return
    if (type === 'section' && sec.attrs.id === id) found = { pos, node: sec }
    if (type === 'beat')
      sec.forEach((child, off) => {
        if (!found && child.type.name === 'beat' && child.attrs.id === id) found = { pos: pos + 1 + off, node: child }
      })
  })
  return found
}

export type BeatTarget = { before: string } | { after: string } | { startOf: string } | { endOf: string }
export type SectionTarget = { before: string } | { after: string }

export function moveBeat(editor: Editor, beatId: string, target: BeatTarget) {
  const { state } = editor
  const src = find(state.doc, 'beat', beatId)
  if (!src) return false
  if (('before' in target && target.before === beatId) || ('after' in target && target.after === beatId)) return false
  const tr = state.tr.delete(src.pos, src.pos + src.node.nodeSize)
  let at: number | null = null
  if ('before' in target || 'after' in target) {
    const ref = find(tr.doc, 'beat', 'before' in target ? target.before : target.after)
    if (ref) at = 'before' in target ? ref.pos : ref.pos + ref.node.nodeSize
  } else {
    const sec = find(tr.doc, 'section', 'startOf' in target ? target.startOf : target.endOf)
    if (sec) at = 'startOf' in target ? sec.pos + 1 + sec.node.firstChild!.nodeSize : sec.pos + sec.node.nodeSize - 1
  }
  if (at === null) return false
  tr.insert(at, src.node)
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)))
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

export function moveSection(editor: Editor, sectionId: string, target: SectionTarget) {
  const { state } = editor
  const src = find(state.doc, 'section', sectionId)
  const refId = 'before' in target ? target.before : target.after
  if (!src || refId === sectionId) return false
  const tr = state.tr.delete(src.pos, src.pos + src.node.nodeSize)
  const ref = find(tr.doc, 'section', refId)
  if (!ref) return false
  const at = 'before' in target ? ref.pos : ref.pos + ref.node.nodeSize
  tr.insert(at, src.node)
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)))
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

/** Alt+↑ / Alt+↓ in the outline. Beats step over neighbours and across section boundaries. */
export function nudge(editor: Editor, kind: 'section' | 'beat', id: string, dir: -1 | 1) {
  const outline = readOutline(editor.state.doc)
  if (kind === 'section') {
    const i = outline.findIndex((s) => s.id === id)
    const other = outline[i + dir]
    return other ? moveSection(editor, id, dir < 0 ? { before: other.id } : { after: other.id }) : false
  }
  const si = outline.findIndex((s) => s.beats.some((b) => b.id === id))
  if (si < 0) return false
  const beats = outline[si].beats
  const bi = beats.findIndex((b) => b.id === id)
  const other = beats[bi + dir]
  if (other) return moveBeat(editor, id, dir < 0 ? { before: other.id } : { after: other.id })
  const nextSection = outline[si + dir]
  if (!nextSection) return false
  return moveBeat(editor, id, dir < 0 ? { endOf: nextSection.id } : { startOf: nextSection.id })
}

export function addSection(editor: Editor) {
  const { state } = editor
  const at = state.doc.content.size
  const tr = state.tr.insert(at, emptySection(state.schema))
  tr.setSelection(TextSelection.create(tr.doc, at + 2))
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
}

export function addBeat(editor: Editor, sectionId: string) {
  const { state } = editor
  const sec = find(state.doc, 'section', sectionId)
  if (!sec) return
  const at = sec.pos + sec.node.nodeSize - 1
  const last = sec.node.lastChild
  if (last?.type.name === 'beat' && last.textContent === '' && last.childCount === 1) {
    // The section already ends with an empty beat: use it rather than adding another.
    editor.view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(at - 1), -1)).scrollIntoView())
    editor.view.focus()
    return
  }
  const S = state.schema.nodes
  const tr = state.tr.insert(at, S.beat.create({ id: newId() }, S.paragraph.create()))
  tr.setSelection(TextSelection.create(tr.doc, at + 2))
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
}

/** Scroll to a section or beat and put the cursor there. */
/** `focus: false` moves there without focusing the script (on a phone that would open the keyboard). */
export function reveal(editor: Editor, pos: number, focus = true) {
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null
  dom?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  const tr = editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1)))
  editor.view.dispatch(tr)
  if (focus) editor.view.focus()
}
