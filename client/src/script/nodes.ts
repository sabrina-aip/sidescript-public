/**
 * Script structure for the editor: doc > section > (sectionTitle, beat > blocks).
 *
 * The content rules are deliberately lenient (sections and the document also
 * accept plain blocks). If a collaborator's old offline copy sends text that
 * isn't inside a beat, it is shown rather than rejected — the collaboration
 * layer deletes content it can't fit, and we never want that. The server then
 * wraps such text into a beat. Local edits are tidied immediately by the
 * plugin below, and only for this browser's own changes, so two people can
 * never "fix" the same text twice.
 */
import { Extension, Node, mergeAttributes } from '@tiptap/core'
import { Fragment, NodeRange, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import type { EditorView } from '@tiptap/pm/view'
import type { ScriptContext } from './context'
import { BeatView, SectionTitleView, SectionView } from './views'

export const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(6))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const ScriptDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: '(section | block)+',
})

export const SectionTitle = Node.create({
  name: 'sectionTitle',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'h2[data-section-title]', priority: 60 }],
  renderHTML: ({ HTMLAttributes }) => ['h2', mergeAttributes(HTMLAttributes, { 'data-section-title': '' }), 0],
})

interface ScriptOptions {
  ctx: ScriptContext | null
}

export const Section = Node.create<ScriptOptions>({
  name: 'section',
  content: 'sectionTitle (beat | block)*',
  isolating: true,
  defining: true,
  addOptions: () => ({ ctx: null }),
  addAttributes: () => ({ id: { default: null, parseHTML: (el) => el.getAttribute('data-section-id'), renderHTML: (a) => ({ 'data-section-id': a.id }) } }),
  parseHTML: () => [{ tag: 'section[data-section-id]' }],
  renderHTML: ({ HTMLAttributes }) => ['section', HTMLAttributes, 0],
  addNodeView() {
    const ctx = this.options.ctx
    return ctx ? ({ node }) => new SectionView(node, ctx) : null
  },
})

export const Beat = Node.create<ScriptOptions>({
  name: 'beat',
  content: 'block+',
  isolating: true,
  defining: true,
  addOptions: () => ({ ctx: null }),
  addAttributes: () => ({ id: { default: null, parseHTML: (el) => el.getAttribute('data-beat-id'), renderHTML: (a) => ({ 'data-beat-id': a.id }) } }),
  parseHTML: () => [{ tag: 'div[data-beat-id]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', HTMLAttributes, 0],
  addNodeView() {
    const ctx = this.options.ctx
    return ctx ? ({ node }) => new BeatView(node, ctx) : null
  },
})

export const SectionTitleWithView = SectionTitle.extend<ScriptOptions>({
  addOptions: () => ({ ctx: null }),
  addNodeView() {
    const ctx = this.options.ctx
    return ctx ? ({ node, view, getPos }) => new SectionTitleView(node, view, getPos as () => number | undefined, ctx) : null
  },
})

// ---------------------------------------------------------------- helpers

/** The beat (and its section) around a resolved position. */
export function beatAt(state: EditorState, pos = state.selection.from) {
  const $pos = state.doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'beat') return { node: $pos.node(d), depth: d, pos: $pos.before(d), $pos }
  }
  return null
}

const emptyBeat = (schema: Schema, id = newId()) => schema.nodes.beat.create({ id }, schema.nodes.paragraph.create())
export const emptySection = (schema: Schema, beats?: PMNode[]) =>
  schema.nodes.section.create({ id: newId() }, [schema.nodes.sectionTitle.create(), ...(beats?.length ? beats : [emptyBeat(schema)])])

// ---------------------------------------------------------------- local structure tidy-up

const tidyKey = new PluginKey('scriptTidy')

