import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { keyLabel } from './shortcuts'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { ChevronDown, GripVertical, Plus, X } from 'lucide-react'
import type { ScriptContext } from '../script/context'
import type { FieldDef, VisualValue } from '../script/fields'
import { beatAt } from '../script/nodes'
import { addBeat, addSection, moveBeat, moveSection, nudge, readOutline, reveal, type OutlineSection } from '../script/outline'

type Drag = { kind: 'section' | 'beat'; id: string } | null
type Drop = { id: string; where: 'before' | 'after' | 'into' } | null

/** The script's folder tree: view the structure, jump around, and drag to reorder. */
/** `onJump`: called after jumping to a section or beat (phones close the outline then). */
export function OutlineDrawer({ editor, script, fields, canEdit, onClose, onJump }: { editor: Editor; script: ScriptContext; fields: FieldDef[]; canEdit: boolean; onClose: () => void; onJump?: () => void }) {
  const [outline, setOutline] = useState<OutlineSection[]>(() => readOutline(editor.state.doc))
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<Drag>(null)
  const [drop, setDrop] = useState<Drop>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Structure follows the document (debounced); beat data follows the beats map.
  useEffect(() => {
    let t: number | undefined
    const update = () => {
      clearTimeout(t)
      t = window.setTimeout(() => setOutline(readOutline(editor.state.doc)), 150)
    }
    editor.on('update', update)
    const onData = () => bump()
    script.beats.observeDeep(onData)
    return () => {
      clearTimeout(t)
      editor.off('update', update)
      script.beats.unobserveDeep(onData)
    }
  }, [editor, script])

  useSyncExternalStore(script.selection.on, () => script.selection.version)
  const current = useEditorState({ editor, selector: ({ editor: e }) => beatAt(e.state)?.node.attrs.id as string | undefined })
  useEffect(() => {
    listRef.current?.querySelector('.ol-beat.current')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const visual = fields.find((f) => f.type === 'visual')
  const scene = fields.find((f) => f.type === 'text')
  const status = fields.find((f) => f.type === 'select')
  const optColor = (f: FieldDef | undefined, id: string | undefined) => f?.options?.find((o) => o.id === id)
  const total = useMemo(() => outline.reduce((n, s) => n + s.beats.length, 0), [outline])

  const go = (sectionId: string, pos: number) => {
    script.collapsed.toggle(`s:${sectionId}`, false)
    requestAnimationFrame(() => reveal(editor, pos, !onJump))
    onJump?.()
  }

  // ---- drag and drop
  const onDragOver = (e: React.DragEvent, kind: 'section' | 'beat', id: string) => {
    if (!drag || !canEdit) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const top = e.clientY < r.top + r.height / 2
    let next: Drop = null
    if (drag.kind === 'beat') next = kind === 'beat' ? { id, where: top ? 'before' : 'after' } : { id, where: 'into' }
    else if (kind === 'section') next = { id, where: top ? 'before' : 'after' }
    if (!next || (next.id === drag.id && next.where !== 'into')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (next.id !== drop?.id || next.where !== drop?.where) setDrop(next)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (drag && drop) {
      if (drag.kind === 'beat') moveBeat(editor, drag.id, drop.where === 'into' ? { startOf: drop.id } : drop.where === 'before' ? { before: drop.id } : { after: drop.id })
      else moveSection(editor, drag.id, drop.where === 'before' ? { before: drop.id } : { after: drop.id })
    }
    setDrag(null)
    setDrop(null)
  }
  const dragProps = (kind: 'section' | 'beat', id: string) =>
    canEdit
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', id)
            // Change the list only after the drag has begun (changing it during dragstart can cancel the drag).
            setTimeout(() => setDrag({ kind, id }))
          },
          onDragEnd: () => {
            setDrag(null)
            setDrop(null)
          },
          onDragOver: (e: React.DragEvent) => onDragOver(e, kind, id),
          onDrop,
        }
      : {}
  const dropClass = (id: string) => (drop?.id === id ? `drop-${drop.where}` : '')

  const keys = (kind: 'section' | 'beat', id: string, sectionId: string, pos: number) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') go(sectionId, pos)
    else if (canEdit && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      nudge(editor, kind, id, e.key === 'ArrowUp' ? -1 : 1)
      // keep focus on the moved row once the outline refreshes
      setTimeout(() => listRef.current?.querySelector<HTMLElement>(`[data-ol="${id}"]`)?.focus(), 200)
    } else if (!e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-ol]') || [])]
      rows[rows.indexOf(e.currentTarget as HTMLElement) + (e.key === 'ArrowUp' ? -1 : 1)]?.focus()
    }
  }

  return (
    <aside className="outline" aria-label="Outline">
      <header className="outline-head">
        <strong>Outline</strong>
        <span className="muted small">
          {outline.length} section{outline.length === 1 ? '' : 's'} · {total} beat{total === 1 ? '' : 's'}
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="Close outline">
          <X size={16} />
        </button>
      </header>
      <div className={`outline-list ${drag?.kind === 'section' ? 'dragging-sections' : ''}`} ref={listRef} role="tree">
        {outline.map((s) => {
          const isFolded = folded.has(s.id) || drag?.kind === 'section'
          return (
            <div key={s.id} className="ol-section" role="treeitem" aria-expanded={!isFolded}>
              <div
                className={`ol-row ol-sec-row ${dropClass(s.id)} ${drag?.id === s.id ? 'dragging' : ''}`}
                data-ol={s.id}
                tabIndex={0}
                onClick={() => go(s.id, s.pos)}
                onKeyDown={keys('section', s.id, s.id, s.pos)}
                {...dragProps('section', s.id)}
              >
                {canEdit && <GripVertical size={14} className="ol-grip" />}
                <button
                  className={`ol-fold ${isFolded ? 'folded' : ''}`}
                  aria-label={isFolded ? 'Expand' : 'Collapse'}
                  onClick={(e) => {
                    e.stopPropagation()
                    const next = new Set(folded)
                    if (next.has(s.id)) next.delete(s.id)
                    else next.add(s.id)
                    setFolded(next)
                  }}
                >
                  <ChevronDown size={14} />
                </button>
                <span className={`ol-sec-title ${s.title ? '' : 'muted'}`}>{s.title || 'Untitled section'}</span>
                <span className="ol-count">{s.beats.length}</span>
                {canEdit && (
                  <button
                    className="ol-add"
                    title="Add a beat at the end of this section"
                    aria-label="Add beat"
                    onClick={(e) => {
                      e.stopPropagation()
                      script.collapsed.toggle(`s:${s.id}`, false)
                      addBeat(editor, s.id)
                    }}
                  >
                    <Plus size={13} />
                  </button>
                )}
              </div>
              {!isFolded &&
                s.beats.map((b) => {
                  const v = script.getValue(b.id, visual?.id || '') as VisualValue | undefined
                  const vOpt = optColor(visual, v?.type)
                  const st = optColor(status, script.getValue(b.id, status?.id || ''))
                  const sc = scene ? script.getValue(b.id, scene.id) : ''
                  return (
                    <div
                      key={b.id}
                      className={`ol-row ol-beat ${current === b.id ? 'current' : ''} ${script.selection.has(b.id) ? 'picked' : ''} ${dropClass(b.id)} ${drag?.id === b.id ? 'dragging' : ''}`}
                      style={{ '--v': vOpt?.color || 'var(--border-strong)' } as React.CSSProperties}
                      data-ol={b.id}
                      role="treeitem"
                      tabIndex={0}
                      title={[vOpt?.label, sc, st?.label].filter(Boolean).join(' · ')}
                      onClick={(e) => {
                        // Shift = select a range, Cmd/Ctrl = add or remove one; plain click jumps there.
                        if (canEdit && e.shiftKey) script.selection.range(b.id)
                        else if (canEdit && (e.metaKey || e.ctrlKey)) script.selection.toggle(b.id)
                        else go(s.id, b.pos)
                      }}
                      onKeyDown={keys('beat', b.id, s.id, b.pos)}
                      {...dragProps('beat', b.id)}
                    >
                      {canEdit && <GripVertical size={13} className="ol-grip" />}
                      <span className="ol-vbar" />
                      {sc && <span className="ol-scene">{sc}</span>}
                      <span className={`ol-text ${b.text ? '' : 'muted'}`}>{b.text || 'Empty beat'}</span>
                      {st && <span className="ol-status" style={{ background: st.color }} title={st.label} />}
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
      {canEdit && (
        <footer className="outline-foot">
          <button className="btn small" onClick={() => addSection(editor)}>
            <Plus size={14} /> Section
          </button>
          <span className="muted small">Drag to reorder · {keyLabel(['Alt'])}↑↓ moves · Shift/{keyLabel(['Mod'])}-click selects</span>
        </footer>
      )}
    </aside>
  )
}
