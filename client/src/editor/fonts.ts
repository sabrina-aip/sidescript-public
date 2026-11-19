/**
 * Fonts. All are served from this server (never a font CDN):
 *  - Inconsolata and OpenDyslexic ship with the app.
 *  - Times New Roman, Arial and Comic Sans use the real font when the device has it,
 *    otherwise a bundled, metrically compatible stand-in (Tinos, Arimo, Comic Neue),
 *    so text wraps and paginates the same for every collaborator.
 * Font files are only downloaded when text actually uses that font.
 */
import '@fontsource/tinos/400.css'
import '@fontsource/tinos/400-italic.css'
import '@fontsource/tinos/700.css'
import '@fontsource/tinos/700-italic.css'
import '@fontsource-variable/arimo/wght.css'
import '@fontsource-variable/arimo/wght-italic.css'
import '@fontsource/comic-neue/400.css'
import '@fontsource/comic-neue/400-italic.css'
import '@fontsource/comic-neue/700.css'
import '@fontsource/comic-neue/700-italic.css'
import '@fontsource-variable/inconsolata/wght.css'
import '@fontsource/opendyslexic/400.css'
import '@fontsource/opendyslexic/400-italic.css'
import '@fontsource/opendyslexic/700.css'
import '@fontsource/opendyslexic/700-italic.css'
import { Extension } from '@tiptap/core'

export type FontId = 'times' | 'arial' | 'comic' | 'inconsolata' | 'dyslexic'

export const FONTS: { id: FontId; label: string; stack: string; match: RegExp }[] = [
  { id: 'times', label: 'Times New Roman', stack: "'Times New Roman', Tinos, Times, serif", match: /times|tinos/i },
  { id: 'arial', label: 'Arial', stack: "Arial, 'Arimo Variable', Helvetica, sans-serif", match: /arial|arimo|helvetica/i },
  { id: 'comic', label: 'Comic Sans', stack: "'Comic Sans MS', 'Comic Sans', 'Comic Neue', cursive", match: /comic/i },
  { id: 'inconsolata', label: 'Inconsolata', stack: "'Inconsolata Variable', Inconsolata, monospace", match: /inconsolata/i },
  // Designed for dyslexic readers (weighted letter bottoms, distinct shapes). SIL Open Font Licence.
  { id: 'dyslexic', label: 'OpenDyslexic', stack: "OpenDyslexic, 'Comic Sans MS', sans-serif", match: /opendyslexic/i },
]

const byId = new Map(FONTS.map((f) => [f.id, f]))

/** CSS font stack for a font id. */
export const fontStack = (id: FontId) => byId.get(id)?.stack ?? FONTS[3].stack

/** Map any CSS font-family (e.g. pasted from Google Docs) onto one of ours, or none. */
export function fontFromCss(family: string | null | undefined): FontId | null {
  if (!family) return null
  return FONTS.find((f) => f.match.test(family))?.id ?? null
}

// ---------------------------------------------------------------- sizes (points, like Google Docs)

/** Unstyled script text is 11pt (see .doc-body in styles.css). */
export const DEFAULT_SIZE = 11
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72]
export const MIN_SIZE = 6
export const MAX_SIZE = 96

export const clampSize = (pt: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(pt * 2) / 2))

/** CSS font-size (e.g. pasted "11pt", "14.6667px", "1.2em") -> points, or null. */
export function sizeFromCss(css: string | null | undefined): number | null {
  const m = /^([\d.]+)(pt|px|em|rem)?$/.exec((css || '').trim())
  if (!m) return null
  const n = parseFloat(m[1])
  const pt = m[2] === 'px' ? n * 0.75 : m[2] === 'em' || m[2] === 'rem' ? n * DEFAULT_SIZE : m[2] === 'pt' ? n : null
  return pt && pt > 0 ? clampSize(pt) : null
}

/** Next size up or down in the standard list. */
export function stepSize(current: number, dir: 1 | -1) {
  if (dir > 0) return FONT_SIZES.find((s) => s > current) ?? clampSize(current + 12)
  return [...FONT_SIZES].reverse().find((s) => s < current) ?? clampSize(current - 1)
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    font: {
      setFont: (id: FontId) => ReturnType
      unsetFont: () => ReturnType
      setTextSize: (pt: number) => ReturnType
      stepTextSize: (dir: 1 | -1) => ReturnType
    }
  }
}

/** Stores a font id (not a raw CSS stack) on the textStyle mark, so stacks can improve later. */
export const Font = Extension.create({
  name: 'font',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          font: {
            default: null,
            // The whole script uses one font (Document settings), so pasted fonts aren't kept.
            parseHTML: () => null,
            renderHTML: (attrs) => {
              const f = attrs.font ? byId.get(attrs.font) : null
              return f ? { 'data-font': f.id, style: `font-family: ${f.stack}` } : {}
            },
          },
          size: {
            default: null,
            // One text size for the whole script (Document settings): pasted sizes aren't kept.
            parseHTML: () => null,
            renderHTML: (attrs) => (attrs.size ? { style: `font-size: ${attrs.size}pt` } : {}),
          },
        },
      },
    ]
  },
  addCommands() {
    return {
      setFont:
        (id) =>
        ({ chain }) =>
          chain().setMark('textStyle', { font: id }).run(),
      unsetFont:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { font: null }).removeEmptyTextStyle().run(),
      // The normal size is stored as "no size", so text keeps following the default.
      setTextSize:
        (pt) =>
        ({ chain }) => {
          const size = clampSize(pt)
          return size === DEFAULT_SIZE ? chain().setMark('textStyle', { size: null }).removeEmptyTextStyle().run() : chain().setMark('textStyle', { size }).run()
        },
      stepTextSize:
        (dir) =>
        ({ editor, commands }) =>
          commands.setTextSize(stepSize(Number(editor.getAttributes('textStyle').size) || DEFAULT_SIZE, dir)),
    }
  },
})

/** Text sizes offered in Document settings. */
export const DOC_SIZES = [9, 10, 10.5, 11, 12, 13, 14, 16, 18, 20, 24]
