import { Mark, mergeAttributes, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * A coloured annotation. `id` links to an entry in the doc's `notes` map,
 * `cat` to an entry in the `categories` map (the highlight key).
 * `excludes: ''` lets annotations of different colours overlap the same text.
 */
export const Annotation = Mark.create({
  name: 'annotation',
  excludes: '',
  inclusive: false,
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-ann'), renderHTML: (a) => ({ 'data-ann': a.id }) },
      cat: { default: null, parseHTML: (el) => el.getAttribute('data-cat'), renderHTML: (a) => ({ 'data-cat': a.cat }) },
    }
  },
  parseHTML() {
    return [{ tag: 'mark[data-ann]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes, { class: 'ann' }), 0]
  },
})

/** A comment thread anchor. `id` links to the doc's `comments` map. */
export const Comment = Mark.create({
  name: 'comment',
  excludes: '',
  inclusive: false,
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-comment'), renderHTML: (a) => ({ 'data-comment': a.id }) },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-comment]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'cmt' }), 0]
  },
})

export interface AnchorInfo {
  id: string
  cat?: string
  from: number
  to: number
  text: string
}

/** Every annotation / comment anchor in document order, with its quoted text. */
export function collectAnchors(doc: PMNode, markName: 'annotation' | 'comment') {
  const out = new Map<string, AnchorInfo>()
  doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const m of node.marks) {
      if (m.type.name !== markName || !m.attrs.id) continue
      const a = out.get(m.attrs.id)
      const end = pos + node.nodeSize
      if (!a) out.set(m.attrs.id, { id: m.attrs.id, cat: m.attrs.cat, from: pos, to: end, text: node.text || '' })
      else {
        if (a.text.length < 400) a.text += (pos > a.to ? ' … ' : '') + node.text
        a.to = Math.max(a.to, end)
      }
    }
  })
  return [...out.values()].sort((a, b) => a.from - b.from)
}

function ranges(doc: PMNode, markName: string, id: string) {
  const out: { from: number; to: number; mark: any }[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const m of node.marks) if (m.type.name === markName && m.attrs.id === id) out.push({ from: pos, to: pos + node.nodeSize, mark: m })
  })
  return out
}

export function removeAnchor(editor: Editor, markName: 'annotation' | 'comment', id: string) {
  const { tr } = editor.state
  for (const r of ranges(editor.state.doc, markName, id)) tr.removeMark(r.from, r.to, r.mark)
  if (tr.docChanged) editor.view.dispatch(tr)
}

export function recolorAnnotation(editor: Editor, id: string, cat: string) {
  const { tr, schema } = editor.state
  for (const r of ranges(editor.state.doc, 'annotation', id)) {
    tr.removeMark(r.from, r.to, r.mark)
    tr.addMark(r.from, r.to, schema.marks.annotation.create({ id, cat }))
  }
  if (tr.docChanged) editor.view.dispatch(tr)
}

export function addAnchor(editor: Editor, markName: 'annotation' | 'comment', attrs: Record<string, string>, from: number, to: number) {
  const { tr, schema } = editor.state
  tr.addMark(from, to, schema.marks[markName].create(attrs))
  editor.view.dispatch(tr)
}

/**
 * Bring an annotation's or comment's text into view (from its card in the side panel)
 * without moving the cursor or focus. Does nothing if it's already fully on screen.
 * Runs on the next frame so a highlight that only renders once its card is active
 * (completed annotations) is laid out first.
 */
export function scrollToAnchor(editor: Editor, a: AnchorInfo, kind: 'note' | 'comment') {
  requestAnimationFrame(() => {
    if (editor.isDestroyed) return
    const sel = kind === 'note' ? `mark[data-ann="${CSS.escape(a.id)}"]` : `span[data-comment="${CSS.escape(a.id)}"]`
    let el = editor.view.dom.querySelector<HTMLElement>(sel)
    if (!el) {
      try {
        const { node } = editor.view.domAtPos(a.from)
        el = node instanceof HTMLElement ? node : node.parentElement
      } catch {
        return
      }
    }
    if (!el) return
    const r = el.getBoundingClientRect()
    const scroller = el.closest('.ed-scroll')
    const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
    if (r.top >= box.top && r.bottom <= box.bottom) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}

/** Clicks on a card's own controls (typing, buttons, links) shouldn't scroll the document. */
export function isControlClick(e: { target: EventTarget | null }) {
  return !!(e.target as HTMLElement | null)?.closest('button, a, input, textarea, select, label, [contenteditable="true"]')
}
