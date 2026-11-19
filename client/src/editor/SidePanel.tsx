import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { Check, ChevronDown, ChevronRight, RotateCcw, Trash2, X } from 'lucide-react'
import type { User } from '../api'
import { Avatar } from '../components/ui'
import { confirmAt } from '../components/confirmAt'
import { shortId, timeAgo } from '../util'
import { isControlClick, scrollToAnchor, type AnchorInfo } from './marks'
import { type Category, type getMaps, type Note, type Thread } from './model'
import type { ViewState } from './LayerBar'
import { NoteCard } from './NoteCard'
import { K, keyLabel } from './shortcuts'

type Maps = ReturnType<typeof getMaps>

export interface Props {
  editor: Editor
  docId: string
  user: User
  canEdit: boolean
  /** The document owner can edit, delete or reopen any annotation and reply. */
  isOwner: boolean
  maps: Maps
  categories: Category[]
  notes: Map<string, Note>
  comments: Map<string, Thread>
  anchors: { ann: AnchorInfo[]; cmt: AnchorInfo[] }
  view: ViewState
  setView: (fn: (v: ViewState) => ViewState) => void
  visibleCat: (id: string) => boolean
  active: { kind: 'note' | 'comment'; id: string } | null
  setActive: (a: { kind: 'note' | 'comment'; id: string } | null) => void
  reveal: (a: AnchorInfo) => void
  removeNote: (id: string, message?: string) => void
  removeThread: (id: string) => void
}

