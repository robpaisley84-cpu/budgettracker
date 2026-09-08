// Colour scheme, stored per device.
//
// Both palettes live in index.css; this only decides which one is active by
// stamping data-theme on <html>. It is a per-device preference rather than a
// household setting, so Rob and Hayley can each pick their own without one
// overriding the other — and it needs no database column.

const KEY = 'roadbudget-theme'

export const THEMES = [
  { k: 'dark',  label: 'Avalanche',     hint: 'Truck grey — easier at night' },
  { k: 'light', label: 'Coastal Linen', hint: 'Camper interior — bright' },
]

export function getTheme() {
  // Private windows and blocked site data both throw on access, so the
  // default has to survive localStorage being unavailable entirely.
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark'
  document.documentElement.dataset.theme = t
  try { localStorage.setItem(KEY, t) } catch { /* preference just won't persist */ }
  return t
}
