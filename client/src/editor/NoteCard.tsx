/**
 * One annotation in the side panel.
 *
 * Two states:
 *  - Draft / editing: the note box, Attach file, Done (Ctrl/Cmd+Enter) and delete. It saves as you
 *    type; "Done" only changes how the card looks.
 *  - Finished: a tidy read-only card (clickable links, compact link rows, "+N more"), with
 *    Edit / Delete in a ⋯ menu. Double-click the text to edit. Later changes show "edited".
 *
 * `done` is shared, so collaborators see when an annotation is complete. Empty annotations stay
 * as drafts, so you can highlight several passages first and fill them in later.
 *
 * Links: pasting text with several links embeds each one (the server fetches it once and keeps
 * a local copy), shown as placeholders that fill in as they arrive; failures can be kept as a
 * plain link or retried.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, FileIcon, GripVertical, Link2, MoreHorizontal, Paperclip, Pencil, Play, RotateCcw, SmilePlus, Trash2, X } from 'lucide-react'
import { api, uploadFile } from '../api'
import { Menu } from '../components/ui'
import { DATA_ORIGIN } from '../script/context'
import { shortId, timeAgo, toast } from '../util'
import { withUndo } from './undoable'
import { addAnchor, isControlClick, recolorAnnotation, scrollToAnchor, type AnchorInfo } from './marks'
import { formatCitation, isNoteDone, REACTIONS, type Attachment, type Category, type Note } from './model'
import type { Props } from './SidePanel'
import { ReplyComposer, ReplyList } from './Replies'
import { K, tip } from './shortcuts'

const MAX_LINKS = 10 // per paste
const PARALLEL = 3
const SHOWN = 2 // attachments shown on a finished card before "+N more"

// ---------------------------------------------------------------- links in text

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi

/** Trim punctuation that ends a sentence rather than the link ("see https://x.org/a)."). */
function cleanUrl(u: string) {
  let s = u.replace(/[.,;:!?'"]+$/, '')
  while (s.endsWith(')') && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = s.slice(0, -1)
  return s
}

export function findLinks(text: string) {
  return [...new Set((text.match(URL_RE) || []).map(cleanUrl).filter((u) => /^https?:\/\/[^/\s]+\.[^/\s]/i.test(u)))]
}

/** Note text with its links made clickable. */
function Linkified({ text }: { text: string }) {
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0])
    const at = m.index!
    out.push(text.slice(last, at))
    out.push(
      <a key={at} href={url} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()}>
        {url}
      </a>,
    )
    last = at + url.length
  }
  out.push(text.slice(last))
  return <>{out}</>
}

const hostOf = (u?: string) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- typing that never gets lost

function useDebouncedField<T>(value: T, save: (v: T) => void, delay = 400) {
  const [local, setLocal] = useState(value)
  const timer = useRef<number | undefined>(undefined)
  const dirty = useRef(false)
  const latest = useRef({ v: value, save })
  latest.current.save = save
  useEffect(() => {
    if (!dirty.current) setLocal(value)
  }, [value])
  const set = (v: T) => {
    dirty.current = true
    latest.current.v = v
    setLocal(v)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, delay)
  }
  function flush() {
    clearTimeout(timer.current)
    if (!dirty.current) return
    dirty.current = false
    latest.current.save(latest.current.v)
  }
  // Never drop typing: flush a pending edit if the card unmounts (e.g. layer hidden).
  useEffect(() => () => flush(), []) // eslint-disable-line react-hooks/exhaustive-deps
  return [local, set, flush] as const
}

// ---------------------------------------------------------------- the card

type Pending = { key: string; url: string; batch: string; failed?: string }

