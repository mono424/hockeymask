import '@fontsource-variable/inter'
import '@fontsource/ibm-plex-mono/400.css'
import '@hockeymask/react/styles.css'
import './styles.css'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { queryClient } from './lib/query'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
