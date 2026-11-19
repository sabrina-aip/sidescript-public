import type { Editor } from '@tiptap/core'
import * as Y from 'yjs'
import { bytesToBase64, downloadBlob, escapeHtml, safeFilename, tint } from '../util'
import { formatCitation, highlightStyle, type Attachment, type Category, type Note, type Thread } from './model'
import { htmlToMarkdown } from './convert'
import type { PageGeometry } from './layout'
import type { FieldDef, VisualValue } from '../script/fields'

export type Format = 'pdf' | 'docx' | 'html' | 'md' | 'txt' | 'sidescript'

export const FORMATS: { id: Format; label: string; ext: string }[] = [
  { id: 'pdf', label: 'PDF / Print', ext: 'pdf' },
  { id: 'docx', label: 'Word document (.doc)', ext: 'doc' },
  { id: 'html', label: 'Web page (.html)', ext: 'html' },
  { id: 'md', label: 'Markdown (.md)', ext: 'md' },
  { id: 'txt', label: 'Plain text — script only (.txt)', ext: 'txt' },
  { id: 'sidescript', label: 'Sidescript backup — everything, lossless (.json)', ext: 'sidescript.json' },
]

export interface ExportOptions {
  layers: Set<string> // category ids whose highlights are kept
  highlights: boolean // keep coloured backgrounds on the text
  notes: boolean // append notes for the kept layers as numbered endnotes
  comments: boolean
  table: boolean // beats as a table with their data (Visual · Dialogue · Scene · Status)
}

interface Ctx {
  editor: Editor
  ydoc: Y.Doc
  title: string
  categories: Category[]
  notes: Map<string, Note>
  comments: Map<string, Thread>
  page: PageGeometry
  landscape: boolean
  /** The document's font (CSS stack). */
  font: string
  fontSize: number
  fields: FieldDef[]
  dialogueName: string
  sectionColor: string
  beatData: (id: string) => Record<string, any>
}

const unwrap = (el: Element) => el.replaceWith(...el.childNodes)

