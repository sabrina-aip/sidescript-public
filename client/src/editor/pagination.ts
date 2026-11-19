/**
 * Visual pagination for the editor.
 *
 * The document itself stays one continuous flow (so collaboration, history and
 * exports are unaffected). This plugin measures the rendered top-level blocks
 * and inserts non-editable spacer widgets where a block would cross the bottom
 * margin of a page, so the text appears on separate sheets with gaps between.
 * Blocks are kept whole; a single block taller than a page makes that page grow.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { PageGeometry } from './layout'

export const PAGE_GAP = 24

interface Break {
  pos: number // position before the block that starts a new page
  fill: number // blank space left at the bottom of the previous page's text area
}
interface PState {
  breaks: Break[]
  geometry: PageGeometry | null
}

export const paginationKey = new PluginKey<PState>('pagination')

export interface PaginationOptions {
  /** Current geometry, or null when pageless. */
  getGeometry: () => PageGeometry | null
  onPageCount: (n: number) => void
}

function spacer(b: Break, g: PageGeometry) {
  const el = document.createElement('div')
  el.className = 'pb-spacer'
  el.contentEditable = 'false'
  el.setAttribute('aria-hidden', 'true')
  el.style.height = `${b.fill + g.margin.bottom + PAGE_GAP + g.margin.top}px`
  const band = document.createElement('div')
  band.className = 'pb-band'
  band.style.top = `${b.fill + g.margin.bottom}px`
  band.style.height = `${PAGE_GAP}px`
  band.style.left = `-${g.margin.left + 2}px`
  band.style.right = `-${g.margin.right + 2}px`
  el.appendChild(band)
  return el
}

interface Item {
  pos: number // where a page break would be inserted
  top: HTMLElement // element whose top starts this item (e.g. the beat, to keep its header)
  bottom: HTMLElement // element whose bottom ends it
  keepWithNext: boolean // titles stay with what follows
}

/** Break candidates in document order: section heads, then each block inside beats. */
function collectItems(view: EditorView): Item[] {
  const items: Item[] = []
  const dom = (pos: number) => view.nodeDOM(pos) as HTMLElement | null
  view.state.doc.forEach((node, off) => {
    if (node.type.name !== 'section') {
      const el = dom(off)
      if (el instanceof HTMLElement) items.push({ pos: off, top: el, bottom: el, keepWithNext: node.type.name === 'heading' })
      return
    }
    const sectionEl = dom(off)
    node.forEach((child, coff) => {
      const cpos = off + 1 + coff
      const el = dom(cpos)
      if (!(el instanceof HTMLElement)) return
      if (child.type.name === 'sectionTitle') {
        if (sectionEl instanceof HTMLElement) items.push({ pos: off, top: sectionEl, bottom: el, keepWithNext: true })
      } else if (child.type.name === 'beat' && !el.classList.contains('collapsed')) {
        child.forEach((blk, boff) => {
          const bel = dom(cpos + 1 + boff)
          if (!(bel instanceof HTMLElement)) return
          // The first block carries the beat's header with it.
          items.push(boff === 0 ? { pos: cpos, top: el, bottom: bel, keepWithNext: false } : { pos: cpos + 1 + boff, top: bel, bottom: bel, keepWithNext: blk.type.name === 'heading' })
        })
      } else items.push({ pos: cpos, top: el, bottom: el, keepWithNext: false })
    })
  })
  return items
}

function computeBreaks(view: EditorView, g: PageGeometry) {
  const dom = view.dom as HTMLElement
  const box = dom.getBoundingClientRect()
  // The sheet may be zoomed to fit the window: convert screen pixels back to page pixels.
  const k = box.width / (g.width - g.margin.left - g.margin.right) || 1
  const base = box.top
  const contentH = g.height - g.margin.top - g.margin.bottom
  // Existing spacers shift everything below them; subtract them to get "unpaged" positions.
  const spacerEls = [...dom.querySelectorAll<HTMLElement>('.pb-spacer')]
  const spacers = spacerEls.map((s) => ({ top: (s.getBoundingClientRect().top - base) / k, h: s.getBoundingClientRect().height / k }))
  const unpaged = (y: number) => {
    let shift = 0
    for (const s of spacers) if (s.top < y - 0.5) shift += s.h
    return y - shift
  }
  // Gap bands span the full sheet width wherever the spacer sits (e.g. inside an indented beat).
  for (const s of spacerEls) {
    const r = s.getBoundingClientRect()
    const band = s.firstElementChild as HTMLElement | null
    if (!band) continue
    band.style.left = `-${g.margin.left + (r.left - box.left) / k + 2}px`
    band.style.right = `-${g.margin.right + (box.right - r.right) / k + 2}px`
  }

  const breaks: Break[] = []
  let pageStart = 0
  let prev: { pos: number; top: number; keep: boolean } | null = null
  for (const it of collectItems(view)) {
    const tr = it.top.getBoundingClientRect()
    const br = it.bottom.getBoundingClientRect()
    if (!tr.height && !tr.width) continue // hidden (collapsed)
    const top = unpaged((tr.top - base) / k)
    const bottom = top + (br.bottom - tr.top) / k
    if (prev && bottom - pageStart > contentH + 0.5 && top > pageStart + 0.5) {
      const at = prev.keep && prev.top > pageStart + 0.5 ? prev : { pos: it.pos, top }
      breaks.push({ pos: at.pos, fill: Math.max(0, Math.round(pageStart + contentH - at.top)) })
      pageStart = at.top
    }
    // An oversized block makes its page taller; the next block starts a fresh page.
    if (bottom - pageStart > contentH) pageStart = bottom - contentH
    prev = { pos: it.pos, top, keep: it.keepWithNext }
  }
  return { breaks, lastPageStart: pageStart }
}

