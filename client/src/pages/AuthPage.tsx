import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { Logo } from '../components/ui'

export function AuthPage({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [setupCode, setSetupCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (setup && password !== confirm) return setError("Passwords don't match")
    setBusy(true)
    try {
      if (setup) await api('POST', '/api/setup', { setupCode, username, password, displayName })
      else await api('POST', '/api/login', { username, password })
      onDone()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <Logo />
        <h1>{setup ? 'Set up your server' : 'Sign in'}</h1>
        <p className="muted small">
          {setup
            ? 'Create the administrator account. Your documents are stored only on this server.'
            : 'Your documents live on this server only. Nothing is sent to third parties.'}
        </p>
        {setup && (
          <label>
            Setup code
            <input autoFocus autoComplete="off" spellCheck={false} value={setupCode} onChange={(e) => setSetupCode(e.target.value)} placeholder="Printed in the server log" required />
          </label>
        )}
        <label>
          Username
          <input autoFocus={!setup} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        {setup && (
          <label>
            Display name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Shown to collaborators" />
          </label>
        )}
        <label>
          Password
          <input type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={setup ? 10 : undefined} />
        </label>
        {setup && (
          <label>
            Confirm password
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