/** Build a clean, layer-filtered HTML body plus endnotes. */
function buildBody(ctx: Ctx, opts: ExportOptions) {
  const dom = new DOMParser().parseFromString(`<div id="root">${ctx.editor.getHTML()}</div>`, 'text/html')
  const root = dom.getElementById('root')!
  const cats = new Map(ctx.categories.map((c) => [c.id, c]))
  const numbers = new Map<string, number>()
  const order: { n: number; kind: 'note' | 'comment'; id: string; excerpt: string }[] = []

  const lastOf = (selector: string) => {
    const map = new Map<string, Element>()
    root.querySelectorAll(selector).forEach((el) => map.set(el.getAttribute(selector.includes('ann') ? 'data-ann' : 'data-comment')!, el))
    return map
  }
  const lastAnn = lastOf('mark[data-ann]')
  const lastCmt = lastOf('span[data-comment]')

  const excerpts = new Map<string, string>()
  root.querySelectorAll('mark[data-ann], span[data-comment]').forEach((el) => {
    const id = el.getAttribute('data-ann') || el.getAttribute('data-comment')!
    excerpts.set(id, ((excerpts.get(id) || '') + ' ' + el.textContent).trim())
  })

  const ref = (id: string, kind: 'note' | 'comment') => {
    let n = numbers.get(id)
    if (!n) {
      n = numbers.size + 1
      numbers.set(id, n)
      order.push({ n, kind, id, excerpt: excerpts.get(id) || '' })
    }
    const sup = dom.createElement('sup')
    const a = dom.createElement('a')
    a.className = 'fn-ref'
    a.href = `#fn-${n}`
    a.id = `ref-${n}`
    a.textContent = String(n)
    sup.appendChild(a)
    return sup
  }

  // Walk in document order so endnote numbers follow the text.
  root.querySelectorAll('mark[data-ann], span[data-comment]').forEach((el) => {
    if (el.matches('mark[data-ann]')) {
      const id = el.getAttribute('data-ann')!
      const cat = cats.get(el.getAttribute('data-cat') || '')
      const keep = cat && opts.layers.has(cat.id) && ctx.notes.has(id)
      if (keep && opts.notes && lastAnn.get(id) === el) el.after(ref(id, 'note'))
      if (keep && opts.highlights) {
        const span = dom.createElement('span')
        const hl = highlightStyle(cat!.color)
        span.setAttribute('style', `background:${tint(cat!.color, hl.alpha)};${hl.underline ? `border-bottom:2px solid ${cat!.color}` : ''}`)
        span.append(...el.childNodes)
        el.replaceWith(span)
      } else unwrap(el)
    } else {
      const id = el.getAttribute('data-comment')!
      const t = ctx.comments.get(id)
      const keep = opts.comments && t && !t.draft
      if (keep && lastCmt.get(id) === el) el.after(ref(id, 'comment'))
      if (keep && opts.highlights) {
        const span = dom.createElement('span')
        span.setAttribute('style', 'background:rgba(250,204,21,.3)')
        span.append(...el.childNodes)
        el.replaceWith(span)
      } else unwrap(el)
    }
  })

  // Endnotes, grouped by layer in key order (comments last).
  let notesHtml = ''
  if (order.length) {
    const groups: string[] = []
    const item = (o: (typeof order)[number], body: string) =>
      `<li id="fn-${o.n}" value="${o.n}"><a class="fn-back" href="#ref-${o.n}">${o.n}.</a> <span class="fn-quote">“${escapeHtml(o.excerpt.slice(0, 160))}${o.excerpt.length > 160 ? '…' : ''}”</span>${body}</li>`
    for (const c of ctx.categories) {
      const mine = order.filter((o) => o.kind === 'note' && ctx.notes.get(o.id)?.category === c.id)
      if (!mine.length) continue
      const items = mine.map((o) => item(o, noteHtml(ctx.notes.get(o.id)!))).join('')
      groups.push(`<h3 style="border-left:6px solid ${c.color};padding-left:8px">${escapeHtml(c.name)}</h3><ol class="endnotes">${items}</ol>`)
    }
    const cm = order.filter((o) => o.kind === 'comment')
    if (cm.length) {
      const items = cm
        .map((o) => {
          const t = ctx.comments.get(o.id)!
          const replies = t.replies.map((r) => `<div class="fn-reply"><b>${escapeHtml(r.authorName)}:</b> ${escapeHtml(r.text)}</div>`).join('')
          return item(o, `<div><b>${escapeHtml(t.authorName)}:</b> ${escapeHtml(t.text)}</div>${replies}`)
        })
        .join('')
      groups.push(`<h3>Comments</h3><ol class="endnotes">${items}</ol>`)
    }
    notesHtml = `<section class="notes"><h2>Notes</h2>${groups.join('')}</section>`
  }
  if (opts.table) scriptTable(ctx, dom, root)
  else {
    // Script only: section titles become headings, beats plain paragraphs.
    root.querySelectorAll('h2[data-section-title]').forEach((h) => h.removeAttribute('data-section-title'))
  }
  return { body: root.innerHTML, notesHtml, dom }
}

