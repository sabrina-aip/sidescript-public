/**
 * Replies on an annotation. The annotation belongs to its author; everyone else contributes here.
 * A reply can carry its own links, images and files (pasted, dropped or attached), shown under
 * the person who added them. Replies can be edited or deleted by their author (or the document
 * owner); a deleted reply leaves a "Reply deleted" placeholder so the thread still reads.
 */
import { useRef, useState } from 'react'
import { MoreHorizontal, Paperclip, Pencil, RotateCcw, Trash2, X } from 'lucide-react'
import { api, uploadFile, type User } from '../api'
import { Avatar, Menu } from '../components/ui'
import { shortId, timeAgo, toast } from '../util'
import type { Attachment, Reply } from './model'

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi
const MAX_LINKS = 10
const cleanUrl = (u: string) => {
  let s = u.replace(/[.,;:!?'"]+$/, '')
  while (s.endsWith(')') && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = s.slice(0, -1)
  return s
}
const findLinks = (text: string) => [...new Set((text.match(URL_RE) || []).map(cleanUrl).filter((u) => /^https?:\/\/[^/\s]+\.[^/\s]/i.test(u)))]
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}

/** One slot in the composer: a finished attachment, or a link/file still on its way. */
type Slot = { key: string; att?: Attachment; loading?: string; failed?: string; url?: string }

export function ReplyComposer({
  docId,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  docId: string
  initial?: { text: string; attachments?: Attachment[] }
  submitLabel: string
  onSubmit: (text: string, attachments: Attachment[]) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial?.text || '')
  const [slots, setSlots] = useState<Slot[]>(() => (initial?.attachments || []).map((a) => ({ key: a.id, att: a })))
  const fileRef = useRef<HTMLInputElement>(null)
  const setSlot = (key: string, patch: Partial<Slot>) => setSlots((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  const drop = (key: string) => setSlots((ss) => ss.filter((s) => s.key !== key))

  async function fetchLink(key: string, url: string) {
    setSlot(key, { loading: hostOf(url), failed: undefined })
    try {
      const { attachment } = await api<{ attachment: Attachment }>('POST', `/api/docs/${docId}/embed`, { url })
      setSlot(key, { att: attachment, loading: undefined })
    } catch (e: any) {
      setSlot(key, { loading: undefined, failed: e.message || 'Couldn’t embed that link' })
    }
  }
  function addLinks(urls: string[]) {
    const have = new Set(slots.map((s) => s.att?.href || s.url))
    const fresh = urls.filter((u) => !have.has(u)).slice(0, MAX_LINKS)
    const added = fresh.map((url) => ({ key: shortId(), url, loading: hostOf(url) }))
    setSlots((ss) => [...ss, ...added]) // placeholders keep paste order; each fills in when it arrives
    let next = 0
    const worker = async () => {
      while (next < added.length) {
        const s = added[next++]
        await fetchLink(s.key, s.url)
      }
    }
    for (let i = 0; i < Math.min(3, added.length); i++) void worker()
  }
  async function addFiles(files: FileList | File[]) {
    for (const f of files) {
      const key = shortId()
      setSlots((ss) => [...ss, { key, loading: f.name || 'file' }])
      try {
        const { url, size } = await uploadFile(docId, f)
        setSlot(key, { att: { id: shortId(), name: f.name || 'pasted', type: f.type || 'application/octet-stream', url, size }, loading: undefined })
      } catch (e: any) {
        drop(key)
        toast(e.message, 'error')
      }
    }
  }

  const busy = slots.some((s) => s.loading)
  const ready = slots.filter((s) => s.att).map((s) => s.att!)
  const canSend = !busy && (text.trim() || ready.length)
  const submit = () => canSend && onSubmit(text.trim(), ready)

  return (
    <div
      className="reply-composer"
      onClick={(e) => e.stopPropagation()}
      onPaste={(e) => {
        e.stopPropagation() // the annotation itself belongs to its author: pasted links go into this reply
        const files = [...e.clipboardData.files]
        if (files.length) {
          e.preventDefault()
          return void addFiles(files)
        }
        const pasted = e.clipboardData.getData('text/plain')
        const links = findLinks(pasted)
        if (!links.length) return
        if (!pasted.replace(URL_RE, '').trim()) e.preventDefault()
        addLinks(links)
      }}
      onDragOver={(e) => (e.preventDefault(), e.stopPropagation())}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer.files.length) return void addFiles(e.dataTransfer.files)
        addLinks(findLinks(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')))
      }}
    >
      <textarea
        autoFocus
        className="note-text reply-text"
        placeholder="Reply, or paste a link or image…"
        value={text}
        rows={Math.min(6, Math.max(1, text.split('\n').length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      {slots.length > 0 && (
        <div className="attachments compact">
          {slots.map((s) =>
            s.att ? (
              <div key={s.key} className="att">
                <AttachmentLine a={s.att} />
                <button className="att-remove" onClick={() => drop(s.key)} title="Remove" aria-label={`Remove ${s.att.title || s.att.name}`}>
                  <X size={12} />
                </button>
              </div>
            ) : s.failed ? (
              <div key={s.key} className="att-pending failed">
                <span className="att-pending-text">
                  Couldn’t embed <strong>{hostOf(s.url || '')}</strong>
                </span>
                <span className="att-pending-actions">
                  <button className="link-btn" onClick={() => setSlot(s.key, { att: { id: shortId(), type: 'link', name: hostOf(s.url!), href: s.url, title: s.url, site: hostOf(s.url!) }, failed: undefined })}>
                    Keep as plain link
                  </button>
                  <button className="link-btn" onClick={() => void fetchLink(s.key, s.url!)}>
                    <RotateCcw size={12} /> Retry
                  </button>
                  <button className="icon-btn" aria-label="Dismiss" onClick={() => drop(s.key)}>
                    <X size={12} />
                  </button>
                </span>
              </div>
            ) : (
              <div key={s.key} className="att-pending">
                <span className="spinner" aria-hidden="true" /> {s.url ? 'Fetching' : 'Uploading'} {s.loading}…
              </div>
            ),
          )}
        </div>
      )}
      <div className="reply-actions">
        <button className="icon-btn" title="Attach a file" aria-label="Attach a file" onClick={() => fileRef.current?.click()}>
          <Paperclip size={14} />
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <button className="btn small" style={{ marginLeft: 'auto' }} onClick={onCancel}>
          Cancel
        </button>
        <button className="btn small primary" disabled={!canSend} onClick={submit}>
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

/** A compact, read-only line for an attachment in a reply. */
export function AttachmentLine({ a }: { a: Attachment }) {
  if (a.type.startsWith('image/') && a.url)
    return (
      <a href={a.url} target="_blank" rel="noopener" className="att-img">
        <img src={a.url} alt={a.name} loading="lazy" />
      </a>
    )
  const href = a.type === 'link' || a.type === 'video/embed' ? a.href : a.url
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="att-link">
      {a.thumb && <img src={a.thumb} alt="" loading="lazy" />}
      <span className="att-link-text">
        <strong>{a.title || a.name}</strong>
        <span className="muted small">{[a.site || a.provider, a.author, a.date].filter(Boolean).join(' · ') || (href ? hostOf(href) : '')}</span>
      </span>
    </a>
  )
}

export function ReplyList({
  replies,
  me,
  isOwner,
  canEdit,
  docId,
  linkify,
  onEdit,
  onDelete,
}: {
  replies: Reply[]
  me: User
  isOwner: boolean
  canEdit: boolean
  docId: string
  linkify: (text: string) => React.ReactNode
  onEdit: (id: string, text: string, attachments: Attachment[]) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState('')
  return (
    <div className="note-replies">
      {replies.map((m) =>
        m.deleted ? (
          <div key={m.id} className="msg-deleted">
            Reply deleted
          </div>
        ) : (
          <div key={m.id} className="msg">
            <Avatar name={m.authorName} color={m.author === me.username ? me.color : '#64748b'} size={22} />
            <div className="msg-body">
              <div className="msg-head">
                <strong>{m.authorName}</strong>
                <span className="muted small">
                  {timeAgo(m.createdAt)}
                  {m.editedAt ? ' · edited' : ''}
                </span>
                {canEdit && (m.author === me.username || isOwner) && editing !== m.id && (
                  <span className="msg-menu" onClick={(e) => e.stopPropagation()}>
                    <Menu
                      label="Reply options"
                      align="right"
                      trigger={<MoreHorizontal size={14} />}
                      items={[
                        { label: 'Edit', icon: <Pencil size={14} />, onClick: () => setEditing(m.id) },
                        { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => onDelete(m.id) },
                      ]}
                    />
                  </span>
                )}
              </div>
              {editing === m.id ? (
                <ReplyComposer
                  docId={docId}
                  initial={m}
                  submitLabel="Save"
                  onCancel={() => setEditing('')}
                  onSubmit={(text, atts) => {
                    onEdit(m.id, text, atts)
                    setEditing('')
                  }}
                />
              ) : (
                <>
                  {m.text && <div className="msg-text">{linkify(m.text)}</div>}
                  {!!m.attachments?.length && (
                    <div className="attachments compact">
                      {m.attachments.map((a) => (
                        <div key={a.id} className="att">
                          <AttachmentLine a={a} />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ),
      )}
    </div>
  )
}
