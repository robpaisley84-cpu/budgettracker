import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Auto-clear stale sessions on new deployments
const APP_VERSION = __APP_VERSION__
const storedVersion = localStorage.getItem('rv-budget-version')
if (storedVersion && storedVersion !== APP_VERSION) {
  // New deployment detected — clear old auth session
  localStorage.clear()
  sessionStorage.clear()
  console.log(`Updated: ${storedVersion} → ${APP_VERSION}`)
}
localStorage.setItem('rv-budget-version', APP_VERSION)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
