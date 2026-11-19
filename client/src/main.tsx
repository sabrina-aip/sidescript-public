import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { initTheme } from './theme'
import { initDisplayPrefs } from './displayPrefs'

// iPhone/iPad Safari zooms in whenever you tap a text box whose text is under 16px (note, reply
// and script text included). maximum-scale=1 stops that; iOS still allows pinch zoom with it.
// iOS only: on Android the same setting would block pinch zoom.
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
if (iOS) document.querySelector('meta[name=viewport]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')

initTheme()
initDisplayPrefs()

createRoot(document.getElementById('root')!).render(<App />)
