import type { Editor } from '@tiptap/core'
import { useState } from 'react'
import { GripVertical, Plus, X } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/ui'
import { ColorPicker } from '../components/ColorPicker'
import { toast } from '../util'
import { removeAnchor } from '../editor/marks'
import { withUndo } from '../editor/undoable'
import { DEFAULT_CATEGORIES, nextColor, type Category, type getMaps } from '../editor/model'
import { confirmAt } from '../components/confirmAt'
import type { ScriptContext } from './context'
import { chipText, DEFAULT_FIELDS, DEFAULT_SECTION_COLOR, isVeryDark, type FieldDef, type FieldOption } from './fields'

/** A copy of `list` with the item at `from` moved to `to`. */
function moveItem<T>(list: T[], from: number, to: number) {
  const next = [...list]
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

const rid = () => Math.random().toString(36).slice(2, 8)

/**
 * Labels: names and colours of everything that labels the script —
 * annotation layers, Visual/Status chips and section bars. (Columns are edited in the table header.)
 * Every change applies live for collaborators and can be undone.
 */
export function LabelsDialog({ script, maps, editor, categories, fields, sectionColor, canEdit, onClose }: {
  script: ScriptContext
  maps: ReturnType<typeof getMaps>
  editor: Editor | null
  categories: Category[]
  fields: FieldDef[]
  sectionColor: string
  canEdit: boolean
  onClose: () => void
}) {
  // ---- highlight layers
  const setCategory = (c: Category, patch: Partial<Category>) => script.transact(() => maps.categories.set(c.id, { ...c, ...patch }))
  const addCategory = () => {
    const id = rid()
    const order = categories.reduce((m, c) => Math.max(m, c.order + 1), 0)
    script.transact(() => maps.categories.set(id, { id, name: 'New annotation', color: nextColor('annotation', categories.map((c) => c.color)), kind: 'note', order }))
  }
  // Renumber every layer, so the toolbar, bubble and Alt+1…9 all follow the new order.
  const moveCategory = (from: number, to: number) =>
    script.transact(() => moveItem(categories, from, to).forEach((c, i) => c.order !== i && maps.categories.set(c.id, { ...c, order: i })))
  const removeCategory = (c: Category) => {
    const ids = [...maps.notes.values()].filter((n) => n.category === c.id).map((n) => n.id)
    withUndo(editor, ids.length ? `Removed “${c.name}” and its ${ids.length} annotation${ids.length === 1 ? '' : 's'}` : `Removed “${c.name}”`, () => {
      if (editor) for (const id of ids) removeAnchor(editor, 'annotation', id)
      script.transact(() => {
        for (const id of ids) maps.notes.delete(id)
        maps.categories.delete(c.id)
      })
    })
  }

  // ---- columns & chips
  const setField = (id: string, patch: Partial<FieldDef>) => script.transact(() => script.fields.set('list', fields.map((f) => (f.id === id ? { ...f, ...patch } : f))))
  const setOption = (f: FieldDef, id: string, patch: Partial<FieldOption>) => setField(f.id, { options: (f.options || []).map((o) => (o.id === id ? { ...o, ...patch } : o)) })
  const addOption = (f: FieldDef) => setField(f.id, { options: [...(f.options || []), { id: rid(), label: 'New', color: nextColor(f.type, (f.options || []).map((o) => o.color)) }] })
  const moveOption = (f: FieldDef, from: number, to: number) => setField(f.id, { options: moveItem(f.options || [], from, to) })
  const removeOption = (f: FieldDef, o: FieldOption) => {
    withUndo(editor, `Removed “${o.label}”`, () => setField(f.id, { options: (f.options || []).filter((x) => x.id !== o.id) }))
  }

  /**
   * Reset to defaults: annotation layers, Visual and Status options and the section bar go back
   * to Sidescript's defaults. Nothing in the script loses its label: an option or layer with
   * the same name (or id) as a default keeps its link and takes the default name and colour;
   * other options and layers still in use are kept, recoloured from the palette; unused ones
   * are removed. Columns and their contents are untouched. Undoable.
   */
  async function resetToDefaults(e: React.MouseEvent<HTMLElement>) {
    const ok = await confirmAt(e.currentTarget, {
      title: 'Reset labels to the defaults?',
      message: 'Annotation layers, Visual and Status options and the section bar colour go back to Sidescript’s defaults. Labels your beats or annotations still use are kept and recoloured. You can undo this.',
      confirm: 'Reset',
    })
    if (!ok) return
    const key = (s: string) => s.trim().toLowerCase()
    const used = new Map<string, Set<string>>() // field id -> option ids in use
    script.beats.forEach((data) =>
      data.forEach((v, fid) => {
        const id = typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { type?: string }).type : undefined
        if (id) (used.get(fid) ?? used.set(fid, new Set()).get(fid)!).add(id)
      }),
    )
    const resetOptions = (f: FieldDef, defaults: FieldOption[]) => {
      const current = f.options || []
      const next: FieldOption[] = defaults.map((d) => {
        const same = current.find((o) => o.id === d.id || key(o.label) === key(d.label))
        return { ...d, id: same ? same.id : d.id }
      })
      const kept = current.filter((o) => !next.some((n) => n.id === o.id) && used.get(f.id)?.has(o.id))
      for (const o of kept) next.push({ ...o, color: nextColor(f.type, next.map((n) => n.color)) })
      return { ...f, options: next }
    }
    const defVisual = DEFAULT_FIELDS.find((f) => f.type === 'visual')!.options!
    const defStatus = DEFAULT_FIELDS.find((f) => f.id === 'status')!.options!
    const nextFields = fields.map((f) => (f.type === 'visual' ? resetOptions(f, defVisual) : f.id === 'status' || key(f.name) === 'status' ? resetOptions(f, defStatus) : f))
    const inUse = new Set([...maps.notes.values()].map((n) => n.category))

    withUndo(editor, 'Labels reset to the defaults', () =>
      script.transact(() => {
        script.fields.set('list', nextFields)
        script.fields.delete('sectionColor')
        const taken: string[] = []
        const matched = new Set<string>()
        DEFAULT_CATEGORIES.forEach((d, i) => {
          const same = categories.find((c) => !matched.has(c.id) && (c.id === d.id || key(c.name) === key(d.name)))
          const id = same ? same.id : d.id
          matched.add(id)
          taken.push(d.color)
          maps.categories.set(id, { ...d, id, kind: same?.kind ?? d.kind, order: i })
        })
        let order = DEFAULT_CATEGORIES.length
        for (const c of categories) {
          if (matched.has(c.id)) continue
          if (!inUse.has(c.id)) maps.categories.delete(c.id)
          else {
            const color = nextColor('annotation', taken)
            taken.push(color)
            maps.categories.set(c.id, { ...c, color, order: order++ })
          }
        }
      }),
    )
  }

  async function saveDefault() {
    await api('PUT', '/api/me/prefs', { categories, fields, sectionColor })
    toast('Saved. New scripts you create will start with these labels.')
  }

  // ---- reordering: drag the grip, or focus it and press ↑/↓ (Alt+↑/↓ also works)
  const [drag, setDrag] = useState<{ list: string; from: number; over: number } | null>(null)
  const reorder = (list: string, index: number, count: number, move: (from: number, to: number) => void) =>
    canEdit && count > 1
      ? {
          handle: (
            <button
              className="icon-btn lb-grip"
              draggable
              title="Drag to reorder (or press ↑/↓)"
              aria-label="Reorder"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', '')
                const li = (e.currentTarget as HTMLElement).closest('li')
                if (li) e.dataTransfer.setDragImage(li, 12, 12)
                setDrag({ list, from: index, over: index })
              }}
              onDragEnd={() => setDrag(null)}
              onKeyDown={(e) => {
                const to = e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : -1
                if (to < 0 || to >= count) return
                e.preventDefault()
                move(index, to)
                // Keep focus on the moved row's grip.
                const ul = (e.currentTarget as HTMLElement).closest('ul')
                requestAnimationFrame(() => (ul?.querySelectorAll<HTMLElement>('.lb-grip')[to])?.focus())
              }}
            >
              <GripVertical size={14} />
            </button>
          ),
          li: {
            className: drag?.list === list && drag.over === index && drag.from !== index ? (drag.from < index ? 'drop-below' : 'drop-above') : undefined,
            onDragOver: (e: React.DragEvent) => {
              if (drag?.list !== list) return
              e.preventDefault()
              if (drag.over !== index) setDrag({ ...drag, over: index })
            },
            onDrop: (e: React.DragEvent) => {
              if (drag?.list !== list) return
              e.preventDefault()
              if (drag.from !== index) move(drag.from, index)
              setDrag(null)
            },
          },
        }
      : { handle: null, li: {} }

  const row = (key: string, color: string, name: string, onColor: (c: string) => void, onName: (n: string) => void, onRemove: () => void, chip = false, order = reorder('', 0, 0, () => {})) => (
    <li key={key} {...order.li}>
      {order.handle}
      <ColorPicker value={color} disabled={!canEdit} onChange={onColor} label={`${name} colour`} />
      {chip ? (
        <span className={`lb-chip ${isVeryDark(color) ? 'chip-dark' : ''}`} style={{ background: color, color: chipText(color) }}>
          <input value={name} readOnly={!canEdit} onChange={(e) => onName(e.target.value.slice(0, 40))} aria-label="Name" style={{ width: `${Math.max(4, name.length + 1)}ch` }} />
        </span>
      ) : (
        <input className="lb-name" value={name} readOnly={!canEdit} onChange={(e) => onName(e.target.value.slice(0, 60))} aria-label="Name" />
      )}
      {canEdit && (
        <button className="icon-btn lb-remove" onClick={onRemove} aria-label={`Remove ${name}`} title="Remove">
          <X size={14} />
        </button>
      )}
    </li>
  )

  const chipFields = fields.filter((f) => f.type !== 'text')

  return (
    <Modal
      title="Label Options"
      onClose={onClose}
      wide
      footer={
        <>
          {canEdit && (
            <button className="link-btn lb-reset" onClick={resetToDefaults} title="Go back to Sidescript’s default labels and colours">
              Reset to defaults
            </button>
          )}
          {canEdit && (
            <button className="link-btn" onClick={saveDefault} title="New scripts you create will start with these labels">
              Use these for new scripts
            </button>
          )}
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="muted small lb-hint">To rename, add or delete columns, use the header row in Table view.</p>
      <div className="lb-grid">
        <section>
          <h3>Annotations</h3>
          <ul className="lb-list">
            {categories.map((c, i) =>
              row(c.id, c.color, c.name, (color) => setCategory(c, { color }), (name) => setCategory(c, { name }), () => removeCategory(c), false, reorder('categories', i, categories.length, moveCategory)),
            )}
          </ul>
          {canEdit && (
            <button className="link-btn" onClick={addCategory}>
              <Plus size={13} /> Add annotation
            </button>
          )}
        </section>

        {chipFields.map((f) => (
          <section key={f.id}>
            <h3>{f.name}</h3>
            <ul className="lb-list">
              {(f.options || []).map((o, i, all) =>
                row(o.id, o.color, o.label, (color) => setOption(f, o.id, { color }), (label) => setOption(f, o.id, { label }), () => removeOption(f, o), true, reorder(f.id, i, all.length, (from, to) => moveOption(f, from, to))),
              )}
            </ul>
            {canEdit && (
              <button className="link-btn" onClick={() => addOption(f)}>
                <Plus size={13} /> Add {f.name.toLowerCase()}
              </button>
            )}
          </section>
        ))}

        <section>
          <h3>Section bars</h3>
          <div className="lb-section">
            <ColorPicker value={sectionColor} disabled={!canEdit} label="Section bar colour" onChange={(c) => script.transact(() => script.fields.set('sectionColor', c))} />
            <span className="lb-preview" style={{ background: sectionColor, color: chipText(sectionColor) }}>
              Act I
            </span>
            {canEdit && sectionColor !== DEFAULT_SECTION_COLOR && (
              <button className="link-btn" onClick={() => script.transact(() => script.fields.delete('sectionColor'))}>
                Reset
              </button>
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}
