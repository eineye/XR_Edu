import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { STATIC_DEMO } from './api'

if (STATIC_DEMO) import('./mock/sim').then((m) => m.startSimulator())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
