import type { Editor } from '@tiptap/core'
import { DOMParser as PMDOMParser, type Node as PMNode } from '@tiptap/pm/model'
import * as Y from 'yjs'
import { api, uploadFile } from '../api'
import { toast } from '../util'
import { confirmAt } from '../components/confirmAt'
import type { ScriptContext } from './context'
import { newId } from './nodes'
import { planImport, TableImportError, type Cell } from './tableImport'

function dataUrlToBlob(url: string) {
  const [head, b64] = url.split(',')
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'image/png'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** Paste a table as sections and beats (see tableImport.ts for how it's read). */
export async function pasteTable(editor: Editor, script: ScriptContext, rows: Cell[][]) {
  let plan
  try {
    plan = planImport(rows, script.fieldList(), newId)
  } catch (e) {
    if (e instanceof TableImportError) return void toast(e.message, 'error')
    throw e
  }
  if (!plan.beatCount) return void toast('That table has no rows to paste', 'error')
  const left = plan.fields.filter((f) => f.type === 'visual').map((f) => f.name)
  const right = plan.fields.filter((f) => f.type !== 'visual').map((f) => f.name)
  const titled = plan.sections.filter((s) => s.title).length
  const ok = await confirmAt(null, {
    title: `Paste this table as ${plan.beatCount} beat${plan.beatCount === 1 ? '' : 's'}${titled ? ` in ${titled} section${titled === 1 ? '' : 's'}` : ''}?`,
    message:
      `Columns will become: ${[...left, plan.dialogueName, ...right].join(' · ')}\n` +
      `(“${plan.dialogueName}” has the most text, so it becomes the beat text.)\n\n` +
      'A version is saved first, so you can go back from Version history.',
    confirm: 'Paste table',
  })
  if (!ok) return
  try {
    await api('POST', `/api/docs/${script.docId}/history`, { label: 'before table paste' })
  } catch (e: any) {
    return void toast(`Couldn't save a version first, so nothing was pasted (${e.message})`, 'error')
  }

  // ---- text: sections and beats
  const { schema } = editor.state
  const S = schema.nodes
  const parser = PMDOMParser.fromSchema(schema)
  const beatNode = (id: string, html: string): PMNode => {
    const div = document.createElement('div')
    div.innerHTML = html
    div.querySelectorAll('img, script, style, iframe, object, meta, link').forEach((n) => n.remove())
    const node = parser.parse(div, { topNode: S.beat.create({ id }) })
    return node.childCount && node.textContent.trim() ? node : S.beat.create({ id }, S.paragraph.create(null, node.textContent ? schema.text(node.textContent) : undefined))
  }
  const sections = plan.sections.map((s) =>
    S.section.create({ id: newId() }, [S.sectionTitle.create(null, s.title ? schema.text(s.title) : undefined), ...(s.beats.length ? s.beats.map((b) => beatNode(b.id, b.html)) : [S.beat.create({ id: newId() }, S.paragraph.create())])]),
  )
  const { doc, selection } = editor.state
  const tr = editor.state.tr
  if (!doc.textContent.trim()) tr.replaceWith(0, doc.content.size, sections)
  else tr.insert(selection.$from.depth >= 1 ? selection.$from.after(1) : doc.content.size, sections) // after the current section
  editor.view.dispatch(tr.scrollIntoView())

  // ---- columns and each beat's data
  script.transact(() => {
    script.fields.set('list', plan.fields)
    script.fields.set('dialogueName', plan.dialogueName)
    for (const s of plan.sections) for (const b of s.beats) if (Object.keys(b.values).length) script.beats.set(b.id, new Y.Map(Object.entries(b.values)))
  })
  toast(`Pasted ${plan.beatCount} beat${plan.beatCount === 1 ? '' : 's'}`)

  // ---- visual images: copied to this server in the background
  const visual = plan.fields.find((f) => f.type === 'visual')
  const withImages = visual ? plan.sections.flatMap((s) => s.beats).filter((b) => b.image && !b.image.startsWith('blob:')) : []
  if (!visual || !withImages.length) return
  let done = 0
  let failed = 0
  for (const b of withImages) {
    try {
      let url: string
      if (b.image!.startsWith('data:')) url = (await uploadFile(script.docId, dataUrlToBlob(b.image!))).url
      else {
        const { attachment } = await api<{ attachment: { type: string; url?: string } }>('POST', `/api/docs/${script.docId}/embed`, { url: b.image })
        if (!attachment.type.startsWith('image/') || !attachment.url) throw new Error('not an image')
        url = attachment.url
      }
      const cur = (script.getValue(b.id, visual.id) as Record<string, unknown>) || {}
      script.setValue(b.id, visual.id, { ...cur, images: [{ id: Math.random().toString(36).slice(2, 10), url, thumb: url, name: 'pasted image' }] })
      done++
    } catch {
      failed++
    }
  }
  toast(`Copied ${done} image${done === 1 ? '' : 's'} to your server${failed ? ` (${failed} couldn't be fetched)` : ''}`, failed && !done ? 'error' : undefined)
}
