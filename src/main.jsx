import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { getTheme, applyTheme } from './lib/theme'

// Auto-clear stale sessions on new deployments
const APP_VERSION = __APP_VERSION__
const storedVersion = localStorage.getItem('rv-budget-version')
// Read the colour choice before the clear below wipes it, then write it back —
// otherwise every deployment would silently reset the theme.
const chosenTheme = getTheme()
if (storedVersion && storedVersion !== APP_VERSION) {
  // New deployment detected — clear old auth session
  localStorage.clear()
  sessionStorage.clear()
  console.log(`Updated: ${storedVersion} → ${APP_VERSION}`)
}
localStorage.setItem('rv-budget-version', APP_VERSION)

// Stamp the theme before first paint so there's no flash of the other palette
applyTheme(chosenTheme)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
