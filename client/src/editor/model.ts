import { useEffect, useMemo, useReducer } from 'react'
import * as Y from 'yjs'

export type Kind = 'note' | 'image' | 'citation' | 'link' | 'media' | 'file'

export const KINDS: { id: Kind; label: string; help: string }[] = [
  { id: 'note', label: 'Notes', help: 'Free text — ideas, direction, reminders' },
  { id: 'image', label: 'Images', help: 'Reference images, stills, mood boards' },
  { id: 'citation', label: 'Citations', help: 'Author, title, source, year, page, URL' },
  { id: 'link', label: 'Links', help: 'A URL with a description' },
  { id: 'media', label: 'Audio / video', help: 'Clips, voice memos, reference footage' },
  { id: 'file', label: 'Files', help: 'PDFs and other attachments' },
]

export interface Category {
  id: string
  name: string
  color: string
  kind: Kind
  order: number
}

/**
 * Something attached to an annotation. `type` is a MIME type for files ('image/png',
 * 'video/mp4'…), 'link' for a link card, or 'video/embed' for a YouTube/Vimeo player.
 * Files, thumbnails and previews are always stored on this server (`url`, `thumb`).
 */
export interface Attachment {
  id: string
  name: string
  type: string
  url?: string
  size?: number
  href?: string // the original link
  title?: string
  site?: string
  author?: string
  date?: string
  thumb?: string
  embed?: string // player URL, loaded only when someone clicks play
  provider?: string
}

export interface Citation {
  author?: string
  title?: string
  source?: string
  year?: string
  pages?: string
  url?: string
  accessed?: string
}

export interface Note {
  id: string
  category: string
  text: string
  url?: string
  citation?: Citation
  attachments: Attachment[]
  author: string
  authorName: string
  createdAt: string
  updatedAt: string
  /** Finished (shown as a tidy read-only card). Missing on older notes: see isNoteDone. */
  done?: boolean
  /** Set when a finished annotation is changed later. */
  editedAt?: string
  editedByName?: string
  /** Conversation on the annotation. */
  replies?: Reply[]
  /** emoji -> who reacted */
  reactions?: Record<string, { u: string; n: string }[]>
  /** Marked complete: the card moves to "Completed" and the highlight fades to an underline. */
  completed?: boolean
  completedAt?: string
  completedByName?: string
  completedBy?: string
}

export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅']

/** Older notes have no `done` flag: treat any with content as finished. */
export const isNoteDone = (n: Note) => n.done ?? !!(n.text?.trim() || n.attachments?.length)

export interface Reply {
  id: string
  author: string
  authorName: string
  text: string
  createdAt: string
  /** Annotation replies can carry their own links, images and files. */
  attachments?: Attachment[]
  editedAt?: string
  /** Deleted replies stay as a "Reply deleted" placeholder so the thread still reads. */
  deleted?: boolean
}

export interface Thread {
  id: string
  author: string
  authorName: string
  text: string
  createdAt: string
  resolved: boolean
  draft?: boolean
  replies: Reply[]
}

export function getMaps(doc: Y.Doc) {
  return {
    meta: doc.getMap<any>('meta'),
    categories: doc.getMap<Category>('categories'),
    notes: doc.getMap<Note>('notes'),
    comments: doc.getMap<Thread>('comments'),
    fields: doc.getMap<any>('fields'),
  }
}

/** Re-render when a Y.Map changes; returns a stable snapshot of its values. */
export function useYMap<T>(map: Y.Map<T>): Map<string, T> {
  const [version, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const f = () => bump()
    map.observe(f)
    return () => map.unobserve(f)
  }, [map])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => new Map(map.entries()), [map, version])
}

