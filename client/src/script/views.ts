import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView, NodeView, ViewMutationRecord } from '@tiptap/pm/view'
import { chipText, isVeryDark, tableColumns, type FieldDef, type VisualValue } from './fields'
import type { ScriptContext } from './context'
import { confirmAt } from '../components/confirmAt'
import { toast } from '../util'

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, attrs: Record<string, string> = {}) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}
const rid = () => Math.random().toString(36).slice(2, 10)
const isFocused = (el: Element) => el === document.activeElement

const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'

function autosize(t: HTMLTextAreaElement) {
  t.style.height = 'auto'
  t.style.height = `${t.scrollHeight}px`
}

// ================================================================ beat

/**
 * A beat: a row of data (Visual, Scene, Status…) plus its dialogue.
 * Document view lays the data out as a slim header; table view (a CSS class
 * on the page) places the same cells into grid columns around the dialogue.
 */
export class BeatView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private meta: HTMLElement
  private check: HTMLInputElement
  private cells = new Map<string, { def: FieldDef; el: HTMLElement; render: () => void }>()
  private id: string
  private node: PMNode
  private off: (() => void)[] = []
  private offBeat: (() => void) | null = null

  constructor(node: PMNode, private ctx: ScriptContext) {
    this.node = node
    this.id = node.attrs.id
    this.dom = h('div', 'beat')
    this.meta = h('div', 'beat-meta', { contenteditable: 'false' })
    // Checkbox for bulk editing: click toggles, shift-click selects a range.
    this.check = h('input', 'beat-select', { type: 'checkbox', 'aria-label': 'Select beat', title: 'Select (shift-click for a range)' }) as HTMLInputElement
    this.check.addEventListener('mousedown', (e) => e.preventDefault())
    this.check.addEventListener('click', (e) => (e.shiftKey ? ctx.selection.range(this.id) : ctx.selection.toggle(this.id)))
    this.off.push(ctx.selection.on(() => this.renderSelected()))
    this.contentDOM = h('div', 'beat-body')
    this.dom.append(this.meta, this.contentDOM)
    // Beats skip rendering while off-screen (fast long scripts), but a beat created while you
    // work (Ctrl+Enter, paste, move) must be drawn at once, or typing straight into it can land
    // in the wrong place. Switch it to normal behaviour shortly after.
    if (ctx.ready) {
      this.dom.style.contentVisibility = 'visible'
      setTimeout(() => this.dom.style.removeProperty('content-visibility'), 1500)
    }
    this.buildCells()
    this.bind()
    this.off.push(ctx.onFields(() => this.buildCells()))
  }

  private bind() {
    this.dom.dataset.beat = this.id || ''
    this.offBeat?.()
    this.offBeat = this.ctx.onBeat(this.id, () => this.renderValues())
    this.renderValues()
    this.renderSelected()
  }

  private renderSelected() {
    const on = this.ctx.selection.has(this.id)
    this.check.checked = on
    this.dom.classList.toggle('selected', on)
  }

  private buildCells() {
    const list = this.ctx.fieldList()
    const cols = tableColumns(list)
    this.meta.replaceChildren(...(this.ctx.canEdit ? [this.check] : []))
    this.cells.clear()
    for (const def of list) {
      const el = h('div', `cell f-${def.type}`, { 'data-field': def.id })
      el.style.setProperty('--col', String(cols.column(def.id)))
      const render = def.type === 'visual' ? this.visualCell(def, el) : def.type === 'select' ? this.selectCell(def, el) : this.textCell(def, el)
      this.cells.set(def.id, { def, el, render })
      this.meta.append(el)
    }
    // Document view header columns: visual fields stretch, text fields and chips get fixed widths.
    this.meta.classList.toggle('no-fields', list.length === 0)
    this.meta.style.setProperty('--meta-cols', list.map((f) => (f.type === 'visual' ? 'minmax(0, 1fr)' : f.type === 'select' ? '116px' : '9ch')).join(' ') || 'minmax(0, 1fr)')
    this.contentDOM.style.setProperty('--col', String(cols.bodyColumn))
    this.renderValues()
  }

  private renderValues() {
    for (const c of this.cells.values()) c.render()
  }

  // ---- cells

  private textCell(def: FieldDef, el: HTMLElement) {
    const input = h('input', 'f-input', { placeholder: def.name, 'aria-label': def.name, maxlength: '40' }) as HTMLInputElement
    input.readOnly = !this.ctx.canEdit
    input.addEventListener('input', () => this.ctx.setValue(this.id, def.id, input.value))
    el.append(input)
    return () => {
      const v = String(this.ctx.getValue(this.id, def.id) ?? '')
      if (!isFocused(input)) input.value = v
      el.classList.toggle('empty', !v)
    }
  }

  private chip(def: FieldDef, value: string | undefined, onChange: (v: string) => void) {
    const sel = h('select', 'f-chip', { 'aria-label': def.name, title: def.name }) as HTMLSelectElement
    sel.disabled = !this.ctx.canEdit
    sel.append(new Option(`${def.name} …`, ''))
    for (const o of def.options || []) sel.append(new Option(o.label, o.id))
    sel.value = value || ''
    const paint = () => {
      const opt = def.options?.find((o) => o.id === sel.value)
      sel.style.background = opt ? opt.color : ''
      sel.style.color = opt ? chipText(opt.color) : ''
      sel.classList.toggle('unset', !opt)
      sel.classList.toggle('chip-dark', !!opt && isVeryDark(opt.color))
    }
    paint()
    sel.addEventListener('change', () => {
      paint()
      onChange(sel.value)
    })
    return { sel, paint }
  }

  private selectCell(def: FieldDef, el: HTMLElement) {
    const { sel, paint } = this.chip(def, undefined, (v) => this.ctx.setValue(this.id, def.id, v))
    el.append(sel)
    return () => {
      const v = this.ctx.getValue(this.id, def.id) || ''
      if (!isFocused(sel)) {
        sel.value = v
        if (sel.selectedIndex < 0) sel.value = ''
      }
      paint()
      el.classList.toggle('empty', !sel.value)
    }
  }

  private visualCell(def: FieldDef, el: HTMLElement) {
    const get = (): VisualValue => this.ctx.getValue(this.id, def.id) || {}
    const set = (patch: Partial<VisualValue>) => {
      const next = { ...get(), ...patch }
      const empty = !next.type && !next.desc && !next.images?.length
      this.ctx.setValue(this.id, def.id, empty ? undefined : next)
    }
    const { sel, paint } = this.chip(def, undefined, (v) => set({ type: v || undefined }))
    const desc = h('textarea', 'v-desc', { rows: '1', placeholder: 'Visual notes', 'aria-label': `${def.name} notes` }) as HTMLTextAreaElement
    desc.readOnly = !this.ctx.canEdit
    desc.addEventListener('input', () => {
      autosize(desc)
      set({ desc: desc.value })
    })
    const imgs = h('div', 'v-images')
    const count = h('span', 'v-count')
    // One visual reference per beat. The upload button only appears while you're in the
    // visual note (it keeps the note focused when pressed, so it doesn't vanish mid-click).
    const file = h('input', '', { type: 'file', accept: 'image/*', hidden: '' }) as HTMLInputElement
    const add = h('button', 'v-add', { type: 'button', title: 'Upload a visual reference image' })
    const label = () => (add.textContent = get().images?.length ? 'Replace image' : 'Upload image')
    add.addEventListener('mousedown', (e) => e.preventDefault())
    // Replacing asks first, in a bubble on the button, before the file chooser opens.
    add.addEventListener('click', async () => {
      if (get().images?.length) {
        const ok = await confirmAt(add, {
          title: 'Replace the visual reference?',
          message: 'Each beat has one. For more, create a new beat or attach the image to an annotation.',
          confirm: 'Choose new image',
        })
        if (!ok) return
      }
      file.click()
    })
    file.addEventListener('change', async () => {
      const f = file.files?.[0]
      file.value = ''
      if (!f) return
      add.textContent = 'Uploading…'
      try {
        const { url, thumb } = await this.ctx.upload(f)
        set({ images: [{ id: rid(), url, thumb, name: f.name }] })
      } catch (e: any) {
        toast(e.message || 'Upload failed', 'error')
      } finally {
        label()
      }
    })
    const head = h('div', 'v-head')
    head.append(sel, count)
    el.append(head, desc, imgs)
    if (this.ctx.canEdit) el.append(add, file)

    let shown = ''
    return () => {
      const v = get()
      if (!isFocused(sel)) {
        sel.value = v.type || ''
        if (sel.selectedIndex < 0) sel.value = ''
      }
      paint()
      if (!isFocused(desc) && desc.value !== (v.desc || '')) {
        desc.value = v.desc || ''
        autosize(desc)
      }
      const key = JSON.stringify(v.images || [])
      if (key !== shown) {
        shown = key
        imgs.replaceChildren(
          ...(v.images || []).map((im) => {
            const wrap = h('div', 'v-img')
            const a = h('a', '', { href: im.url, target: '_blank', rel: 'noopener', title: im.name })
            const img = h('img', '', { src: im.thumb || im.url, alt: im.name, loading: 'lazy', decoding: 'async' })
            a.append(img)
            wrap.append(a)
            if (this.ctx.canEdit) {
              const x = h('button', 'v-img-x', { type: 'button', title: 'Remove image', 'aria-label': `Remove ${im.name}` })
              x.textContent = '×'
              x.addEventListener('click', () => set({ images: (get().images || []).filter((i) => i.id !== im.id) }))
              wrap.append(x)
            }
            return wrap
          }),
        )
      }
      count.textContent = v.images?.length ? '▣' : ''
      if (add.textContent !== 'Uploading…') label()
      el.classList.toggle('empty', !sel.value && !v.desc && !v.images?.length)
      el.classList.toggle('has-desc', !!v.desc)
      const opt = def.options?.find((o) => o.id === v.type)
      this.dom.style.setProperty('--vcolor', opt ? opt.color : 'transparent')
    }
  }

  // ---- ProseMirror NodeView protocol

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    if (node.attrs.id !== this.id) {
      this.id = node.attrs.id
      this.bind()
    }
    return true
  }

  stopEvent(e: Event) {
    return this.meta.contains(e.target as Node)
  }

  ignoreMutation(m: ViewMutationRecord) {
    if (m.type === 'selection') return this.meta.contains(m.target)
    return !this.contentDOM.contains(m.target) || (m.type === 'attributes' && m.target === this.contentDOM)
  }

  destroy() {
    this.off.forEach((f) => f())
    this.offBeat?.()
  }
}

