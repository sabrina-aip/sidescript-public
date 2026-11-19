import { lazy, Suspense, useEffect, useState } from 'react'
import { api, type User } from './api'
import { dismissToast, usePath, useToasts } from './util'
import { AuthPage } from './pages/AuthPage'
import { HomePage } from './pages/HomePage'
import { loadThemeFromAccount } from './theme'
import { loadDisplayFromAccount } from './displayPrefs'
// The editor (TipTap + Yjs) is the heavy part; load it only when a document is opened.
const EditorPage = lazy(() => import('./pages/EditorPage').then((m) => ({ default: m.EditorPage })))

export function App() {
  const [state, setState] = useState<{ loading: boolean; needsSetup: boolean; user: User | null }>({ loading: true, needsSetup: false, user: null })
  const path = usePath()

  const refresh = () =>
    api<{ needsSetup: boolean; user: User | null }>('GET', '/api/status')
      .then((s) => setState({ loading: false, ...s }))
      .catch(() => setState((s) => ({ ...s, loading: false })))

  useEffect(() => {
    refresh()
    const out = () => setState((s) => ({ ...s, user: null }))
    window.addEventListener('sidescript:signed-out', out)
    // Your theme is saved with your account, so it follows you between devices.
    return () => window.removeEventListener('sidescript:signed-out', out)
  }, [])

  useEffect(() => {
    if (state.user) api<{ prefs: { theme?: string; display?: unknown } }>('GET', '/api/me/prefs').then((r) => (loadThemeFromAccount(r.prefs), loadDisplayFromAccount(r.prefs))).catch(() => {})
  }, [state.user?.username]) // eslint-disable-line react-hooks/exhaustive-deps

  if (state.loading) return <div className="center-screen muted">Loading…</div>

  let page
  if (!state.user) page = <AuthPage setup={state.needsSetup} onDone={refresh} />
  else {
    const m = /^\/d\/([a-f0-9-]{36})/.exec(path)
    page = m ? (
      <Suspense fallback={<div className="center-screen muted">Opening…</div>}>
        <EditorPage key={m[1]} docId={m[1]} user={state.user} />
      </Suspense>
    ) : (
      <HomePage user={state.user} onUserChange={(user) => setState((s) => ({ ...s, user }))} onSignOut={refresh} />
    )
  }
  return (
    <>
      {page}
      <Toasts />
    </>
  )
}

function Toasts() {
  const toasts = useToasts()
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone || ''}`}>
          {t.text}
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                dismissToast(t.id)
                t.action!.run()
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
