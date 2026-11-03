import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import { installPreloadRecovery } from '@/app/preloadRecovery'
import { useAuthStore } from '@/data/store'
import { App } from './App'

// After a deploy, an open tab may request chunks that no longer exist: reload once (guarded
// against loops) to pick up the new build.
installPreloadRecovery()

// Restore the session (Supabase) / sign in the local user; loads the workspace when signed in.
void useAuthStore.getState().actions.init()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
