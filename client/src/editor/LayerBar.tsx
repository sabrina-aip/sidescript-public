import { useMemo } from 'react'
import { ChevronsDown, ChevronsUp, Eye, EyeOff, FileText, Focus, Layers, ListTree, Maximize, MessageSquare, Minimize, PanelRight, Rows3, Table2, Tags } from 'lucide-react'
import { K, tip } from './shortcuts'
import type { AnchorInfo } from './marks'
import type { Category, Note } from './model'

export interface ViewState {
  hidden: string[] // category ids switched off
  comments: boolean
  mode: 'script' | 'annotated' | 'focus'
  panel: 'notes' | 'comments' | null
  group: 'position' | 'category'
  layout?: 'document' | 'table'
  outline?: boolean
}

const MODES: { id: ViewState['mode']; label: string; icon: React.ReactNode; help: string }[] = [
  { id: 'script', label: 'Script', icon: <FileText size={14} />, help: 'Bare text only — no annotations or comments' },
  { id: 'annotated', label: 'Annotated', icon: <Layers size={14} />, help: 'Text with the layers you switch on' },
  { id: 'focus', label: 'Focus', icon: <Focus size={14} />, help: 'Fade everything except passages in the layers you switch on' },
]

/** The colour key: toggle which annotation layers are visible. */
export function LayerBar({ categories, notes, anchors, comments, view, setView, onEditLabels, canEdit, menusHidden, onToggleMenus, fullscreen, onToggleFullscreen }: {
  menusHidden: boolean
  onToggleMenus: () => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  categories: Category[]
  notes: Map<string, Note>
  anchors: AnchorInfo[]
  comments: number
  view: ViewState
  setView: (fn: (v: ViewState) => ViewState) => void
  onEditLabels: () => void
  canEdit: boolean
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of anchors) {
      const n = notes.get(a.id)
      // Count open annotations only; completed ones are filed away.
      if (n && !n.completed) m.set(n.category, (m.get(n.category) || 0) + 1)
    }
    return m
  }, [anchors, notes])

  const script = view.mode === 'script'
  const toggle = (id: string) => setView((v) => ({ ...v, mode: v.mode === 'script' ? 'annotated' : v.mode, hidden: v.hidden.includes(id) ? v.hidden.filter((h) => h !== id) : [...v.hidden, id] }))
  const solo = (id: string) => setView((v) => ({ ...v, mode: v.mode === 'script' ? 'annotated' : v.mode, hidden: categories.filter((c) => c.id !== id).map((c) => c.id) }))

  return (
    <div className="layerbar" aria-label="Annotation layers">
      <button className={`btn small ${view.outline ? 'on' : ''}`} aria-pressed={!!view.outline} title="Outline: view, jump to and reorder sections and beats" onClick={() => setView((v) => ({ ...v, outline: !v.outline }))}>
        <ListTree size={14} /> Outline
      </button>
      <div className="seg" role="radiogroup" aria-label="Layout">
        <button role="radio" aria-checked={view.layout !== 'table'} className={view.layout !== 'table' ? 'on' : ''} title="Flowing script with each beat's data in a slim header" onClick={() => setView((v) => ({ ...v, layout: 'document' }))}>
          <Rows3 size={14} /> Document
        </button>
        <button role="radio" aria-checked={view.layout === 'table'} className={view.layout === 'table' ? 'on' : ''} title="Beats as rows: Visual · Dialogue · Scene · Status" onClick={() => setView((v) => ({ ...v, layout: 'table', mode: v.mode === 'script' ? 'annotated' : v.mode }))}>
          <Table2 size={14} /> Table
        </button>
      </div>
      <div className="seg" role="radiogroup" aria-label="View">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={view.mode === m.id} className={view.mode === m.id ? 'on' : ''} title={m.help} onClick={() => setView((v) => ({ ...v, mode: m.id }))}>
            {m.icon} {m.label}
          </button>
        ))}
      </div>

      <div className={`layer-chips ${script ? 'dim' : ''}`}>
        {categories.map((c) => {
          const on = !script && !view.hidden.includes(c.id)
          return (
            <button
              key={c.id}
              className={`chip ${on ? 'on' : ''}`}
              style={{ '--chip': c.color } as React.CSSProperties}
              onClick={(e) => (e.altKey || e.shiftKey ? solo(c.id) : toggle(c.id))}
              onDoubleClick={() => solo(c.id)}
              aria-pressed={on}
              title={`${on ? 'Hide' : 'Show'} ${c.name} (double-click to show only this layer)`}
            >
              <span className="chip-dot" />
              {c.name}
              <span className="chip-count">{counts.get(c.id) || 0}</span>
            </button>
          )
        })}
        <button className={`chip comments ${!script && view.comments ? 'on' : ''}`} onClick={() => setView((v) => ({ ...v, mode: v.mode === 'script' ? 'annotated' : v.mode, comments: !v.comments }))} aria-pressed={!script && view.comments} title="Show or hide comments">
          <MessageSquare size={13} /> Comments <span className="chip-count">{comments}</span>
        </button>
      </div>

      <div className="layer-actions">
        <button className="link-btn" onClick={() => setView((v) => ({ ...v, mode: v.mode === 'script' ? 'annotated' : v.mode, hidden: [], comments: true }))} title="Show all layers and comments">
          <Eye size={14} /> All
        </button>
        <button className="link-btn" onClick={() => setView((v) => ({ ...v, hidden: categories.map((c) => c.id), comments: false }))} title="Hide all layers and comments">
          <EyeOff size={14} /> None
        </button>
        <button className="link-btn" onClick={onEditLabels} title={canEdit ? 'Names and colours of annotations, chips and section bars' : 'View labels'}>
          <Tags size={14} /> Label Options
        </button>
        <button className={`icon-btn ${view.panel ? 'on' : ''}`} onClick={() => setView((v) => ({ ...v, panel: v.panel ? null : 'notes' }))} title="Toggle side panel" aria-label="Toggle side panel" disabled={script}>
          <PanelRight size={16} />
        </button>
        <span className="layer-sep" />
        <button className={`icon-btn ${menusHidden ? 'on' : ''}`} onClick={onToggleMenus} title={tip(menusHidden ? 'Show the menus' : 'Hide the menus', K.hideMenus)} aria-label={menusHidden ? 'Show the menus' : 'Hide the menus'} aria-pressed={menusHidden}>
          {menusHidden ? <ChevronsDown size={16} /> : <ChevronsUp size={16} />}
        </button>
        {document.fullscreenEnabled && (
          <button className={`icon-btn ${fullscreen ? 'on' : ''}`} onClick={onToggleFullscreen} title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} aria-pressed={fullscreen}>
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
        )}
      </div>
    </div>
  )
}
