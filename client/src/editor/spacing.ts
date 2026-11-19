/**
 * Line spacing and space after paragraphs, set per paragraph/heading (like Google Docs'
 * "Line & paragraph spacing"). Stored as block attributes, so they sync, undo, paste
 * and export like any other formatting.
 */
import { Extension } from '@tiptap/core'

export const DEFAULT_LINE_HEIGHT = 1 // single: the script's normal spacing (see .doc-body in styles.css)
export const LINE_HEIGHTS = [DEFAULT_LINE_HEIGHT, 1.15, 1.5, 2]
/** null = none (the default). 'none' is still read from older scripts and means the same. */
export type SpaceAfter = 'small' | 'large' | 'none' | null

const TYPES = ['paragraph', 'heading']
const clampLH = (n: number) => Math.min(3, Math.max(0.8, Math.round(n * 100) / 100))

/** CSS line-height (pasted "1.38", "150%", "normal") -> a number, or null for default. */
function lineHeightFromCss(v: string) {
  const s = (v || '').trim()
  if (!s || s === 'normal') return null
  const m = /^([\d.]+)(%)?$/.exec(s)
  if (!m) return null
  const n = m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1])
  return n > 0 ? clampLH(n) : null
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    spacing: {
      setLineSpacing: (value: number | null) => ReturnType
      setSpaceAfter: (value: SpaceAfter) => ReturnType
    }
  }
}

export const Spacing = Extension.create({
  name: 'spacing',
  addGlobalAttributes() {
    return [
      {
        types: TYPES,
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => lineHeightFromCss(el.style.lineHeight),
            renderHTML: (a) => (a.lineHeight ? { style: `line-height: ${a.lineHeight}` } : {}),
          },
          // A CSS variable rather than margin-bottom, so the last paragraph of a beat keeps no gap.
          spaceAfter: {
            default: null,
            parseHTML: (el) => {
              const mb = parseFloat(el.style.marginBottom)
              if (Number.isNaN(mb)) {
                const v = el.getAttribute('data-space-after')
                return v === 'small' || v === 'large' ? v : null
              }
              return mb <= 0 ? null : mb >= 14 ? 'large' : 'small'
            },
            renderHTML: (a) =>
              a.spaceAfter === 'small' ? { 'data-space-after': 'small', style: '--space-after: 0.8em' } : a.spaceAfter === 'large' ? { 'data-space-after': 'large', style: '--space-after: 1.6em' } : {},
          },
        },
      },
    ]
  },
  addCommands() {
    const each =
      (attrs: Record<string, unknown>) =>
      ({ chain }: { chain: () => any }) =>
        TYPES.reduce((c, t) => c.updateAttributes(t, attrs), chain()).run()
    return {
      setLineSpacing: (value) => each({ lineHeight: value === null || value === DEFAULT_LINE_HEIGHT ? null : clampLH(value) }),
      setSpaceAfter: (value) => each({ spaceAfter: value === 'none' ? null : value }),
    }
  },
})
