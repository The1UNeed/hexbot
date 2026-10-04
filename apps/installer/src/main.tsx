import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import type { InstallerApi } from './api'
import { tauriApi } from './api'
import { App } from './App'

async function pickApi(): Promise<InstallerApi> {
  // `pnpm dev` in a plain browser previews the screens against a fake engine.
  if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
    const { previewApi } = await import('./dev/preview')

    return previewApi(new URLSearchParams(location.search))
  }

  return tauriApi
}

void pickApi().then(api =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>
  )
)
