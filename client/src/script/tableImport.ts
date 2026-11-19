/**
 * Paste a table (Google Docs/Sheets, Word, Excel, Numbers…) and turn it into the script:
 *  - the first row gives the column headers;
 *  - the column with the most text becomes the beat text (Dialogue);
 *  - full-width rows (one merged cell, or only the first cell filled) become sections;
 *  - every other row becomes a beat, with its other cells as that beat's data.
 * Columns that match an existing column by name reuse it; new ones become a Visual column
 * (by name), Chips (a small set of repeated short labels) or Text.
 */
import { nextColor } from '../editor/model'
import type { FieldDef, FieldOption, FieldType } from './fields'

export const MAX_COLUMNS = 7 // Dialogue + 6

export interface Cell {
  text: string
  html: string
  span: number
  images: string[]
}

const rid = () => Math.random().toString(36).slice(2, 8)

// ---------------------------------------------------------------- clipboard -> rows

function cellText(el: Element) {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('br').forEach((b) => b.replaceWith('\n'))
  clone.querySelectorAll('p, li, div, h1, h2, h3, h4, h5, h6').forEach((b) => b.append('\n'))
  return (clone.textContent || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
}

function fromHtml(html: string): Cell[][] | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.querySelector('table')
  if (!table) return null
  const rows: Cell[][] = []
  for (const tr of table.querySelectorAll('tr')) {
    if (tr.closest('table') !== table) continue // ignore nested tables
    const cells = [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
    rows.push(
      cells.map((c) => ({
        text: cellText(c),
        html: c.innerHTML,
        span: Math.max(1, Number(c.getAttribute('colspan')) || 1),
        images: [...c.querySelectorAll('img')].map((i) => i.getAttribute('src') || '').filter(Boolean),
      })),
    )
  }
  return rows
}

/** Tab-separated text, with Sheets/Excel-style "quoted cells" that may contain newlines. */
function fromTsv(text: string): Cell[][] | null {
  const lines = text.replace(/\r\n?/g, '\n')
  if (!/\t/.test(lines)) return null
  const rows: string[][] = [[]]
  let cell = ''
  let quoted = false
  for (let i = 0; i < lines.length; i++) {
    const ch = lines[i]
    if (quoted) {
      if (ch === '"' && lines[i + 1] === '"') (cell += '"'), i++
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === '\t') rows[rows.length - 1].push(cell), (cell = '')
    else if (ch === '\n') rows[rows.length - 1].push(cell), (cell = ''), rows.push([])
    else cell += ch
  }
  rows[rows.length - 1].push(cell)
  const out = rows.filter((r) => r.some((c) => c.trim()))
  if (out.length < 2 || out.filter((r) => r.length > 1).length < 2) return null
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return out.map((r) => r.map((t) => ({ text: t.trim(), html: t.trim().split('\n').map((l) => `<p>${esc(l)}</p>`).join(''), span: 1, images: [] })))
}

/** A pasted table, or null if the clipboard doesn't hold one. */
export function readClipboardTable(data: DataTransfer | null): Cell[][] | null {
  if (!data) return null
  const html = data.getData('text/html')
  const rows = (html && /<table/i.test(html) && fromHtml(html)) || fromTsv(data.getData('text/plain'))
  if (!rows) return null
  const widest = Math.max(0, ...rows.map((r) => r.reduce((n, c) => n + c.span, 0)))
  return widest >= 2 && rows.length >= 2 ? rows : null
}

// ---------------------------------------------------------------- rows -> plan

export interface PlanBeat {
  id: string
  html: string
  values: Record<string, unknown>
  image?: string
}
export interface Plan {
  columns: number
  dialogueName: string
  fields: FieldDef[]
  sections: { title: string; beats: PlanBeat[] }[]
  beatCount: number
}

export class TableImportError extends Error {}

const looksLikeChips = (values: string[]) => {
  const v = values.filter(Boolean)
  if (!v.length) return false
  const distinct = new Set(v.map((x) => x.toLowerCase()))
  return distinct.size <= 12 && v.every((x) => x.length <= 24 && !x.includes('\n')) && (distinct.size < v.length || v.length <= 3)
}

export function planImport(rows: Cell[][], existing: FieldDef[], newId: () => string): Plan {
  // Expand colspans so every row is indexed by column.
  const grid = rows.map((r) => {
    const out: (Cell | null)[] = []
    for (const c of r) {
      out.push(c)
      for (let k = 1; k < c.span; k++) out.push(null)
    }
    return out
  })
  const header = grid[0]
  const columns = header.length
  if (columns > MAX_COLUMNS) throw new TableImportError(`Tables can have at most ${MAX_COLUMNS} columns (the dialogue plus 6 more). This table has ${columns}.`)

  const body = grid.slice(1).filter((r) => r.some((c) => c?.text || c?.images.length))
  const isSection = (r: (Cell | null)[], dialogueCol: number) => {
    const filled = r.map((c) => !!(c && (c.text || c.images.length)))
    if (r[0] && r[0].span >= columns) return true // one merged cell across the whole row
    return filled[0] && filled.filter(Boolean).length === 1 && dialogueCol !== 0 && !filled[dialogueCol]
  }

  // The dialogue is the column with the most text (ignoring section rows).
  const totals = Array.from({ length: columns }, (_, i) => body.reduce((n, r) => n + (r[0] && r[0].span >= columns ? 0 : (r[i]?.text.length ?? 0)), 0))
  const dialogueCol = totals.indexOf(Math.max(...totals))
  const beatRows = body.filter((r) => !isSection(r, dialogueCol))
  const valuesOf = (i: number) => beatRows.map((r) => r[i]?.text ?? '')

  // Columns: reuse same-named ones, otherwise infer a type.
  const byName = new Map(existing.map((f) => [f.name.trim().toLowerCase(), f]))
  let hasVisual = false
  const fields: (FieldDef | null)[] = header.map((h, i) => {
    if (i === dialogueCol) return null
    const name = (h?.text || '').split('\n')[0].trim().slice(0, 40) || `Column ${i + 1}`
    const match = byName.get(name.toLowerCase())
    let def: FieldDef
    if (match && !(match.type === 'visual' && hasVisual)) def = { ...match, name, options: match.options ? [...match.options] : undefined }
    else {
      let type: FieldType = 'text'
      if (!hasVisual && /visual|shot|camera|footage|b-?roll|a-?roll|image/i.test(name)) type = 'visual'
      else if (looksLikeChips(valuesOf(i))) type = 'select'
      def = { id: newId(), name, type, ...(type === 'text' ? {} : { options: [] as FieldOption[] }) }
    }
    if (def.type === 'visual') hasVisual = true
    return def
  })

  const optionFor = (f: FieldDef, label: string) => {
    const opts = (f.options ||= [])
    let o = opts.find((x) => x.label.toLowerCase() === label.toLowerCase())
    if (!o) {
      o = { id: rid(), label, color: nextColor(f.type, opts.map((x) => x.color)) }
      opts.push(o)
    }
    return o.id
  }

  const sections: Plan['sections'] = []
  let current: Plan['sections'][number] | null = null
  let beatCount = 0
  for (const r of body) {
    if (isSection(r, dialogueCol)) {
      current = { title: (r[0]?.text || '').split('\n')[0].slice(0, 200), beats: [] }
      sections.push(current)
      continue
    }
    if (!current) sections.push((current = { title: '', beats: [] }))
    const values: Record<string, unknown> = {}
    let image: string | undefined
    r.forEach((c, i) => {
      const f = fields[i]
      if (!f || !c) return
      const text = c.text
      if (f.type === 'text') text && (values[f.id] = text.slice(0, 200))
      else if (f.type === 'select') text && (values[f.id] = optionFor(f, text.split('\n')[0].slice(0, 40)))
      else {
        const [first, ...rest] = text.split('\n')
        const chip = first && first.length <= 24 && first.split(/\s+/).length <= 3 ? first : ''
        const desc = (chip ? rest : [first, ...rest]).join('\n').trim()
        const v: Record<string, unknown> = {}
        if (chip) v.type = optionFor(f, chip)
        if (desc) v.desc = desc.slice(0, 2000)
        if (Object.keys(v).length) values[f.id] = v
        image = c.images[0]
      }
    })
    const cell = r[dialogueCol]
    current.beats.push({ id: newId(), html: cell?.html || '', values, image })
    beatCount++
  }

  return {
    columns,
    dialogueName: (header[dialogueCol]?.text || 'Dialogue').split('\n')[0].trim().slice(0, 40) || 'Dialogue',
    fields: fields.filter((f): f is FieldDef => !!f),
    sections,
    beatCount,
  }
}
