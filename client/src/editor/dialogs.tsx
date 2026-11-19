import { useEffect, useState } from 'react'
import { confirmAt } from '../components/confirmAt'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import { Save, UserPlus } from 'lucide-react'
import { api, type DocMeta, type User, type Version } from '../api'
import { Avatar, Modal } from '../components/ui'
import { fmtDate, toast } from '../util'
import { baseExtensions } from './extensions'
import type { getMaps } from './model'
import { FORMATS, runExport, type Format } from './export'
import type { ViewState } from './LayerBar'

type Maps = ReturnType<typeof getMaps>

// ================================================================ sharing

export function ShareDialog({ meta, setMeta, onClose }: { meta: DocMeta; setMeta: (m: DocMeta) => void; onClose: () => void }) {
  const [users, setUsers] = useState<User[]>([])
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  useEffect(() => {
    api<{ users: User[] }>('GET', '/api/users').then((r) => setUsers(r.users))
  }, [])
  const byName = new Map(users.map((u) => [u.username, u]))

  async function share(u: string, r: 'editor' | 'viewer' | null) {
    try {
      const res = await api<{ doc: DocMeta }>('PUT', `/api/docs/${meta.id}/shares`, { username: u, role: r })
      setMeta(res.doc)
      setUsername('')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const candidates = users.filter((u) => u.username !== meta.owner && !meta.shares?.[u.username])
  return (
    <Modal title={`Share “${meta.title}”`} onClose={onClose}>
      <p className="muted small">Only people with an account on this server can be invited. There are no public links.</p>
      <div className="form-row">
        <input list="share-users" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} aria-label="Username" />
        <datalist id="share-users">
          {candidates.map((u) => (
            <option key={u.username} value={u.username}>
              {u.displayName}
            </option>
          ))}
        </datalist>
        <select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')} aria-label="Access">
          <option value="editor">Can edit</option>
          <option value="viewer">Can view</option>
        </select>
        <button className="btn primary" disabled={!username} onClick={() => share(username, role)}>
          <UserPlus size={14} /> Invite
        </button>
      </div>
      <ul className="user-list">
        <li>
          <Avatar name={byName.get(meta.owner)?.displayName || meta.owner} color={byName.get(meta.owner)?.color || '#888'} />
          <span>
            <strong>{byName.get(meta.owner)?.displayName || meta.owner}</strong> <span className="muted">@{meta.owner}</span>
          </span>
          <span className="muted small">Owner</span>
        </li>
        {Object.entries(meta.shares || {}).map(([u, r]) => (
          <li key={u}>
            <Avatar name={byName.get(u)?.displayName || u} color={byName.get(u)?.color || '#888'} />
            <span>
              <strong>{byName.get(u)?.displayName || u}</strong> <span className="muted">@{u}</span>
            </span>
            <select value={r} onChange={(e) => share(u, e.target.value === 'remove' ? null : (e.target.value as 'editor' | 'viewer'))} aria-label={`Access for ${u}`}>
              <option value="editor">Can edit</option>
              <option value="viewer">Can view</option>
              <option value="remove">Remove access</option>
            </select>
          </li>
        ))}
      </ul>
      <p className="muted small">
        Link for invited people: <code>{location.origin}/d/{meta.id}</code>
      </p>
    </Modal>
  )
}

// ================================================================ version history

export function HistoryDialog({ docId, editor, maps, canEdit, onClose }: { docId: string; editor: Editor; maps: Maps; canEdit: boolean; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [selected, setSelected] = useState<Version | null>(null)
  const [preview, setPreview] = useState<{ json: any; doc: Y.Doc } | null>(null)
  const [label, setLabel] = useState('')

  const load = () => api<{ versions: Version[] }>('GET', `/api/docs/${docId}/history`).then((r) => setVersions(r.versions))
  useEffect(() => {
    load()
  }, [])

  async function open(v: Version) {
    setSelected(v)
    const buf = new Uint8Array(await (await fetch(`/api/docs/${docId}/history/${v.name}`, { credentials: 'same-origin' })).arrayBuffer())
    const doc = new Y.Doc()
    Y.applyUpdate(doc, buf)
    setPreview({ json: yDocToProsemirrorJSON(doc, 'default'), doc })
  }

  async function saveVersion() {
    await api('POST', `/api/docs/${docId}/history`, { label })
    setLabel('')
    toast('Version saved')
    load()
  }

  async function restore(e: React.MouseEvent<HTMLElement>) {
    if (!preview || !selected) return
    const ok = await confirmAt(e.currentTarget, { title: `Restore the version from ${fmtDate(selected.at)}?`, message: 'Everyone will see the restored script. The current text is saved as a version first, so nothing is lost.', confirm: 'Restore' })
    if (!ok) return
    await api('POST', `/api/docs/${docId}/history`, { label: 'before restore' })
    editor.commands.setContent(preview.json)
    // Bring back notes, comments and layers that existed in that version.
    const old = { categories: preview.doc.getMap('categories'), notes: preview.doc.getMap('notes'), comments: preview.doc.getMap('comments') }
    const doc = maps.notes.doc!
    doc.transact(() => {
      for (const key of ['categories', 'notes', 'comments'] as const)
        for (const [id, v] of old[key].entries()) if (!(maps[key] as Y.Map<unknown>).has(id)) (maps[key] as Y.Map<unknown>).set(id, v)
      // Columns: restore that version's column setup (names, chips, widths, section colour)…
      const oldFields = preview.doc.getMap<any>('fields')
      for (const key of ['list', 'widths', 'sectionColor', 'dialogueName'])
        if (oldFields.has(key)) maps.fields.set(key, oldFields.get(key))
        else maps.fields.delete(key)
      // …and each beat's values for those columns, where the beat doesn't have one now.
      const oldBeats = preview.doc.getMap<Y.Map<any>>('beats')
      const beats = doc.getMap<Y.Map<any>>('beats')
      oldBeats.forEach((data, beatId) => {
        let cur = beats.get(beatId)
        if (!cur) {
          cur = new Y.Map()
          beats.set(beatId, cur)
        }
        const target = cur
        data.forEach((v, k) => !target.has(k) && target.set(k, v))
      })
    })
    toast('Version restored')
    onClose()
  }

  return (
    <Modal
      title="Version history"
      onClose={onClose}
      wide
      footer={
        canEdit && (
          <>
            <input placeholder="Name this version (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="btn" onClick={saveVersion}>
              <Save size={14} /> Save version now
            </button>
            <button className="btn primary" disabled={!preview} onClick={restore}>
              Restore selected
            </button>
          </>
        )
      }
    >
      <div className="history">
        <ul className="history-list">
          {!versions && <li className="muted">Loading…</li>}
          {versions?.length === 0 && <li className="muted small">No versions yet. A version is saved automatically every 10 minutes of editing and whenever everyone closes the document.</li>}
          {versions?.map((v) => (
            <li key={v.name}>
              <button className={selected?.name === v.name ? 'active' : ''} onClick={() => open(v)}>
                <strong>{fmtDate(v.at)}</strong>
                {v.label && <span className="pill">{v.label}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="history-preview">{preview ? <Preview json={preview.json} /> : <p className="muted">Pick a version to preview it.</p>}</div>
      </div>
    </Modal>
  )
}

function Preview({ json }: { json: any }) {
  const ed = useEditor({ extensions: baseExtensions(), content: json, editable: false, editorProps: { attributes: { class: 'doc-body preview' } } }, [json])
  return <EditorContent editor={ed} />
}

// ================================================================ download / print

export function ExportDialog({ ctx, view, preset, onClose }: { ctx: Parameters<typeof runExport>[0]; view: ViewState; preset?: Format; onClose: () => void }) {
  const [format, setFormat] = useState<Format>(preset || 'pdf')
  const visibleNow = ctx.categories.filter((c) => view.mode !== 'script' && !view.hidden.includes(c.id)).map((c) => c.id)
  const [layers, setLayers] = useState<Set<string>>(new Set(visibleNow))
  const [highlights, setHighlights] = useState(true)
  const [notes, setNotes] = useState(true)
  const [comments, setComments] = useState(false)
  const [table, setTable] = useState(true)
  const [busy, setBusy] = useState(false)
  const lossless = format === 'sidescript'

  async function go() {
    setBusy(true)
    try {
      await runExport(ctx, format, { layers, highlights, notes, comments, table: table && !['md', 'txt'].includes(format) })
      onClose()
    } catch (e: any) {
      toast(e.message || 'Export failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={format === 'pdf' ? 'Print or save as PDF' : 'Download'}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={go} disabled={busy}>
          {busy ? 'Preparing…' : format === 'pdf' ? 'Print…' : 'Download'}
        </button>
      }
    >
      <label className="block">
        Format
        <select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
          {FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {lossless ? (
        <p className="muted small">A complete copy of the document — text, every layer, notes, comments and the key. Import it from the documents page to restore it on any Sidescript server.</p>
      ) : (
        <>
          <div className="export-presets">
            <button className="link-btn" onClick={() => setLayers(new Set())}>
              Script only
            </button>
            <button className="link-btn" onClick={() => setLayers(new Set(visibleNow))}>
              Current view
            </button>
            <button className="link-btn" onClick={() => setLayers(new Set(ctx.categories.map((c) => c.id)))}>
              All layers
            </button>
          </div>
          <fieldset className="layer-checks">
            <legend>Layers to include</legend>
            {ctx.categories.map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={layers.has(c.id)}
                  onChange={(e) => {
                    const next = new Set(layers)
                    if (e.target.checked) next.add(c.id)
                    else next.delete(c.id)
                    setLayers(next)
                  }}
                />
                <span className="swatch" style={{ background: c.color }} /> {c.name}
              </label>
            ))}
            <label className="check">
              <input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} /> Comments
            </label>
          </fieldset>
          <label className="check">
            <input type="checkbox" checked={highlights} onChange={(e) => setHighlights(e.target.checked)} /> Keep annotation colours on the text
          </label>
          <label className="check">
            <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} /> Add notes as numbered endnotes
          </label>
          {!['md', 'txt'].includes(format) && (
            <fieldset className="layer-checks">
              <legend>Layout</legend>
              <label className="check">
                <input type="radio" name="exp-layout" checked={table} onChange={() => setTable(true)} /> Table — Visual · Dialogue · Scene · Status
              </label>
              <label className="check">
                <input type="radio" name="exp-layout" checked={!table} onChange={() => setTable(false)} /> Script — section titles and dialogue only
              </label>
            </fieldset>
          )}
        </>
      )}
    </Modal>
  )
}