/** Replace sections/beats with one table: a header row, a bar per section, a row per beat. */
function scriptTable(ctx: Ctx, dom: Document, root: HTMLElement) {
  const before = ctx.fields.filter((f) => f.type === 'visual')
  const after = ctx.fields.filter((f) => f.type !== 'visual')
  const table = dom.createElement('table')
  table.className = 'script'
  const cols = before.length + 1 + after.length
  const th = (t: string) => `<th>${escapeHtml(t)}</th>`
  table.innerHTML = `<thead><tr>${before.map((f) => th(f.name)).join('')}${th(ctx.dialogueName || 'Dialogue')}${after.map((f) => th(f.name)).join('')}</tr></thead>`
  const tbody = dom.createElement('tbody')
  const chip = (f: FieldDef, id?: string) => {
    const o = f.options?.find((x) => x.id === id)
    return o ? `<span class="chip" style="background:${tint(o.color, 0.25)};border:1px solid ${o.color}">${escapeHtml(o.label)}</span>` : ''
  }
  const cell = (f: FieldDef, v: any) => {
    if (f.type === 'visual') {
      const vv = (v || {}) as VisualValue
      const img = vv.images?.[0]
      const o = f.options?.find((x) => x.id === vv.type)
      return `<td class="visual"${o ? ` style="background:${tint(o.color, 0.16)};border-left:4px solid ${o.color}"` : ''}>${chip(f, vv.type)}${vv.desc ? `<div>${escapeHtml(vv.desc)}</div>` : ''}${img ? `<img src="${escapeHtml(img.thumb || img.url)}" alt="${escapeHtml(img.name)}">` : ''}</td>`
    }
    if (f.type === 'select') return `<td class="status">${chip(f, v)}</td>`
    return `<td class="scene">${escapeHtml(String(v ?? ''))}</td>`
  }
  for (const sec of [...root.children]) {
    if (sec.tagName !== 'SECTION') {
      const tr = dom.createElement('tr')
      tr.innerHTML = `<td colspan="${cols}"></td>`
      tr.firstElementChild!.append(sec)
      tbody.append(tr)
      continue
    }
    const title = sec.querySelector(':scope > h2')
    const head = dom.createElement('tr')
    head.className = 'section-row'
    head.style.background = ctx.sectionColor
    head.innerHTML = `<td colspan="${cols}"><strong>${title?.innerHTML || ''}</strong></td>`
    tbody.append(head)
    for (const beat of sec.querySelectorAll(':scope > div[data-beat-id]')) {
      const data = ctx.beatData(beat.getAttribute('data-beat-id') || '')
      const tr = dom.createElement('tr')
      tr.innerHTML = before.map((f) => cell(f, data[f.id])).join('') + '<td class="dialogue"></td>' + after.map((f) => cell(f, data[f.id])).join('')
      tr.querySelector('.dialogue')!.append(...beat.childNodes)
      tbody.append(tr)
    }
  }
  table.append(tbody)
  root.replaceChildren(table)
}

function attachmentHtml(a: Attachment) {
  const label = escapeHtml(a.title || a.name)
  if (a.type === 'link' || a.type === 'video/embed') {
    const meta = [a.site || a.provider, a.author, a.date].filter(Boolean).map((x) => escapeHtml(String(x))).join(' · ')
    return `<div>🔗 <a href="${escapeHtml(a.href || '')}">${label}</a>${meta ? ` <span class="fn-meta">(${meta})</span>` : ''}</div>`
  }
  if (a.type.startsWith('image/') && a.url) return `<figure><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name)}"><figcaption>${escapeHtml(a.name)}</figcaption></figure>`
  if (a.url) return `<div>📎 <a href="${escapeHtml(new URL(a.url, location.origin).href)}">${label}</a></div>`
  return ''
}

/** An annotation in an export: its note and attachments labelled with its author, then
 * any links, images and files added in replies, labelled with whoever added them. */
function noteHtml(n: Note) {
  const parts: string[] = []
  if (n.authorName) parts.push(`<div class="fn-by">${escapeHtml(n.authorName)}</div>`)
  if (n.citation && Object.values(n.citation).some(Boolean)) parts.push(`<div class="fn-cite">${escapeHtml(formatCitation(n.citation))}</div>`)
  if (n.text) parts.push(`<div class="fn-text">${escapeHtml(n.text).replace(/\n/g, '<br>')}</div>`)
  if (n.url) parts.push(`<div><a href="${escapeHtml(n.url)}">${escapeHtml(n.url)}</a></div>`)
  for (const a of n.attachments || []) parts.push(attachmentHtml(a))
  for (const r of n.replies || []) {
    if (r.deleted || !r.attachments?.length) continue
    parts.push(`<div class="fn-reply"><div class="fn-by">Added by ${escapeHtml(r.authorName)} in a reply</div>${r.attachments.map(attachmentHtml).join('')}</div>`)
  }
  return parts.join('')
}