export const sortCategories = (cats: Map<string, Category>) => [...cats.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

/**
 * The Sidescript palette: 7 pairs, like Google Docs' picker (a light row over a deep row),
 * built on the "Cool & Refined" colours. It is offered under the colour selector everywhere.
 *  - Light colours: light chips with a dark shade of their own hue as text; for annotations,
 *    a highlighter behind the text.
 *  - Deep colours: solid chips with white text at 85% (e.g. Montage, edited).
 * Defaults are in server/docmodel.js, server/script.js and script/fields.ts.
 */
export const PALETTE: { name: string; light: string; deep: string; lightName: string; deepName: string }[] = [
  { name: 'Gray', lightName: 'Mild Gray', light: '#d5d1c9', deepName: 'Charcoal', deep: '#333740' },
  { name: 'Red', lightName: 'Mild Red', light: '#ff767f', deepName: 'Garnet', deep: '#92272b' },
  { name: 'Yellow', lightName: 'Mild Yellow', light: '#f2d67a', deepName: 'Vermilion', deep: '#be4f25' },
  { name: 'Green', lightName: 'Mild Green', light: '#a7ce5b', deepName: 'Fern', deep: '#337846' },
  { name: 'Teal', lightName: 'Mild Teal', light: '#8ed1c6', deepName: 'Deep Teal', deep: '#185a65' },
  { name: 'Blue', lightName: 'Mild Dark Blue', light: '#95b3ee', deepName: 'Harbour Blue', deep: '#4379a8' },
  { name: 'Violet', lightName: 'Mild Violet', light: '#d0b8f1', deepName: 'Violet', deep: '#71419c' },
]
const L = Object.fromEntries(PALETTE.map((p) => [p.name, p.light]))
const D = Object.fromEntries(PALETTE.map((p) => [p.name, p.deep]))
// The order new layers / options take colours in.
export const ANNOTATION_COLORS = [L.Green, L.Blue, L.Red, L.Violet, L.Teal, L.Yellow, L.Gray]
export const VISUAL_COLORS = [L.Yellow, L.Red, L.Blue, D.Gray, L.Gray, L.Green, L.Teal, L.Violet, D.Teal, D.Violet, D.Blue, D.Green, D.Yellow, D.Red]
export const STATUS_COLORS = [L.Gray, L.Red, L.Blue, L.Yellow, L.Green, D.Gray, L.Violet, L.Teal]
export const PRESET_COLORS = ANNOTATION_COLORS

/** How strongly an annotation's colour is laid behind the text: light colours act as a
 * highlighter; darker ones (older scripts) stay a tint with an underline. */
export function highlightStyle(hex: string, dark = false) {
  const n = parseInt(hex.slice(1), 16)
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  const light = lum > 150
  return { alpha: dark ? 0.32 : light ? 0.7 : 0.26, underline: !light || dark }
}

/** The annotation layers a new script starts with (kept in sync with server/docmodel.js). */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'sources', name: 'Citations', color: '#a7ce5b', kind: 'citation', order: 0 },
  { id: 'overlay', name: 'Graphics', color: '#95b3ee', kind: 'image', order: 1 },
  { id: 'ideas', name: 'Tasks', color: '#ff767f', kind: 'note', order: 2 },
]

export type PaletteKind = 'annotation' | 'visual' | 'select' | 'text'
export const paletteFor = (kind: PaletteKind) => (kind === 'annotation' ? ANNOTATION_COLORS : kind === 'visual' ? VISUAL_COLORS : STATUS_COLORS)

/** The first colour of that palette not already used. */
export const nextColor = (kind: PaletteKind, used: string[]) => {
  const taken = new Set(used.map((c) => c.toLowerCase()))
  const p = paletteFor(kind)
  return p.find((c) => !taken.has(c)) || p[used.length % p.length]
}

export function formatCitation(c: Citation = {}) {
  const parts = [
    c.author && `${c.author}.`,
    c.year && `(${c.year}).`,
    c.title && `“${c.title}.”`,
    c.source && `${c.source}.`,
    c.pages && `pp. ${c.pages}.`,
    c.url && c.url,
    c.accessed && `Accessed ${c.accessed}.`,
  ].filter(Boolean)
  return parts.join(' ')
}