const sameBreaks = (a: Break[], b: Break[]) => a.length === b.length && a.every((x, i) => x.pos === b[i].pos && Math.abs(x.fill - b[i].fill) <= 1)

export const Pagination = Extension.create<PaginationOptions>({
  name: 'pagination',

  addOptions() {
    return { getGeometry: () => null, onPageCount: () => {} }
  },

  addProseMirrorPlugins() {
    const opts = this.options
    return [
      new Plugin<PState>({
        key: paginationKey,
        state: {
          init: () => ({ breaks: [], geometry: null }),
          apply(tr, value) {
            const meta = tr.getMeta(paginationKey) as PState | undefined
            if (meta) return meta
            if (!tr.docChanged || !value.breaks.length) return value
            return { ...value, breaks: value.breaks.map((b) => ({ ...b, pos: tr.mapping.map(b.pos) })) }
          },
        },
        props: {
          decorations(state) {
            const { breaks, geometry } = paginationKey.getState(state)!
            if (!geometry || !breaks.length) return DecorationSet.empty
            return DecorationSet.create(
              state.doc,
              breaks.map((b, i) => Decoration.widget(b.pos, () => spacer(b, geometry), { side: -1, key: `pb-${i}-${b.fill}-${geometry.height}`, ignoreSelection: true })),
            )
          },
        },
        view(view) {
          let frame = 0
          let settle = 0 // guards against measurement ping-pong
          let lastCount = -1
          const page = () => (view.dom as HTMLElement).closest<HTMLElement>('.page')

          const measure = () => {
            frame = 0
            const g = opts.getGeometry()
            const cur = paginationKey.getState(view.state)!
            const el = page()
            if (!g) {
              if (el) el.style.minHeight = ''
              if (cur.breaks.length || cur.geometry) view.dispatch(view.state.tr.setMeta(paginationKey, { breaks: [], geometry: null }).setMeta('addToHistory', false))
              if (lastCount !== 0) opts.onPageCount((lastCount = 0))
              return
            }
            const { breaks, lastPageStart } = computeBreaks(view, g)
            const geometryChanged = cur.geometry?.height !== g.height || cur.geometry?.margin.top !== g.margin.top || cur.geometry?.margin.bottom !== g.margin.bottom || cur.geometry?.margin.left !== g.margin.left
            if (geometryChanged) settle = 0
            if ((geometryChanged || !sameBreaks(breaks, cur.breaks)) && settle < 4) {
              settle++
              view.dispatch(view.state.tr.setMeta(paginationKey, { breaks, geometry: g }).setMeta('addToHistory', false))
            }
            // Pad the sheet so the last page is a full page tall.
            const spacerTotal = breaks.reduce((s, b) => s + b.fill + g.margin.bottom + PAGE_GAP + g.margin.top, 0)
            const contentH = g.height - g.margin.top - g.margin.bottom
            if (el) el.style.minHeight = `${g.margin.top + lastPageStart + spacerTotal + contentH + g.margin.bottom}px`
            const count = breaks.length + 1
            if (count !== lastCount) opts.onPageCount((lastCount = count))
          }
          // While typing, measure once you pause (re-measuring a 100-page script on every
          // keystroke would add visible lag). Other changes are picked up on the next frame.
          let idle = 0
          let typingUntil = 0
          const schedule = () => {
            if (performance.now() < typingUntil) {
              clearTimeout(idle)
              idle = window.setTimeout(() => {
                if (!frame) frame = requestAnimationFrame(measure)
              }, 300)
              return
            }
            if (!frame) frame = requestAnimationFrame(measure)
          }

          // Heights change when images load, fonts swap, or the page size changes.
          const ro = new ResizeObserver(schedule)
          ro.observe(view.dom)
          const onLoad = () => schedule()
          view.dom.addEventListener('load', onLoad, true)
          schedule()

          return {
            update(v, prev) {
              if (v.state.doc !== prev.doc) {
                settle = 0
                typingUntil = performance.now() + 300
              }
              if (paginationKey.getState(v.state) !== paginationKey.getState(prev) && v.state.doc === prev.doc) return
              schedule()
            },
            destroy() {
              cancelAnimationFrame(frame)
              clearTimeout(idle)
              ro.disconnect()
              view.dom.removeEventListener('load', onLoad, true)
            },
          }
        },
      }),
    ]
  },
})

/** Ask the plugin to re-measure (e.g. after the page size changed). */
export function refreshPagination(view: EditorView) {
  view.dispatch(view.state.tr.setMeta('pagination-refresh', true).setMeta('addToHistory', false))
}
