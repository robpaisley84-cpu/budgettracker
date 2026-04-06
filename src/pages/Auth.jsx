import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export default function Auth() {
  const { signIn, signUp, joinHousehold, user } = useAuth()
  const [mode, setMode]       = useState('login')   // login | signup | join
  const [email, setEmail]     = useState('')
  const [password, setPass]   = useState('')
  const [name, setName]       = useState('')
  const [invite, setInvite]   = useState('')
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      if (mode === 'login') {
        const { error } = await signIn(email, password)
        if (error) setError(error.message)
      } else if (mode === 'signup') {
        const { error } = await signUp(email, password, name)
        if (error) setError(error.message)
      } else {
        const { error } = await joinHousehold(invite, name)
        if (error) setError(typeof error === 'string' ? error : error.message)
      }
    } finally { setLoading(false) }
  }

  const s = {
    wrap:    { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem', background: 'linear-gradient(160deg, #0a1a0c, #152018)' },
    card:    { width: '100%', maxWidth: '380px', background: '#152018', border: '1px solid #243028', borderRadius: '14px', overflow: 'hidden' },
    head:    { background: 'linear-gradient(135deg, #0a1a0c, #1a2a10)', padding: '1.75rem 1.5rem 1.5rem', borderBottom: '2px solid #c8a050' },
    eyebrow: { fontSize: '0.65rem', letterSpacing: '0.2em', color: '#c8a050', textTransform: 'uppercase', marginBottom: '0.35rem' },
    title:   { fontFamily: 'var(--font-display)', fontSize: '1.6rem', fontWeight: 400, color: '#e8c070', letterSpacing: '-0.01em' },
    body:    { padding: '1.5rem' },
    tabs:    { display: 'flex', gap: '0.4rem', marginBottom: '1.25rem' },
    tab:     (active) => ({ flex: 1, background: active ? '#c8a050' : 'transparent', color: active ? '#0d1a10' : '#6a8a70', border: `1px solid ${active ? '#c8a050' : '#243028'}`, borderRadius: '6px', padding: '0.4rem', fontSize: '0.78rem', fontWeight: active ? 700 : 400 }),
    label:   { display: 'block', fontSize: '0.72rem', color: '#6a8a70', marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.1em' },
    input:   { width: '100%', background: '#0d1a10', border: '1px solid #243028', borderRadius: '7px', padding: '0.65rem 0.85rem', color: '#dde8d8', fontSize: '0.9rem', marginBottom: '0.85rem', outline: 'none' },
    btn:     { width: '100%', background: '#c8a050', border: 'none', borderRadius: '8px', padding: '0.8rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.9rem', marginTop: '0.25rem' },
    error:   { background: '#2a1010', border: '1px solid #c05a40', borderRadius: '6px', padding: '0.6rem 0.8rem', color: '#e07060', fontSize: '0.8rem', marginBottom: '0.75rem' },
    sub:     { fontSize: '0.72rem', color: '#6a8a70', textAlign: 'center', marginTop: '1rem', lineHeight: 1.6 },
  }

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <div style={s.head}>
          <div style={s.eyebrow}>Full-Time RV Family</div>
          <div style={s.title}>Road Budget</div>
        </div>
        <div style={s.body}>
          <div style={s.tabs}>
            {[['login','Sign In'],['signup','Create Account'],['join','Join Family']].map(([m,l]) => (
              <button key={m} style={s.tab(mode===m)} onClick={() => { setMode(m); setError('') }}>{l}</button>
            ))}
          </div>

          {error && <div style={s.error}>{error}</div>}

          <form onSubmit={submit}>
            {mode !== 'join' && <>
              <label style={s.label}>Email</label>
              <input style={s.input} type="email" value={email} onChange={e=>setEmail(e.target.value)} required placeholder="you@email.com" />
              <label style={s.label}>Password</label>
              <input style={s.input} type="password" value={password} onChange={e=>setPass(e.target.value)} required placeholder="••••••••" />
            </>}

            {mode !== 'login' && <>
              <label style={s.label}>{mode === 'join' ? 'Your Name' : 'Your Name'}</label>
              <input style={s.input} value={name} onChange={e=>setName(e.target.value)} required placeholder="Rob or Hayley" />
            </>}

            {mode === 'join' && <>
              <label style={s.label}>Household ID</label>
              <input style={s.input} value={invite} onChange={e=>setInvite(e.target.value)} required placeholder="Paste the household UUID from Rob's account" />
              <div style={{ fontSize: '0.72rem', color: '#6a8a70', marginBottom: '0.85rem', lineHeight: 1.5 }}>
                Rob: find your Household ID in Settings → Share Household
              </div>
            </>}

            <button style={s.btn} disabled={loading}>
              {loading ? 'Just a moment…' : mode === 'login' ? 'Sign In' : mode === 'signup' ? 'Create Account' : 'Join Household'}
            </button>
          </form>

          {mode === 'signup' && (
            <p style={s.sub}>Creates your household and seeds it with your full budget. Share the Household ID from Settings so Hayley can join.</p>
          )}
        </div>
      </div>
    </div>
  )
}