export function SidePanel(p: Props) {
  const tab = p.view.panel || 'notes'
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll the active card into view when a highlight is clicked.
  useEffect(() => {
    if (!p.active) return
    const el = listRef.current?.querySelector(`[data-card="${CSS.escape(p.active.id)}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [p.active, tab])

  const openThreads = p.anchors.cmt.filter((a) => {
    const t = p.comments.get(a.id)
    return t && !t.resolved && (!t.draft || t.author === p.user.username)
  })

  return (
    <aside className="side-panel" aria-label="Annotations and comments">
      <div className="panel-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'active' : ''} onClick={() => p.setView((v) => ({ ...v, panel: 'notes' }))}>
          Annotations
        </button>
        <button role="tab" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'active' : ''} onClick={() => p.setView((v) => ({ ...v, panel: 'comments' }))}>
          Comments {openThreads.length > 0 && <span className="chip-count">{openThreads.length}</span>}
        </button>
        <button className="icon-btn" onClick={() => p.setView((v) => ({ ...v, panel: null }))} aria-label="Close panel">
          <X size={16} />
        </button>
      </div>
      <div
        className="panel-body"
        ref={listRef}
        onClick={(e) => {
          // Empty space in the panel deselects; clicks inside a card (or on a control) don't.
          if (!(e.target as HTMLElement).closest('.note-card, .thread-card, button, select, input, textarea, label, a')) p.setActive(null)
        }}
      >
        {tab === 'notes' ? <NotesList {...p} /> : <CommentsList {...p} />}
      </div>
    </aside>
  )
}

// ================================================================ notes

function NotesList(p: Props) {
  const [showDetached, setShowDetached] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const catById = useMemo(() => new Map(p.categories.map((c) => [c.id, c])), [p.categories])
  const visible = p.anchors.ann.filter((a) => {
    const n = p.notes.get(a.id)
    return n && p.visibleCat(n.category)
  })
  // Completed annotations are filed in their own section at the bottom (like resolved comments).
  const attached = visible.filter((a) => !p.notes.get(a.id)!.completed)
  const completed = visible.filter((a) => p.notes.get(a.id)!.completed)
  // A completed annotation clicked in the text opens its section.
  useEffect(() => {
    if (p.active?.kind === 'note' && p.notes.get(p.active.id)?.completed) setShowCompleted(true)
  }, [p.active, p.notes])
  const anchoredIds = new Set(p.anchors.ann.map((a) => a.id))
  const detached = [...p.notes.values()].filter((n) => !anchoredIds.has(n.id) && p.visibleCat(n.category))

  const card = (a: AnchorInfo | null, n: Note) => (
    <NoteCard key={n.id} {...p} anchor={a} note={n} category={catById.get(n.category)} isActive={p.active?.kind === 'note' && p.active.id === n.id} />
  )

  const visibleCats = p.categories.filter((c) => p.visibleCat(c.id))

  return (
    <>
      <div className="panel-tools">
        <label className="small muted">
          Order{' '}
          <select value={p.view.group} onChange={(e) => p.setView((v) => ({ ...v, group: e.target.value as ViewState['group'] }))}>
            <option value="position">As they appear in the text</option>
            <option value="category">Grouped by layer</option>
          </select>
        </label>
      </div>
      {attached.length === 0 && (
        <div className="panel-empty">
          {visibleCats.length === 0 ? (
            <p>All layers are hidden. Switch some on in the bar above.</p>
          ) : completed.length > 0 ? (
            <p>Every annotation in the visible layers is complete.</p>
          ) : (
            <>
              <p>No annotations in the visible layers yet.</p>
              {p.canEdit && <p className="small muted">Select text, then pick a colour from the bubble, the Annotate menu, or press {keyLabel(['Alt', '1…9'])}.</p>}
            </>
          )}
        </div>
      )}
      {p.view.group === 'position'
        ? attached.map((a) => card(a, p.notes.get(a.id)!))
        : visibleCats.map((c) => {
            const mine = attached.filter((a) => p.notes.get(a.id)!.category === c.id)
            if (!mine.length) return null
            return (
              <section key={c.id} className="note-group">
                <h4 style={{ borderColor: c.color }}>
                  {c.name} <span className="muted">({mine.length})</span>
                </h4>
                {mine.map((a) => card(a, p.notes.get(a.id)!))}
              </section>
            )
          })}
      {completed.length > 0 && (
        <section className="note-group detached">
          <button className="link-btn" onClick={() => setShowCompleted(!showCompleted)}>
            {showCompleted ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Completed ({completed.length})
          </button>
          {showCompleted && completed.map((a) => card(a, p.notes.get(a.id)!))}
        </section>
      )}
      {detached.length > 0 && (
        <section className="note-group detached">
          <button className="link-btn" onClick={() => setShowDetached(!showDetached)}>
            {showDetached ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Annotations whose text was deleted ({detached.length})
          </button>
          {showDetached && detached.map((n) => card(null, n))}
        </section>
      )}
    </>
  )
}

// ================================================================ comments

function CommentsList(p: Props) {
  const [showResolved, setShowResolved] = useState(false)
  const threads = p.anchors.cmt
    .map((a) => ({ a, t: p.comments.get(a.id) }))
    .filter((x): x is { a: AnchorInfo; t: Thread } => !!x.t && (!x.t.draft || x.t.author === p.user.username))
  const open = threads.filter((x) => !x.t.resolved)
  const resolved = threads.filter((x) => x.t.resolved)
  return (
    <>
      {!p.view.comments && <div className="panel-empty small">Comments are hidden in the text. Switch on “Comments” in the bar above to see them.</div>}
      {open.length === 0 && (
        <div className="panel-empty">
          <p>No open comments.</p>
          {p.canEdit && <p className="small muted">Select text and press {keyLabel(K.comment)}, or use the comment button.</p>}
        </div>
      )}
      {open.map(({ a, t }) => (
        <ThreadCard key={t.id} {...p} anchor={a} thread={t} isActive={p.active?.kind === 'comment' && p.active.id === t.id} />
      ))}
      {resolved.length > 0 && (
        <section className="note-group detached">
          <button className="link-btn" onClick={() => setShowResolved(!showResolved)}>
            {showResolved ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Resolved ({resolved.length})
          </button>
          {showResolved && resolved.map(({ a, t }) => <ThreadCard key={t.id} {...p} anchor={a} thread={t} isActive={false} />)}
        </section>
      )}
    </>
  )
}

function ThreadCard(p: Props & { anchor: AnchorInfo; thread: Thread; isActive: boolean }) {
  const { thread: t, user, canEdit } = p
  const [reply, setReply] = useState('')
  const [draft, setDraft] = useState('')
  const set = (patch: Partial<Thread>) => {
    const cur = p.maps.comments.get(t.id)
    if (cur) p.maps.comments.set(t.id, { ...cur, ...patch })
  }

  if (t.draft)
    return (
      <article className="thread-card active" data-card={t.id}>
        <div className="note-quote">{p.anchor.text.slice(0, 160)}</div>
        <textarea autoFocus className="note-text" placeholder="Add a comment…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim() && set({ text: draft.trim(), draft: false, createdAt: new Date().toISOString() })} />
        <footer className="note-foot">
          <button className="btn small" onClick={() => p.removeThread(t.id)}>
            Cancel
          </button>
          <button className="btn small primary" disabled={!draft.trim()} onClick={() => set({ text: draft.trim(), draft: false, createdAt: new Date().toISOString() })}>
            Comment
          </button>
        </footer>
      </article>
    )

  return (
    <article className={`thread-card ${p.isActive ? 'active' : ''} ${t.resolved ? 'resolved' : ''}`} data-card={t.id}
      onClick={(e) => {
        p.setActive({ kind: 'comment', id: t.id })
        if (!isControlClick(e)) scrollToAnchor(p.editor, p.anchor, 'comment')
      }}
    >
      <button className="note-quote" onClick={() => p.reveal(p.anchor)} title="Show in document">
        {p.anchor.text.length > 140 ? p.anchor.text.slice(0, 140) + '…' : p.anchor.text}
      </button>
      {[{ id: 'root', author: t.author, authorName: t.authorName, text: t.text, createdAt: t.createdAt }, ...t.replies].map((m) => (
        <div key={m.id} className="msg">
          <Avatar name={m.authorName} color={m.author === user.username ? user.color : '#64748b'} size={22} />
          <div>
            <div className="msg-head">
              <strong>{m.authorName}</strong> <span className="muted small">{timeAgo(m.createdAt)}</span>
            </div>
            <div className="msg-text">{m.text}</div>
          </div>
        </div>
      ))}
      {canEdit && !t.resolved && (
        <div className="reply">
          <input
            placeholder="Reply…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reply.trim()) {
                set({ replies: [...t.replies, { id: shortId(), author: user.username, authorName: user.displayName, text: reply.trim(), createdAt: new Date().toISOString() }] })
                setReply('')
              }
            }}
          />
        </div>
      )}
      {canEdit && (
        <footer className="note-foot">
          <button className="btn small" onClick={(e) => (e.stopPropagation(), set({ resolved: !t.resolved }))}>
            {t.resolved ? <RotateCcw size={14} /> : <Check size={14} />} {t.resolved ? 'Reopen' : 'Resolve'}
          </button>
          {t.author === user.username && (
            <button
              className="icon-btn danger"
              title="Delete comment"
              onClick={(e) => {
                e.stopPropagation()
                const btn = e.currentTarget
                void confirmAt(btn, { message: 'Delete this comment and its replies? This can’t be undone.', confirm: 'Delete', danger: true }).then((ok) => ok && p.removeThread(t.id))
              }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </footer>
      )}
    </article>
  )
}
