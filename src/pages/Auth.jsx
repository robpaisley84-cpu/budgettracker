import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export default function Auth() {
  const { signIn, signInWithGoogle } = useAuth()
  const [email, setEmail]     = useState('')
  const [password, setPass]   = useState('')
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const { error } = await signIn(email, password)
      if (error) setError(error.message)
    } finally { setLoading(false) }
  }

  async function google() {
    setError('')
    const { error } = await signInWithGoogle()
    if (error) setError(error.message)
    // on success the browser redirects to Google, then back
  }

  const s = {
    wrap:    { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem', background: 'linear-gradient(160deg, var(--bgAlt), var(--card))' },
    card:    { width: '100%', maxWidth: '380px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', overflow: 'hidden' },
    head:    { background: 'linear-gradient(135deg, var(--bgAlt), var(--bg))', padding: '1.75rem 1.5rem 1.5rem', borderBottom: '2px solid var(--accent)' },
    eyebrow: { fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--accent)', textTransform: 'uppercase', marginBottom: '0.35rem' },
    title:   { fontFamily: 'var(--font-display)', fontSize: '1.6rem', fontWeight: 400, color: 'var(--accentL)', letterSpacing: '-0.01em' },
    body:    { padding: '1.5rem' },
    label:   { display: 'block', fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.1em' },
    input:   { width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.65rem 0.85rem', color: 'var(--text)', fontSize: '0.9rem', marginBottom: '0.85rem', outline: 'none' },
    btn:     { width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem', marginTop: '0.25rem' },
    error:   { background: 'var(--dangerBg)', border: '1px solid var(--red)', borderRadius: '6px', padding: '0.6rem 0.8rem', color: 'var(--redL)', fontSize: '0.8rem', marginBottom: '0.75rem' },
  }

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <div style={s.head}>
          <div style={s.eyebrow}>Paisley Family</div>
          <div style={s.title}>Road Budget</div>
        </div>
        <div style={s.body}>
          {error && <div style={s.error}>{error}</div>}

          <form onSubmit={submit}>
            <label style={s.label}>Email</label>
            <input style={s.input} type="email" value={email} onChange={e=>setEmail(e.target.value)} required placeholder="you@email.com" />
            <label style={s.label}>Password</label>
            <input style={s.input} type="password" value={password} onChange={e=>setPass(e.target.value)} required placeholder="â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢" />

            <button style={s.btn} disabled={loading}>
              {loading ? 'Just a momentâ€¦' : 'Sign In'}
            </button>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', margin: '1.1rem 0 0.9rem' }}>
            <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
            <span style={{ fontSize: '0.68rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>or</span>
            <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
          </div>

          <button type="button" onClick={google}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem', background: '#fff', border: 'none', borderRadius: '8px', padding: '0.75rem', color: '#1f1f1f', fontWeight: 600, fontSize: '0.88rem', cursor: 'pointer' }}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Continue with Google
          </button>
        </div>
      </div>
    </div>
  )
}
