import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import { useAuthStore } from '@/data/store'
import { App } from './App'

// After a deploy, an open tab may request chunks that no longer exist: reload once to pick up
// the new build. The timestamp guard prevents a reload loop if the chunk is genuinely broken.
const RELOAD_KEY = 'cairn:preload-reload-at'
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < 10_000) return // already reloaded just now: let the error surface
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    // sessionStorage unavailable: still reload (at worst once per failing navigation)
  }
  event.preventDefault()
  window.location.reload()
})

// Restore the session (Supabase) / sign in the local user; loads the workspace when signed in.
void useAuthStore.getState().actions.init()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
