import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './index.css'
import { queryClient } from './lib/chain'
import { WalletBoundary } from './wallet'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Failed to find the root element')

// `Buffer` is provided by `/src/polyfills.ts` — a separate tag in `index.html` before this
// module. Order matters: the SDK derives PDAs at module load.
createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WalletBoundary>
        <App />
      </WalletBoundary>
    </QueryClientProvider>
  </StrictMode>,
)
