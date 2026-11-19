import * as Y from 'yjs'

export type FieldType = 'text' | 'select' | 'visual'

export interface FieldOption {
  id: string
  label: string
  color: string
}

export interface FieldDef {
  id: string
  name: string
  type: FieldType
  options?: FieldOption[]
}

/** Value of a `visual` field: type chip + optional notes + images. */
export interface VisualValue {
  type?: string
  desc?: string
  images?: { id: string; url: string; thumb?: string; name: string }[]
}

/** Columns besides Dialogue (which is always there). Keeps the table usable on a laptop. */
export const MAX_FIELDS = 6

/** Section bar colour when a document hasn't chosen one. */
export const DEFAULT_SECTION_COLOR = '#d5dae2' // rgb(213, 218, 226)

// Kept in sync with server/script.js (used if a document has no field key yet).
export const DEFAULT_FIELDS: FieldDef[] = [
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

export function getFieldList(fields: Y.Map<any>): FieldDef[] {
  const list = fields.get('list')
  // An empty list is valid (Dialogue only); only a missing key falls back to the defaults.
  return Array.isArray(list) ? list : DEFAULT_FIELDS
}

/** Visual fields sit left of the dialogue in the table; everything else to the right. */
/** Table column template. `widths` (px, per field id) come from dragging the header edges;
 *  the Dialogue column always takes the remaining space. */
export function tableColumns(list: FieldDef[], widths: Record<string, number> = {}) {
  const before = list.filter((f) => f.type === 'visual')
  const after = list.filter((f) => f.type !== 'visual')
  const width = (f: FieldDef) =>
    widths[f.id] ? `${Math.round(widths[f.id])}px` : f.type === 'visual' ? 'minmax(160px, 28%)' : f.type === 'select' ? '148px' : '84px'
  return {
    before,
    after,
    template: [...before.map(width), 'minmax(0, 1fr)', ...after.map(width)].join(' '),
    column: (id: string) => {
      const i = before.findIndex((f) => f.id === id)
      if (i >= 0) return i + 1
      return before.length + 2 + after.findIndex((f) => f.id === id)
    },
    bodyColumn: before.length + 1,
  }
}

/**
 * Text colour for a chip (Google style): rich, dark colours get white text at 85% (so a little
 * of the chip's colour shows through); light ones get a deep shade of their own hue.
 */
/** Chips this dark need lifting in the dark theme (see .chip-dark). */
export function isVeryDark(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 70
}

export function chipText(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const l = 0.299 * r + 0.587 * g + 0.114 * b
  if (l <= 150) return 'rgba(255, 255, 255, 0.85)' // white, with a tinge of the chip's own colour
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const d = max - min
  if (d < 0.08) return '#2b2d31' // greys: near-black, faintly warm or cool
  let h = max === r / 255 ? ((g - b) / 255 / d) % 6 : max === g / 255 ? (b - r) / 255 / d + 2 : (r - g) / 255 / d + 4
  h = Math.round(h * 60 + 360) % 360
  // Yellows and greens need to be darker than blues and reds to read as well.
  const light = h >= 40 && h <= 170 ? 20 : 26
  return `hsl(${h} 70% ${light}%)`
}
