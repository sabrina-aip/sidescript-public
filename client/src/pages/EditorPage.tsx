import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { api, type DocMeta, type User } from '../api'
import { PROTOCOL_VERSION, SyncProvider } from '../collab/provider'
import { DocEditor } from '../editor/DocEditor'
import { navigate } from '../util'

export function EditorPage({ docId, user }: { docId: string; user: User }) {
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [error, setError] = useState('')
  const [session, setSession] = useState<{ ydoc: Y.Doc; provider: SyncProvider } | null>(null)

  useEffect(() => {
    api<{ doc: DocMeta }>('GET', `/api/docs/${docId}`)
      .then((r) => setMeta(r.doc))
      .catch((e) => setError(e.message))
  }, [docId])

  useEffect(() => {
    if (!meta) return
    const ydoc = new Y.Doc()
    // Local copy in this browser: survives refreshes and server outages, and
    // syncs back to the server automatically on reconnect.
    const local = new IndexeddbPersistence(`sidescript:${user.username}:${docId}`, ydoc)
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const provider = new SyncProvider(`${proto}://${location.host}/ws/${docId}?v=${PROTOCOL_VERSION}`, ydoc)
    setSession({ ydoc, provider })
    return () => {
      provider.destroy()
      local.destroy()
      ydoc.destroy()
      setSession(null)
    }
    // Reconnect only when the document or our role changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, meta?.role, user.username])

  if (error)
    return (
      <div className="center-screen">
        <p>{error}</p>
        <button className="btn" onClick={() => navigate('/')}>
          Back to documents
        </button>
      </div>
    )
  if (!meta || !session) return <div className="center-screen muted">Opening…</div>
  return <DocEditor key={session.ydoc.guid} docId={docId} meta={meta} setMeta={setMeta} user={user} ydoc={session.ydoc} provider={session.provider} />
}