/** Returns a transaction fixing the FIRST problem found, or null. Runs repeatedly until clean. */
function tidy(state: EditorState, onDuplicate: (from: string, to: string) => void): Transaction | null {
  const { doc, schema, tr } = state
  const S = schema.nodes

  if (doc.childCount === 0) return tr.insert(0, emptySection(schema))

  // 1. Top level: only sections. Headings start sections; other blocks join a beat.
  let pos = 0
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i)
    if (child.type !== S.section) {
      let j = i
      let to = pos
      while (j < doc.childCount && doc.child(j).type !== S.section) to += doc.child(j++).nodeSize
      const prev = i > 0 ? doc.child(i - 1) : null
      const toPrev: PMNode[] = []
      const fresh: { title: Fragment; beats: PMNode[] }[] = []
      let blocks: PMNode[] = []
      const target = () => (fresh.length ? fresh[fresh.length - 1].beats : prev ? toPrev : (fresh.push({ title: Fragment.empty, beats: [] }), fresh[0].beats))
      const flush = () => {
        if (blocks.length) target().push(S.beat.create({ id: newId() }, blocks))
        blocks = []
      }
      for (let k = i; k < j; k++) {
        const n = doc.child(k)
        if (n.type === S.heading || n.type === S.sectionTitle) {
          flush()
          fresh.push({ title: n.content, beats: [] })
        } else if (n.type === S.beat) {
          flush()
          target().push(n)
        } else blocks.push(n)
      }
      flush()
      const sections = fresh.map((f) => S.section.create({ id: newId() }, [S.sectionTitle.create(null, f.title), ...(f.beats.length ? f.beats : [emptyBeat(schema)])]))
      const hadCursor = state.selection.from >= pos && state.selection.from <= to
      tr.replaceWith(pos, to, sections)
      if (toPrev.length) tr.insert(pos - 1, toPrev)
      if (hadCursor) {
        const at = toPrev.length ? pos - 1 + toPrev.reduce((s, n) => s + n.nodeSize, 0) : pos + 2
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size)), -1))
      }
      return tr
    }
    pos += child.nodeSize
  }

  // 2. Sections: title first, then beats; at least one beat.
  const seenBeats = new Set<string>()
  const seenSections = new Set<string>()
  const idFixes: { pos: number; attrs: Record<string, unknown>; dupOf?: string }[] = []
  pos = 0
  for (let i = 0; i < doc.childCount; i++) {
    const sec = doc.child(i)
    const start = pos + 1
    if (!sec.attrs.id || seenSections.has(sec.attrs.id)) idFixes.push({ pos, attrs: { ...sec.attrs, id: newId() } })
    else seenSections.add(sec.attrs.id)
    if (sec.firstChild?.type !== S.sectionTitle) return tr.insert(start, S.sectionTitle.create())
    let beats = 0
    let p = start + sec.firstChild.nodeSize
    for (let k = 1; k < sec.childCount; k++) {
      const c = sec.child(k)
      if (c.type === S.sectionTitle) return tr.replaceWith(p, p + c.nodeSize, S.beat.create({ id: newId() }, S.paragraph.create(null, c.content)))
      if (c.type !== S.beat) {
        let end = p
        let m = k
        while (m < sec.childCount && sec.child(m).type !== S.beat && sec.child(m).type !== S.sectionTitle) end += sec.child(m++).nodeSize
        const range = new NodeRange(doc.resolve(p), doc.resolve(end), 1)
        return tr.wrap(range, [{ type: S.beat, attrs: { id: newId() } }])
      }
      beats++
      if (c.childCount === 0) return tr.insert(p + 1, S.paragraph.create())
      const id = c.attrs.id
      if (!id || seenBeats.has(id)) idFixes.push({ pos: p, attrs: { ...c.attrs, id: newId() }, dupOf: id || undefined })
      else seenBeats.add(id)
      p += c.nodeSize
    }
    if (beats === 0) return tr.insert(pos + sec.nodeSize - 1, emptyBeat(schema))
    pos += sec.nodeSize
  }

  // 3. Unique ids (copy/paste duplicates a beat's id; the copy gets its own, with the same data).
  if (idFixes.length) {
    for (const f of idFixes) {
      tr.setNodeMarkup(f.pos, undefined, f.attrs)
      if (f.dupOf) {
        const from = f.dupOf
        const to = f.attrs.id as string
        setTimeout(() => onDuplicate(from, to))
      }
    }
    return tr
  }
  return null
}

// ---------------------------------------------------------------- commands & keys