// ================================================================ section

export class SectionView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private id: string
  private offCollapse: () => void

  constructor(node: PMNode, private ctx: ScriptContext) {
    this.id = node.attrs.id
    this.dom = this.contentDOM = h('section', 'section')
    this.dom.dataset.section = this.id || ''
    this.offCollapse = ctx.collapsed.on(`s:${this.id}`, () => this.render())
    this.render()
  }
  private render() {
    this.dom.classList.toggle('collapsed', this.ctx.collapsed.has(`s:${this.id}`))
  }
  update(node: PMNode) {
    if (node.type.name !== 'section') return false
    if (node.attrs.id !== this.id) {
      this.offCollapse()
      this.id = node.attrs.id
      this.dom.dataset.section = this.id || ''
      this.offCollapse = this.ctx.collapsed.on(`s:${this.id}`, () => this.render())
      this.render()
    }
    return true
  }
  ignoreMutation(m: ViewMutationRecord) {
    return m.type === 'attributes' && m.target === this.dom
  }
  destroy() {
    this.offCollapse()
  }
}

// ================================================================ section title

export class SectionTitleView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private count: HTMLElement
  private toggle: HTMLButtonElement
  private off: (() => void)[] = []

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private ctx: ScriptContext,
  ) {
    this.dom = h('div', 'section-head')
    this.toggle = h('button', 'beat-toggle', { type: 'button', contenteditable: 'false', title: 'Collapse / expand section', 'aria-label': 'Collapse section' })
    this.toggle.innerHTML = CHEVRON
    this.toggle.addEventListener('mousedown', (e) => e.preventDefault())
    this.toggle.addEventListener('click', () => {
      const id = this.sectionId()
      if (id) ctx.collapsed.toggle(`s:${id}`)
    })
    this.contentDOM = h('h2', 'section-title')
    this.count = h('span', 'section-count', { contenteditable: 'false' })
    this.dom.append(this.toggle, this.contentDOM, this.count)
    this.off.push(ctx.collapsed.on('*', () => this.renderCount()))
    requestAnimationFrame(() => this.renderCount())
  }

  private section() {
    const pos = this.getPos()
    if (pos === undefined) return null
    const $pos = this.view.state.doc.resolve(pos)
    return $pos.depth > 0 ? $pos.parent : null
  }
  private sectionId(): string | null {
    return this.section()?.attrs.id ?? null
  }

  private renderCount() {
    const sec = this.section()
    const id = sec?.attrs.id
    const collapsed = id && this.ctx.collapsed.has(`s:${id}`)
    this.toggle.setAttribute('aria-expanded', String(!collapsed))
    if (!sec || !collapsed) return void (this.count.textContent = '')
    let beats = 0
    sec.forEach((c) => c.type.name === 'beat' && beats++)
    this.count.textContent = `${beats} beat${beats === 1 ? '' : 's'}`
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    return true
  }
  stopEvent(e: Event) {
    return this.toggle.contains(e.target as Node)
  }
  ignoreMutation(m: ViewMutationRecord) {
    if (m.type === 'selection') return !this.contentDOM.contains(m.target)
    return !this.contentDOM.contains(m.target)
  }
  destroy() {
    this.off.forEach((f) => f())
  }
}