const STYLE = `
  table.script { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
  table.script th { background: #111; color: #fff; text-align: left; padding: 6pt 8pt; font-size: 10pt; }
  table.script td { border: 1px solid #bbb; padding: 6pt 8pt; vertical-align: top; }
  table.script td.dialogue p { margin: 0; }
  p { margin: 0; }
  table.script td.visual { width: 26%; font-size: 10pt; }
  table.script td.visual img { display: block; max-width: 100%; max-height: 1.6in; margin-top: 4pt; }
  table.script td.scene { width: 8%; font-family: ui-monospace, Menlo, monospace; font-size: 9pt; }
  table.script td.status { width: 10%; }
  table.script tr.section-row td { font-weight: 700; }
  table.script tr { page-break-inside: avoid; }
  table.script .chip { display: inline-block; border-radius: 99px; padding: 0 7pt; font: 8.5pt Helvetica, Arial, sans-serif; }
  thead { display: table-header-group; }
  body { font: 11pt/1 'Inconsolata Variable', Inconsolata, Menlo, Consolas, 'Courier New', monospace; color: #111; max-width: 7in; margin: 0.6in auto; padding: 0 16px; }
  h1.doc-title { font-size: 22pt; margin: 0 0 18pt; }
  h1 { font-size: 20pt } h2 { font-size: 16pt } h3 { font-size: 13pt }
  img { max-width: 100%; height: auto; }
  blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 12px; color: #444; }
  pre { background: #f4f4f4; padding: 8px; white-space: pre-wrap; }
  sup a { text-decoration: none; color: #555; font-size: 8pt; }
  .notes { margin-top: 32pt; border-top: 1px solid #ccc; padding-top: 12pt; page-break-before: auto; font-size: 10.5pt; }
  .endnotes { padding-left: 0; list-style: none; }
  .endnotes li { margin: 0 0 10pt; }
  .fn-back { text-decoration: none; font-weight: bold; color: #333; }
  .fn-quote { color: #555; font-style: italic; }
  .fn-text, .fn-cite { margin-top: 2pt; }
  .fn-by { font-size: 9pt; color: #666; margin-top: 2pt; }
  .fn-reply { margin-left: 14px; color: #444; }
  figure { margin: 6pt 0; } figure img { max-height: 3in; } figcaption { font-size: 9pt; color: #666; }
  ul[data-type="taskList"] { list-style: none; padding-left: 0; }
  @media print { body { margin: 0; max-width: none; } a { color: inherit; } }
`

/** Print / Word output uses the document's own page size, orientation and margins. */
function htmlDocument(title: string, inner: string, page: PageGeometry, landscape: boolean, word = false, font = "'Inconsolata Variable', Inconsolata, monospace", size = 11) {
  const ns = word ? ' xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"' : ''
  const pageCss = word
    ? `@page WordSection1 { size: ${page.cssSize}; margin: ${page.cssMargin};${landscape ? ' mso-page-orientation: landscape;' : ''} } div.WordSection1 { page: WordSection1; } body { max-width: none; margin: 0; }`
    : `@page { size: ${page.cssSize}; margin: ${page.cssMargin}; }`
  const body = `<h1 class="doc-title">${escapeHtml(title)}</h1>${inner}`
  return `<!doctype html><html${ns}><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}${pageCss} body, table.script, table.script .chip, table.script th { font-family: ${font}; } body { font-size: ${size}pt; } table.script { font-size: ${Math.max(6, size - 0.5)}pt; } [data-font] { font-family: inherit !important; } span[style*="font-size"] { font-size: inherit !important; }</style></head><body>${word ? `<div class="WordSection1">${body}</div>` : body}</body></html>`
}

/** Replace same-origin image URLs with data: URIs so the file works offline. */
async function embedImages(dom: Document, html: string) {
  const holder = dom.createElement('div')
  holder.innerHTML = html
  const imgs = [...holder.querySelectorAll('img')]
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') || ''
      if (!src.startsWith('/api/')) return
      try {
        const blob = await (await fetch(src, { credentials: 'same-origin' })).blob()
        if (blob.size > 15 * 1024 * 1024) return
        img.src = await new Promise<string>((res) => {
          const r = new FileReader()
          r.onload = () => res(r.result as string)
          r.readAsDataURL(blob)
        })
      } catch {
        /* leave the link */
      }
    }),
  )
  return holder.innerHTML
}