export const ScriptBehaviour = Extension.create<ScriptOptions>({
  name: 'scriptBehaviour',
  // Run before the default Backspace / Enter handling.
  priority: 1000,
  addOptions: () => ({ ctx: null }),

  addProseMirrorPlugins() {
    const ctx = this.options.ctx
    return [
      new Plugin({
        key: tidyKey,
        appendTransaction(trs, _old, state) {
          // Only tidy after this browser's own edits (never remote ones; see top of file).
          if (!trs.some((tr) => tr.docChanged && !isChangeOrigin(tr))) return null
          return tidy(state, (from, to) => ctx?.copyBeat(from, to))
        },
      }),
      // Marks the beat holding the cursor ("beat-current"), so the document view can quiet
      // every other beat's chips and fields. A class on the beat's element, not a decoration,
      // so the beat views never redraw for it.
      new Plugin({
        view(editorView) {
          let current: Element | null = null
          const update = (view: EditorView) => {
            const b = beatAt(view.state)
            const dom = b ? (view.nodeDOM(b.pos) as Element | null) : null
            if (dom === current) return
            current?.classList.remove('beat-current')
            dom?.classList.add('beat-current')
            current = dom
          }
          requestAnimationFrame(() => update(editorView))
          return { update, destroy: () => current?.classList.remove('beat-current') }
        },
      }),
    ]
  },

  addKeyboardShortcuts() {
    const editor = this.editor
    // Pick up a cursor move the browser made but the editor hasn't processed yet
    // (e.g. End immediately followed by Ctrl+Enter), so commands act at the right spot.
    const syncSelection = () => (editor.view as unknown as { domObserver?: { flush(): void } }).domObserver?.flush()

    /** Ctrl/Cmd+Enter: split the beat at the cursor into a new beat. */
    const splitBeat = () => {
      syncSelection()
      const { state } = editor
      const b = beatAt(state)
      if (!b) return focusFirstBeat()
      const { $from } = state.selection
      const tr = state.tr.deleteSelection()
      const pos = tr.mapping.map($from.pos)
      const depth = tr.doc.resolve(pos).depth - b.depth + 1
      tr.split(pos, depth, [{ type: state.schema.nodes.beat, attrs: { id: newId() } }])
      editor.view.dispatch(tr.scrollIntoView())
      return true
    }

    /** Ctrl/Cmd+Shift+Enter: start a new section at this beat. */
    const newSection = () => {
      syncSelection()
      const { state } = editor
      const b = beatAt(state)
      if (!b) return false
      const S = state.schema.nodes
      const $beat = state.doc.resolve(b.pos)
      const indexInSection = $beat.index()
      const tr = state.tr
      if (indexInSection <= 1) {
        // First beat: add an empty section before this one instead.
        const sectionPos = $beat.before($beat.depth)
        tr.insert(sectionPos, emptySection(state.schema))
        tr.setSelection(TextSelection.create(tr.doc, sectionPos + 2))
      } else {
        // Move this beat and the ones after it into a new section with an empty title.
        const sectionPos = $beat.before($beat.depth)
        const sectionEnd = sectionPos + $beat.parent.nodeSize
        const moved = state.doc.slice(b.pos, sectionEnd - 1).content
        tr.delete(b.pos, sectionEnd - 1)
        const at = tr.mapping.map(sectionEnd)
        tr.insert(at, S.section.create({ id: newId() }, Fragment.from(S.sectionTitle.create()).append(moved)))
        tr.setSelection(TextSelection.create(tr.doc, at + 2))
      }
      editor.view.dispatch(tr.scrollIntoView())
      return true
    }

    const focusFirstBeat = () => {
      const { state } = editor
      const $from = state.selection.$from
      if ($from.parent.type.name !== 'sectionTitle') return false
      const sectionPos = $from.before($from.depth - 1)
      const section = state.doc.nodeAt(sectionPos)
      if (!section) return false
      const afterTitle = sectionPos + 1 + section.firstChild!.nodeSize
      const tr = state.tr
      if (section.childCount < 2) tr.insert(afterTitle, emptyBeat(state.schema))
      tr.setSelection(TextSelection.near(tr.doc.resolve(afterTitle + 2)))
      editor.view.dispatch(tr.scrollIntoView())
      return true
    }

    /** Backspace at the very start of a beat merges it into the beat above (keeping the upper beat's data). */
    const mergeBackward = () => {
      syncSelection()
      const { state } = editor
      const sel = state.selection
      if (!sel.empty) return false
      const $c = sel.$from
      if ($c.parentOffset !== 0) return false

      if ($c.parent.type.name === 'sectionTitle') {
        // Empty title at the start of a section: fold this section into the previous one.
        if ($c.parent.content.size > 0) return false
        const sectionPos = $c.before($c.depth - 1)
        const $sec = state.doc.resolve(sectionPos)
        if ($sec.index() === 0) return true
        const titlePos = $c.before()
        const tr = state.tr.delete(titlePos, titlePos + $c.parent.nodeSize)
        tr.join(tr.mapping.map(sectionPos))
        tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(titlePos)), -1))
        editor.view.dispatch(tr.scrollIntoView())
        return true
      }

      const b = beatAt(state)
      if (!b) return false
      // Only at the start of the beat's first paragraph (inside lists etc. keep normal behaviour).
      if ($c.depth !== b.depth + 1 || $c.index(b.depth) !== 0) return false
      const $beat = state.doc.resolve(b.pos)
      const before = $beat.nodeBefore
      if (!before || before.type.name !== 'beat') return true // first beat: nothing to merge into
      const tr = state.tr.join(b.pos)
      editor.view.dispatch(tr.scrollIntoView())
      return true
    }

    return {
      'Mod-Enter': splitBeat,
      'Mod-Shift-Enter': newSection,
      Backspace: mergeBackward,
      Enter: focusFirstBeat,
    }
  },
})