export function NoteCard(p: Props & { anchor: AnchorInfo | null; note: Note; category?: Category; isActive: boolean }) {
  const { note, category, canEdit } = p
  const fileRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const [editing, setEditing] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [unembedded, setUnembedded] = useState<string[]>([])
  const snapshot = useRef('')

  const done = isNoteDone(note)
  // The annotation belongs to its author (and the document owner can step in); everyone else
  // with edit access replies, reacts and can mark it complete.
  const isOwner = !!p.isOwner
  const canModify = canEdit && (note.author === p.user.username || isOwner)
  const writing = canModify && (!done || editing)

  const update = (patch: Partial<Note>) => {
    const cur = p.maps.notes.get(note.id)
    if (cur) p.maps.notes.set(note.id, { ...cur, ...patch, updatedAt: new Date().toISOString() })
  }
  const [text, setText, flushText] = useDebouncedField(note.text, (text) => update({ text }))

  // Annotations are all the same now: older notes with a citation form or link field
  // get those details folded into their text, once, so nothing is lost.
  useEffect(() => {
    if (!canModify) return
    const hasCitation = note.citation && Object.values(note.citation).some(Boolean)
    if (!hasCitation && !note.url) return
    const extra = [hasCitation ? formatCitation(note.citation) : '', note.url && !formatCitation(note.citation).includes(note.url) ? note.url : ''].filter(Boolean).join('\n')
    const cur = p.maps.notes.get(note.id)
    if (cur) p.maps.notes.set(note.id, { ...cur, text: [extra, cur.text].filter(Boolean).join('\n\n'), citation: undefined, url: undefined })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id])

  // ---- finishing and editing
  const contentKey = (n: Pick<Note, 'text' | 'attachments'>) => JSON.stringify([n.text, (n.attachments || []).map((a) => a.id)])
  function startEditing() {
    if (!canModify) return
    snapshot.current = contentKey(note)
    setEditing(true)
    requestAnimationFrame(() => {
      const t = textRef.current
      if (t) (t.focus(), t.setSelectionRange(t.value.length, t.value.length))
    })
  }
  function finish() {
    flushText()
    const cur = p.maps.notes.get(note.id)
    if (!cur) return
    const wasDone = isNoteDone(note) && editing
    const changed = wasDone && contentKey({ ...cur, text }) !== snapshot.current
    p.maps.notes.set(note.id, {
      ...cur,
      text,
      done: true,
      ...(changed ? { editedAt: new Date().toISOString(), editedByName: p.user.displayName } : {}),
    })
    setEditing(false)
    // Links typed (not pasted) into the note: offer to embed them.
    const have = new Set((cur.attachments || []).map((a) => a.href).filter(Boolean))
    setUnembedded(findLinks(text).filter((u) => !have.has(u)).slice(0, MAX_LINKS))
  }

  // ---- attachments
  const saveAttachments = (fn: (list: Attachment[]) => Attachment[]) => {
    const cur = p.maps.notes.get(note.id)
    if (cur) p.maps.notes.doc!.transact(() => update({ attachments: fn(cur.attachments || []) }), DATA_ORIGIN)
  }
  async function attach(files: FileList | File[]) {
    setBusy('Uploading…')
    try {
      const added: Attachment[] = []
      for (const f of files) {
        const { url, size } = await uploadFile(p.docId, f)
        added.push({ id: shortId(), name: f.name || 'pasted', type: f.type || 'application/octet-stream', url, size })
      }
      saveAttachments((list) => [...list, ...added])
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy('')
    }
  }

  // Each embedded link remembers its place in the paste, so they end up in paste order
  // even though they arrive in any order.
  const placed = useRef(new Map<string, { batch: string; index: number; attId: string }>())
  function placeAttachment(att: Attachment, batch: string, index: number) {
    placed.current.set(att.id, { batch, index, attId: att.id })
    saveAttachments((list) => {
      const at = list.findIndex((x) => {
        const q = placed.current.get(x.id)
        return q && q.batch === batch && q.index > index
      })
      return at < 0 ? [...list, att] : [...list.slice(0, at), att, ...list.slice(at)]
    })
  }
  async function fetchOne(item: Pending, index: number) {
    try {
      const { attachment } = await api<{ attachment: Attachment }>('POST', `/api/docs/${p.docId}/embed`, { url: item.url })
      placeAttachment(attachment, item.batch, index)
      setPending((ps) => ps.filter((x) => x.key !== item.key))
    } catch (e: any) {
      setPending((ps) => ps.map((x) => (x.key === item.key ? { ...x, failed: e.message || 'Couldn’t embed that link' } : x)))
    }
  }
  /** Embed several links, a few at a time, skipping ones already attached or on their way. */
  function embedLinks(urls: string[]) {
    const cur = p.maps.notes.get(note.id)
    const have = new Set([...(cur?.attachments || []).map((a) => a.href), ...pending.map((x) => x.url)])
    const fresh = urls.filter((u) => !have.has(u))
    if (!fresh.length) return
    const batch = shortId()
    const items = fresh.map((url) => ({ key: shortId(), url, batch }))
    setPending((ps) => [...ps, ...items])
    let next = 0
    const worker = async () => {
      while (next < items.length) {
        const i = next++
        await fetchOne(items[i], i)
      }
    }
    for (let k = 0; k < Math.min(PARALLEL, items.length); k++) void worker()
  }
  const retry = (item: Pending) => {
    setPending((ps) => ps.map((x) => (x.key === item.key ? { ...x, failed: undefined } : x)))
    void fetchOne(item, Number.MAX_SAFE_INTEGER)
  }
  const keepAsLink = (item: Pending) => {
    setPending((ps) => ps.filter((x) => x.key !== item.key))
    saveAttachments((list) => [...list, { id: shortId(), type: 'link', name: hostOf(item.url) || item.url, href: item.url, title: item.url, site: hostOf(item.url) }])
  }

  function onPaste(e: React.ClipboardEvent) {
    if (!canModify) return
    const files = [...e.clipboardData.files]
    if (files.length) {
      e.preventDefault()
      return void attach(files)
    }
    const pasted = e.clipboardData.getData('text/plain')
    const links = findLinks(pasted)
    if (!links.length) return
    if (!writing) startEditing()
    const embed = links.slice(0, MAX_LINKS)
    const rest = links.slice(MAX_LINKS)
    // Only links: they all become attachments (any beyond the limit stay as text).
    // Links inside other text: the text pastes as usual, and the links are embedded too.
    if (!pasted.replace(URL_RE, '').trim()) {
      e.preventDefault()
      if (rest.length) setText(text ? `${text}\n${rest.join('\n')}` : rest.join('\n'))
    } else if (rest.length) toast(`Embedding the first ${MAX_LINKS} links; the rest stay as text`)
    embedLinks(embed)
  }

  // ---- reorder attachments by dragging
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)
  const moveAttachment = (from: number, to: number) =>
    saveAttachments((list) => {
      const next = [...list]
      next.splice(to, 0, next.splice(from, 1)[0])
      return next
    })

  const color = category?.color || '#888'
  const atts = note.attachments || []
  const visibleAtts = writing || showAll ? atts : atts.slice(0, SHOWN)
  // ---- conversation: reactions, replies, complete
  const me = p.user
  const replies = note.replies || []
  const reactions = Object.entries(note.reactions || {}).filter(([, who]) => who.length)
  const [replying, setReplying] = useState(false)
  /** Change the note without bumping its "updated" time (talking about it isn't editing it). */
  const patch = (fn: (cur: Note) => Partial<Note>) => {
    const cur = p.maps.notes.get(note.id)
    if (cur) p.maps.notes.set(note.id, { ...cur, ...fn(cur) })
  }
  const toggleReaction = (emoji: string) =>
    patch((cur) => {
      const all = { ...(cur.reactions || {}) }
      const who = all[emoji] || []
      all[emoji] = who.some((x) => x.u === me.username) ? who.filter((x) => x.u !== me.username) : [...who, { u: me.username, n: me.displayName }]
      if (!all[emoji].length) delete all[emoji]
      return { reactions: all }
    })
  const sendReply = (text: string, attachments: Attachment[]) => {
    patch((cur) => ({ replies: [...(cur.replies || []), { id: shortId(), author: me.username, authorName: me.displayName, text, attachments, createdAt: new Date().toISOString() }] }))
    setReplying(false)
  }
  const editReply = (id: string, text: string, attachments: Attachment[]) =>
    patch((cur) => ({ replies: (cur.replies || []).map((r) => (r.id === id ? { ...r, text, attachments, editedAt: new Date().toISOString() } : r)) }))
  // Deleted replies leave a placeholder (their words and attachments are removed). Undoable.
  const deleteReply = (id: string) =>
    withUndo(p.editor, 'Reply deleted', () =>
      p.maps.notes.doc!.transact(
        () => patch((cur) => ({ replies: (cur.replies || []).map((r) => (r.id === id ? { id: r.id, author: r.author, authorName: r.authorName, createdAt: r.createdAt, text: '', attachments: [], deleted: true } : r)) })),
        DATA_ORIGIN,
      ),
    )
  // Anyone can complete; reopening is for the author, whoever completed it, or the owner.
  const canReopen = canModify || note.completedBy === me.username
  const setCompleted = (on: boolean) => {
    if (on) p.setActive(null) // let its highlight go
    withUndo(p.editor, on ? 'Marked complete' : 'Reopened', () =>
      p.maps.notes.doc!.transact(
        () => patch(() => (on ? { completed: true, completedAt: new Date().toISOString(), completedByName: me.displayName, completedBy: me.username } : { completed: false, completedAt: undefined, completedByName: undefined, completedBy: undefined })),
        DATA_ORIGIN,
      ),
    )
  }

  const edited = note.editedAt ? ` · edited ${timeAgo(note.editedAt)}${note.editedByName && note.editedByName !== note.authorName ? ` by ${note.editedByName}` : ''}` : ''

  return (
    <article
      ref={cardRef}
      className={`note-card ${p.isActive ? 'active' : ''} ${done ? 'done' : 'draft'} ${writing ? 'writing' : ''}`}
      data-card={note.id}
      style={{ '--cat': color } as React.CSSProperties}
      onClick={(e) => {
        p.setActive({ kind: 'note', id: note.id })
        // Clicking the card jumps to its text. (Completed annotations are hidden in the script:
        // selecting one shows it in full highlighter form, so it's easy to find once there.)
        if (p.anchor && !isControlClick(e)) scrollToAnchor(p.editor, p.anchor, 'note')
      }}
      onPaste={onPaste}
      onDragOver={(e) => canModify && !drag && e.preventDefault()}
      onDrop={(e) => {
        if (!canModify || drag) return
        if (e.dataTransfer.files.length) {
          e.preventDefault()
          return void attach(e.dataTransfer.files)
        }
        const links = findLinks(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'))
        if (links.length) {
          e.preventDefault()
          if (!writing) startEditing()
          embedLinks(links.slice(0, MAX_LINKS))
        }
      }}
    >
      <header className="note-head">
        {canModify ? (
          <select
            className="note-cat"
            value={note.category}
            aria-label="Annotation"
            onChange={(e) => {
              recolorAnnotation(p.editor, note.id, e.target.value)
              update({ category: e.target.value })
            }}
          >
            {p.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="note-cat">{category?.name || 'Annotation'}</span>
        )}
        {!done && <span className="draft-tag">Draft</span>}
        <span className="muted small note-time" title={edited ? edited.slice(3) : undefined}>
          {note.authorName} · {timeAgo(note.createdAt || note.updatedAt)}
          {note.editedAt ? ' · edited' : ''}
        </span>
      </header>

      {p.anchor ? (
        <button className="note-quote" onClick={() => p.reveal(p.anchor!)} title="Show in document">
          {p.anchor.text.length > 180 ? p.anchor.text.slice(0, 180) + '…' : p.anchor.text}
        </button>
      ) : (
        <div className="note-quote detached-q">
          The annotated text was removed.
          {canModify && (
            <button
              className="link-btn"
              onClick={(e) => {
                e.stopPropagation()
                const { from, to, empty } = p.editor.state.selection
                if (empty) return toast('Select text in the document first')
                addAnchor(p.editor, 'annotation', { id: note.id, cat: note.category }, from, to)
              }}
            >
              <Link2 size={13} /> Attach to selection
            </button>
          )}
        </div>
      )}

      {writing ? (
        <textarea
          ref={textRef}
          className="note-text"
          value={text}
          placeholder="Write a note, or paste links to embed them…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              finish()
            }
          }}
          rows={Math.min(10, Math.max(2, text.split('\n').length + Math.floor(text.length / 40)))}
          autoFocus={p.isActive && !note.text && !atts.length}
        />
      ) : (
        note.text.trim() && (
          <div className="note-read" onDoubleClick={startEditing} title={canModify ? 'Double-click to edit' : undefined}>
            <Linkified text={note.text} />
          </div>
        )
      )}

      {unembedded.length > 0 && !writing && (
        <div className="note-offer">
          <span>
            {unembedded.length} link{unembedded.length === 1 ? '' : 's'} in this note {unembedded.length === 1 ? 'isn’t' : 'aren’t'} embedded
          </span>
          <button
            className="link-btn"
            onClick={(e) => {
              e.stopPropagation()
              embedLinks(unembedded)
              setUnembedded([])
            }}
          >
            Embed {unembedded.length === 1 ? 'it' : 'them'}
          </button>
          <button className="icon-btn" aria-label="Dismiss" onClick={(e) => (e.stopPropagation(), setUnembedded([]))}>
            <X size={12} />
          </button>
        </div>
      )}

      {(atts.length > 0 || pending.length > 0) && (
        <div className={`attachments ${writing ? '' : 'compact'}`}>
          {visibleAtts.map((a, i) => (
            <AttachmentView
              key={a.id}
              a={a}
              compact={!writing}
              canEdit={writing}
              onRemove={() => withUndo(p.editor, `Removed “${a.title || a.name}”`, () => saveAttachments((list) => list.filter((x) => x.id !== a.id)))}
              drag={
                writing && atts.length > 1
                  ? {
                      dropClass: drag && drag.over === i && drag.from !== i ? (drag.from < i ? 'drop-below' : 'drop-above') : '',
                      onStart: () => setDrag({ from: i, over: i }),
                      onEnd: () => setDrag(null),
                      onOver: () => drag && drag.over !== i && setDrag({ ...drag, over: i }),
                      onDrop: () => {
                        if (drag && drag.from !== i) moveAttachment(drag.from, i)
                        setDrag(null)
                      },
                    }
                  : undefined
              }
            />
          ))}
          {!writing && !showAll && atts.length > SHOWN && (
            <button className="att-more" onClick={(e) => (e.stopPropagation(), setShowAll(true))}>
              <ChevronDown size={14} /> {atts.length - SHOWN} more
            </button>
          )}
          {pending.map((x) =>
            x.failed ? (
              <div key={x.key} className="att-pending failed">
                <span className="att-pending-text">
                  Couldn’t embed <strong>{hostOf(x.url) || x.url}</strong>
                  <span className="muted small"> · {x.failed}</span>
                </span>
                <span className="att-pending-actions">
                  <button className="link-btn" onClick={(e) => (e.stopPropagation(), keepAsLink(x))}>
                    Keep as plain link
                  </button>
                  <button className="link-btn" onClick={(e) => (e.stopPropagation(), retry(x))}>
                    <RotateCcw size={12} /> Retry
                  </button>
                  <button className="icon-btn" aria-label="Dismiss" onClick={(e) => (e.stopPropagation(), setPending((ps) => ps.filter((y) => y.key !== x.key)))}>
                    <X size={12} />
                  </button>
                </span>
              </div>
            ) : (
              <div key={x.key} className="att-pending">
                <span className="spinner" aria-hidden="true" /> Fetching {hostOf(x.url) || x.url}…
              </div>
            ),
          )}
        </div>
      )}

      {reactions.length > 0 && (
        <div className="reactions">
          {reactions.map(([emoji, who]) => {
            const mine = who.some((x) => x.u === me.username)
            return (
              <button
                key={emoji}
                className={`react-pill ${mine ? 'mine' : ''}`}
                disabled={!canEdit}
                title={`${who.map((x) => x.n).join(', ')}${canEdit ? (mine ? ' · click to remove yours' : ' · click to add yours') : ''}`}
                onClick={(e) => (e.stopPropagation(), toggleReaction(emoji))}
              >
                <span className="emoji">{emoji}</span> {who.length}
              </button>
            )
          })}
        </div>
      )}

      {replies.length > 0 && (
        <ReplyList
          replies={replies}
          me={me}
          isOwner={isOwner}
          canEdit={canEdit}
          docId={p.docId}
          linkify={(t) => <Linkified text={t} />}
          onEdit={editReply}
          onDelete={deleteReply}
        />
      )}

      {note.completed && (
        <div
          className="muted small completed-by"
          title={`Completed${note.completedByName ? ` by ${note.completedByName}` : ''}${note.completedAt ? `, ${new Date(note.completedAt).toLocaleString()}` : ''}`}
        >
          <Check size={13} /> Completed{note.completedByName ? ` by ${note.completedByName}` : ''}
          {note.completedAt ? ` · ${timeAgo(note.completedAt)}` : ''}
        </div>
      )}

      {canEdit && replying && <ReplyComposer docId={p.docId} submitLabel="Reply" onCancel={() => setReplying(false)} onSubmit={sendReply} />}

      {canEdit &&
        (writing ? (
          <footer className="note-foot">
            <button className="btn small" onClick={() => fileRef.current?.click()} disabled={!!busy}>
              <Paperclip size={14} /> {busy || 'Attach file'}
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              multiple
              onChange={(e) => {
                if (e.target.files?.length) attach(e.target.files)
                e.target.value = ''
              }}
            />
            <button
              className="icon-btn danger"
              style={{ marginLeft: 'auto' }}
              title="Remove annotation"
              aria-label="Remove annotation"
              onClick={(e) => {
                e.stopPropagation()
                p.removeNote(note.id)
              }}
            >
              <Trash2 size={14} />
            </button>
            <button
              className="btn small primary"
              title={tip('Done', K.done)}
              onClick={(e) => {
                e.stopPropagation()
                finish()
              }}
            >
              Done
            </button>
          </footer>
        ) : (
          <footer className="note-foot read" onClick={(e) => e.stopPropagation()}>
            <button className="link-btn" onClick={() => setReplying(true)}>
              Reply
            </button>
            <span className="foot-actions">
              <ReactButton onPick={toggleReaction} />
              {canModify && (
                <Menu
                  label="Annotation options"
                  align="right"
                  trigger={<MoreHorizontal size={15} />}
                  items={[
                    { label: 'Edit', icon: <Pencil size={14} />, onClick: startEditing },
                    { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => p.removeNote(note.id) },
                  ]}
                />
              )}
              {note.completed ? (
                canReopen && <button className="btn small" onClick={() => setCompleted(false)}>
                  <RotateCcw size={13} /> Reopen
                </button>
              ) : (
                <button className="icon-btn complete-btn" title="Mark as complete" aria-label="Mark as complete" onClick={() => setCompleted(true)}>
                  <Check size={15} />
                </button>
              )}
            </span>
          </footer>
        ))}
    </article>
  )
}

