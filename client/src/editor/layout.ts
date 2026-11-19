import { FONTS, type FontId } from './fonts'
/** Display settings (font, size, page setup). Personal: see displayPrefs.ts. */
export interface PageLayout {
  mode: 'paged' | 'pageless'
  size: PageSizeId
  orientation: 'portrait' | 'landscape'
  margins: MarginId
  /** The one font the whole script uses (text, section titles, chips, notes, column headers). */
  font: FontId
  /** Text size in points for the whole script. */
  fontSize: number
}

export type PageSizeId = 'letter' | 'a4' | 'legal' | 'a5' | 'executive' | 'tabloid' | 'a3'
export type MarginId = 'normal' | 'narrow' | 'moderate' | 'wide'

const MM = 1 / 25.4 // mm -> inches

/** Sizes in inches (portrait). */
export const PAGE_SIZES: Record<PageSizeId, { label: string; w: number; h: number }> = {
  letter: { label: 'Letter (8.5 × 11 in)', w: 8.5, h: 11 },
  a4: { label: 'A4 (210 × 297 mm)', w: 210 * MM, h: 297 * MM },
  legal: { label: 'Legal (8.5 × 14 in)', w: 8.5, h: 14 },
  a5: { label: 'A5 (148 × 210 mm)', w: 148 * MM, h: 210 * MM },
  executive: { label: 'Executive (7.25 × 10.5 in)', w: 7.25, h: 10.5 },
  tabloid: { label: 'Tabloid (11 × 17 in)', w: 11, h: 17 },
  a3: { label: 'A3 (297 × 420 mm)', w: 297 * MM, h: 420 * MM },
}

/** Margins in inches: top, right, bottom, left. */
export const MARGINS: Record<MarginId, { label: string; t: number; r: number; b: number; l: number }> = {
  normal: { label: 'Normal (1 in)', t: 1, r: 1, b: 1, l: 1 },
  narrow: { label: 'Narrow (0.5 in)', t: 0.5, r: 0.5, b: 0.5, l: 0.5 },
  moderate: { label: 'Moderate (1 × 0.75 in)', t: 1, r: 0.75, b: 1, l: 0.75 },
  wide: { label: 'Wide (1 × 2 in)', t: 1, r: 2, b: 1, l: 2 },
}

// New (and never-configured) scripts are pageless; Pages is one click away in the status bar.
// Margins default to Narrow; in pageless view they set the left and right edges of the text.
export const DEFAULT_LAYOUT: PageLayout = { mode: 'pageless', size: 'letter', orientation: 'portrait', margins: 'narrow', font: 'inconsolata', fontSize: 11 }

export function normalizeLayout(v: unknown): PageLayout {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<PageLayout>
  return {
    mode: o.mode === 'paged' ? 'paged' : 'pageless',
    size: o.size && o.size in PAGE_SIZES ? o.size : DEFAULT_LAYOUT.size,
    orientation: o.orientation === 'landscape' ? 'landscape' : 'portrait',
    margins: o.margins && o.margins in MARGINS ? o.margins : DEFAULT_LAYOUT.margins,
    font: FONTS.some((f) => f.id === o.font) ? (o.font as FontId) : DEFAULT_LAYOUT.font,
    fontSize: typeof o.fontSize === 'number' && o.fontSize >= 6 && o.fontSize <= 36 ? o.fontSize : DEFAULT_LAYOUT.fontSize,
  }
}

const PX = 96 // CSS pixels per inch

/** Page geometry in CSS pixels plus the matching print CSS. */
export function pageGeometry(layout: PageLayout) {
  const s = PAGE_SIZES[layout.size]
  const [wIn, hIn] = layout.orientation === 'landscape' ? [s.h, s.w] : [s.w, s.h]
  const m = MARGINS[layout.margins]
  const r = (n: number) => Math.round(n * PX)
  return {
    width: r(wIn),
    height: r(hIn),
    margin: { top: r(m.t), right: r(m.r), bottom: r(m.b), left: r(m.l) },
    cssSize: `${wIn.toFixed(3)}in ${hIn.toFixed(3)}in`,
    cssMargin: `${m.t}in ${m.r}in ${m.b}in ${m.l}in`,
  }
}

export type PageGeometry = ReturnType<typeof pageGeometry>

/** Left/right padding (CSS px) for pageless view, from the same Margins setting. */
export function pagelessInset(layout: PageLayout) {
  const m = MARGINS[layout.margins]
  return { left: Math.round(m.l * PX), right: Math.round(m.r * PX) }
}