export async function runExport(ctx: Ctx, format: Format, opts: ExportOptions) {
  const name = safeFilename(ctx.title)
  if (format === 'sidescript') {
    const payload = { format: 'sidescript', version: 1, title: ctx.title, exportedAt: new Date().toISOString(), state: bytesToBase64(Y.encodeStateAsUpdate(ctx.ydoc)) }
    return downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `${name}.sidescript.json`)
  }
  const { body, notesHtml, dom } = buildBody(ctx, opts)

  if (format === 'txt') {
    const div = dom.createElement('div')
    div.innerHTML = body
    let text = blocksToText(div)
    if (notesHtml) {
      const n = dom.createElement('div')
      n.innerHTML = notesHtml
      text += '\n\n' + blocksToText(n)
    }
    return downloadBlob(new Blob([`${ctx.title}\n\n${text.trim()}\n`], { type: 'text/plain;charset=utf-8' }), `${name}.txt`)
  }
  if (format === 'md') {
    const div = dom.createElement('div')
    div.innerHTML = body
    let md = `# ${ctx.title}\n\n` + htmlToMarkdown(div)
    if (notesHtml) {
      const n = dom.createElement('div')
      n.innerHTML = notesHtml
      const items = [...n.querySelectorAll('li')].sort((x, y) => Number(x.getAttribute('value')) - Number(y.getAttribute('value')))
      const flat = (li: Element) =>
        [...li.children]
          .filter((c) => !c.classList.contains('fn-back'))
          .map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' — ')
      md += '\n' + items.map((li) => `[^${li.getAttribute('value')}]: ${flat(li)}`).join('\n') + '\n'
    }
    return downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${name}.md`)
  }

  const inner = await embedImages(dom, body + notesHtml)
  if (format === 'html') return downloadBlob(new Blob([htmlDocument(ctx.title, inner, ctx.page, ctx.landscape, false, ctx.font, ctx.fontSize)], { type: 'text/html;charset=utf-8' }), `${name}.html`)
  if (format === 'docx') return downloadBlob(new Blob(['﻿', htmlDocument(ctx.title, inner, ctx.page, ctx.landscape, true, ctx.font, ctx.fontSize)], { type: 'application/msword' }), `${name}.doc`)
  if (format === 'pdf') return printHtml(htmlDocument(ctx.title, inner, ctx.page, ctx.landscape, false, ctx.font, ctx.fontSize))
}

function blocksToText(el: Element) {
  el.querySelectorAll('br').forEach((b) => b.replaceWith('\n'))
  el.querySelectorAll('li').forEach((li) => li.prepend(li.parentElement?.tagName === 'OL' ? '' : '• '))
  el.querySelectorAll('p, h1, h2, h3, li, blockquote, pre, div, figure').forEach((b) => b.append('\n\n'))
  return (el.textContent || '').replace(/\n{3,}/g, '\n\n')
}

/** The app's own @font-face rules (fonts are served from this server), for the print frame. */
function fontFaces() {
  const out: string[] = []
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) if (rule instanceof CSSFontFaceRule) out.push(rule.cssText)
    } catch {
      /* not our stylesheet */
    }
  }
  return `<style>${out.join('\n')}</style>`
}

function printHtml(html: string) {
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  frame.srcdoc = html.replace('</head>', `${fontFaces()}</head>`)
  frame.onload = () => {
    const w = frame.contentWindow!
    const imgs = [...w.document.images].filter((i) => !i.complete)
    Promise.all([...imgs.map((i) => new Promise((r) => (i.onload = i.onerror = r))), w.document.fonts.ready]).then(() => {
      w.focus()
      w.print()
      setTimeout(() => frame.remove(), 1000)
    })
  }
  document.body.appendChild(frame)
}