// ---------------------------------------------------------------- reactions

/** The smiley button: a small row of emoji to react with. */
function ReactButton({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return
    const r = btn.current.getBoundingClientRect()
    const w = pop.current.offsetWidth
    const h = pop.current.offsetHeight
    setPos({ left: Math.max(8, Math.min(r.right - w, document.documentElement.clientWidth - w - 8)), top: r.top - h - 6 > 8 ? r.top - h - 6 : r.bottom + 6 })
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return
        e.stopPropagation()
      } else if (pop.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close, true)
    document.addEventListener('keydown', close, true)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', close, true)
      document.removeEventListener('keydown', close, true)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])
  return (
    <>
      <button ref={btn} className="icon-btn" title="Add reaction" aria-label="Add reaction" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SmilePlus size={15} />
      </button>
      {open &&
        createPortal(
          <div ref={pop} className="react-pop" role="menu" style={{ left: pos.left, top: pos.top }}>
            {REACTIONS.map((e) => (
              <button
                key={e}
                role="menuitem"
                className="react-choice"
                onClick={() => {
                  onPick(e)
                  setOpen(false)
                }}
              >
                {e}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}

// ---------------------------------------------------------------- attachments

type DragProps = { dropClass: string; onStart: () => void; onEnd: () => void; onOver: () => void; onDrop: () => void }

/** One attachment. Everything shown here is served by this server; video players load only on click. */
function AttachmentView({ a, canEdit, compact, onRemove, drag }: { a: Attachment; canEdit: boolean; compact: boolean; onRemove: () => void; drag?: DragProps }) {
  const [playing, setPlaying] = useState(false)
  const [big, setBig] = useState(false)
  let body
  if (a.type === 'video/embed') {
    body = playing ? (
      <iframe
        className="att-player"
        src={`${a.embed}${a.embed?.includes('?') ? '&' : '?'}autoplay=1`}
        title={a.title || a.name}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
      />
    ) : (
      <button className="att-video" onClick={() => setPlaying(true)} title={`Play — loads the player from ${a.provider}`}>
        {a.thumb ? <img src={a.thumb} alt="" loading="lazy" /> : <span className="att-video-blank" />}
        <span className="att-play" aria-hidden="true">
          <Play size={20} fill="currentColor" />
        </span>
        <span className="att-caption">
          {a.title || a.name} <span className="muted">· {a.provider} · loads when played</span>
        </span>
      </button>
    )
  } else if (a.type === 'link') {
    body = (
      <a href={a.href} target="_blank" rel="noopener noreferrer nofollow" className="att-link">
        {a.thumb && <img src={a.thumb} alt="" loading="lazy" />}
        <span className="att-link-text">
          <strong>{a.title || a.name}</strong>
          <span className="muted small">{[a.site, a.author, a.date].filter(Boolean).join(' · ') || hostOf(a.href)}</span>
        </span>
      </a>
    )
  } else if (a.type.startsWith('image/'))
    body = compact ? (
      // Finished cards keep images short; click to see the whole image.
      <button className={`att-img ${big ? 'big' : ''}`} onClick={(e) => (e.stopPropagation(), setBig(!big))} title={big ? 'Show smaller' : 'Show the whole image'}>
        <img src={a.url} alt={a.name} loading="lazy" />
      </button>
    ) : (
      <a href={a.url} target="_blank" rel="noopener" className="att-img">
        <img src={a.url} alt={a.name} loading="lazy" />
      </a>
    )
  else if (a.type.startsWith('audio/')) body = <audio controls preload="metadata" src={a.url} />
  else if (a.type.startsWith('video/')) body = <video controls preload="metadata" src={a.url} />
  else
    body = (
      <a href={a.url} target="_blank" rel="noopener" className="att-file">
        <FileIcon size={14} /> {a.name}
      </a>
    )
  return (
    <div
      className={`att ${drag?.dropClass || ''}`}
      onDragOver={
        drag &&
        ((e) => {
          e.preventDefault()
          drag.onOver()
        })
      }
      onDrop={
        drag &&
        ((e) => {
          e.preventDefault()
          e.stopPropagation()
          drag.onDrop()
        })
      }
    >
      {body}
      {drag && (
        <button
          className="att-grip"
          draggable
          title="Drag to reorder"
          aria-label="Reorder"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', '')
            const el = (e.currentTarget as HTMLElement).parentElement
            if (el) e.dataTransfer.setDragImage(el, 12, 12)
            drag.onStart()
          }}
          onDragEnd={drag.onEnd}
        >
          <GripVertical size={13} />
        </button>
      )}
      {canEdit && (
        <button className="att-remove" onClick={onRemove} title="Remove" aria-label={`Remove ${a.title || a.name}`}>
          <X size={12} />
        </button>
      )}
    </div>
  )
}
