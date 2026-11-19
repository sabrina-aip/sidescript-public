import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, FilePlus2, FileText, KeyRound, LogOut, MoreVertical, RotateCcw, Search, Trash2, Upload, UserCog, Users } from 'lucide-react'
import { api, type DocMeta, type User } from '../api'
import { Avatar, Logo, Menu, Modal } from '../components/ui'
import { ColorPicker } from '../components/ColorPicker'
import { ThemePicker } from '../components/ThemePicker'
import { navigate, timeAgo, toast } from '../util'
import { htmlFromImport } from '../editor/convert'

type Tab = 'mine' | 'shared' | 'trash'

export function HomePage({ user, onUserChange, onSignOut }: { user: User; onUserChange: (u: User) => void; onSignOut: () => void }) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [tab, setTab] = useState<Tab>('mine')
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<'account' | 'users' | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => api<{ docs: DocMeta[] }>('GET', '/api/docs').then((r) => setDocs(r.docs))
  useEffect(() => {
    load().catch((e) => toast(e.message, 'error'))
    document.title = 'Sidescript'
  }, [])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (docs || []).filter((d) => {
      if (tab === 'trash' ? !d.trashed : d.trashed) return false
      if (tab === 'mine' && d.role !== 'owner') return false
      if (tab === 'shared' && d.role === 'owner') return false
      return !needle || d.title.toLowerCase().includes(needle)
    })
  }, [docs, tab, q])

  async function create() {
    const r = await api<{ doc: DocMeta }>('POST', '/api/docs', { title: 'Untitled document' })
    navigate(`/d/${r.doc.id}`)
  }

  async function duplicate(d: DocMeta) {
    await api('POST', `/api/docs/${d.id}/duplicate`)
    toast(`Copied “${d.title}”`)
    load()
  }

  async function setTrashed(d: DocMeta, trashed: boolean) {
    await api('PATCH', `/api/docs/${d.id}`, { trashed })
    toast(trashed ? 'Moved to trash. Nothing is deleted — restore it any time.' : 'Restored')
    load()
  }

  async function importFile(file: File) {
    try {
      const text = await file.text()
      const base = file.name.replace(/\.(sidescript\.json|json|html?|md|markdown|txt)$/i, '')
      if (/\.json$/i.test(file.name)) {
        const data = JSON.parse(text)
        if (data?.format !== 'sidescript' || !data.state) throw new Error('Not a Sidescript backup file')
        const r = await api<{ doc: DocMeta }>('POST', '/api/docs', { title: data.title || base, state: data.state })
        navigate(`/d/${r.doc.id}`)
        return
      }
      const html = htmlFromImport(file.name, text)
      const r = await api<{ doc: DocMeta }>('POST', '/api/docs', { title: base })
      sessionStorage.setItem(`sidescript:import:${r.doc.id}`, html)
      navigate(`/d/${r.doc.id}`)
    } catch (e: any) {
      toast(e.message || 'Import failed', 'error')
    }
  }

  async function signOut() {
    await api('POST', '/api/logout')
    onSignOut()
  }

  return (
    <div className="home">
      <header className="home-top">
        <Logo />
        <div className="search">
          <Search size={16} />
          <input placeholder="Search documents" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" />
        </div>
        <Menu
          label="Account"
          align="right"
          trigger={<Avatar name={user.displayName} color={user.color} size={32} />}
          items={[
            { label: user.displayName, hint: `@${user.username}`, disabled: true },
            { separator: true, label: '' },
            { label: 'Account settings', icon: <UserCog size={16} />, onClick: () => setDialog('account') },
            ...(user.isAdmin ? [{ label: 'Manage users', icon: <Users size={16} />, onClick: () => setDialog('users') }] : []),
            { label: 'Sign out', icon: <LogOut size={16} />, onClick: signOut },
          ]}
        />
      </header>

      <main className="home-main">
        <div className="home-actions">
          <button className="btn primary" onClick={create}>
            <FilePlus2 size={16} /> New document
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Upload size={16} /> Import
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".json,.html,.htm,.md,.markdown,.txt"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) importFile(f)
            }}
          />
        </div>

        <nav className="tabs" role="tablist">
          {(['mine', 'shared', 'trash'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'mine' ? 'My documents' : t === 'shared' ? 'Shared with me' : 'Trash'}
            </button>
          ))}
        </nav>

        {tab === 'trash' && <p className="muted small">Documents in the trash are kept on the server indefinitely. Nothing here is ever erased by the app.</p>}

        {!docs ? (
          <p className="muted">Loading…</p>
        ) : shown.length === 0 ? (
          <div className="empty-state">
            <FileText size={32} />
            <p>{q ? 'No documents match.' : tab === 'mine' ? 'No documents yet. Create one to get started.' : tab === 'shared' ? 'Nothing has been shared with you yet.' : 'Trash is empty.'}</p>
          </div>
        ) : (
          <ul className="doc-list">
            {shown.map((d) => (
              <li key={d.id} className="doc-row">
                <button className="doc-open" onClick={() => navigate(`/d/${d.id}`)}>
                  <FileText size={20} className="doc-icon" />
                  <span className="doc-title">{d.title || 'Untitled document'}</span>
                  <span className="doc-sub muted small">
                    {d.role === 'owner' ? (Object.keys(d.shares || {}).length ? `Shared with ${Object.keys(d.shares || {}).length}` : 'Only you') : `${d.ownerName} · ${d.role}`}
                  </span>
                  <span className="doc-time muted small">{timeAgo(d.updatedAt)}</span>
                </button>
                <Menu
                  label="Document actions"
                  align="right"
                  trigger={<MoreVertical size={18} />}
                  items={[
                    { label: 'Duplicate', icon: <Copy size={16} />, onClick: () => duplicate(d) },
                    ...(d.role === 'owner'
                      ? d.trashed
                        ? [{ label: 'Restore', icon: <RotateCcw size={16} />, onClick: () => setTrashed(d, false) }]
                        : [{ label: 'Move to trash', icon: <Trash2 size={16} />, onClick: () => setTrashed(d, true), danger: true }]
                      : []),
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </main>

      {dialog === 'account' && <AccountDialog user={user} onClose={() => setDialog(null)} onUserChange={onUserChange} />}
      {dialog === 'users' && <UsersDialog me={user} onClose={() => setDialog(null)} />}
    </div>
  )
}

function AccountDialog({ user, onClose, onUserChange }: { user: User; onClose: () => void; onUserChange: (u: User) => void }) {
  const [displayName, setDisplayName] = useState(user.displayName)
  const [color, setColor] = useState(user.color)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')

  async function saveProfile() {
    const r = await api<{ user: User }>('PATCH', '/api/me', { displayName, color })
    onUserChange(r.user)
    toast('Profile saved')
  }
  async function changePassword() {
    try {
      await api('POST', '/api/me/password', { current, next })
      setCurrent('')
      setNext('')
      toast('Password changed. Other devices were signed out.')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <Modal title="Account settings" onClose={onClose}>
      <div className="form-grid">
        <label>
          Display name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          Cursor colour
          <ColorPicker value={color} onChange={setColor} label="Cursor colour" />
        </label>
        <button className="btn" onClick={saveProfile}>
          Save profile
        </button>
      </div>
      <h3 className="section-title">Theme</h3>
      <p className="muted small">Just for you, on every device. Collaborators keep their own.</p>
      <ThemePicker />
      <h3 className="section-title">
        <KeyRound size={16} /> Change password
      </h3>
      <div className="form-grid">
        <label>
          Current password
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label>
          New password (10+ characters)
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <button className="btn" onClick={changePassword} disabled={!current || next.length < 10}>
          Change password
        </button>
      </div>
    </Modal>
  )
}

function UsersDialog({ me, onClose }: { me: User; onClose: () => void }) {
  const [users, setUsers] = useState<User[]>([])
  const [form, setForm] = useState({ username: '', displayName: '', password: '', isAdmin: false })
  const load = () => api<{ users: User[] }>('GET', '/api/users').then((r) => setUsers(r.users))
  useEffect(() => {
    load()
  }, [])

  async function add() {
    try {
      await api('POST', '/api/users', form)
      toast(`Created ${form.username}. Share the password with them privately.`)
      setForm({ username: '', displayName: '', password: '', isAdmin: false })
      load()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  async function patch(u: User, body: object, msg: string) {
    try {
      await api('PATCH', `/api/users/${u.username}`, body)
      toast(msg)
      load()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <Modal title="Manage users" onClose={onClose} wide>
      <p className="muted small">Collaborators need an account on this server. Accounts are never deleted (so document history stays attributable) — disable them instead.</p>
      <ul className="user-list">
        {users.map((u) => (
          <li key={u.username}>
            <Avatar name={u.displayName} color={u.color} />
            <span>
              <strong>{u.displayName}</strong> <span className="muted">@{u.username}</span> {u.isAdmin && <span className="pill">admin</span>} {u.disabled && <span className="pill warn">disabled</span>}
            </span>
            {u.username !== me.username && (
              <span className="row-actions">
                <button
                  className="btn small"
                  onClick={() => {
                    const pw = prompt(`New password for ${u.username} (10+ characters):`)
                    if (pw) patch(u, { password: pw }, 'Password reset')
                  }}
                >
                  Reset password
                </button>
                <button className="btn small" onClick={() => patch(u, { disabled: !u.disabled }, u.disabled ? 'Enabled' : 'Disabled')}>
                  {u.disabled ? 'Enable' : 'Disable'}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <h3 className="section-title">Add a user</h3>
      <div className="form-row">
        <input placeholder="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} />
        <input placeholder="Display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        <input placeholder="Temporary password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <label className="check">
          <input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} /> Admin
        </label>
        <button className="btn primary" onClick={add} disabled={!form.username || form.password.length < 10}>
          Add
        </button>
      </div>
    </Modal>
  )
}
