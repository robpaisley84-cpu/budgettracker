// Colour scheme, stored per device.
//
// Palettes live in index.css; this only decides which is active by stamping
// data-theme on <html>. It is a per-device preference rather than a household
// setting, so Rob and Hayley can each pick their own without one overriding
// the other — and it needs no database column.

const KEY = 'roadbudget-theme'

export const THEMES = [
  { k: 'avalanche', label: 'Avalanche',     hint: 'Truck paint — light warm grey' },
  { k: 'linen',     label: 'Coastal Linen', hint: 'Camper interior — warm cream' },
  { k: 'night',     label: 'Night',         hint: 'Dark, for evenings' },
]

const VALID = THEMES.map(t => t.k)
const DEFAULT = 'avalanche'

// The first release shipped 'dark' (a charcoal theme wrongly called Avalanche)
// and 'light' (Coastal Linen). Map those forward so an existing choice keeps
// working instead of silently falling back to the default.
const LEGACY = { dark: 'night', light: 'linen' }

function normalise(v) {
  if (!v) return DEFAULT
  if (VALID.includes(v)) return v
  return LEGACY[v] || DEFAULT
}

export function getTheme() {
  // Private windows and blocked site data both throw on access, so the
  // default has to survive localStorage being unavailable entirely.
  try {
    return normalise(localStorage.getItem(KEY))
  } catch {
    return DEFAULT
  }
}

export function applyTheme(theme) {
  const t = normalise(theme)
  document.documentElement.dataset.theme = t
  try { localStorage.setItem(KEY, t) } catch { /* preference just won't persist */ }
  return t
}
