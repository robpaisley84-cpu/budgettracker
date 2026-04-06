import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export default function Auth() {
  const { signIn } = useAuth()
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

  const s = {
    wrap:    { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem', background: 'linear-gradient(160deg, #0a1a0c, #152018)' },
    card:    { width: '100%', maxWidth: '380px', background: '#152018', border: '1px solid #243028', borderRadius: '14px', overflow: 'hidden' },
    head:    { background: 'linear-gradient(135deg, #0a1a0c, #1a2a10)', padding: '1.75rem 1.5rem 1.5rem', borderBottom: '2px solid #c8a050' },
    eyebrow: { fontSize: '0.65rem', letterSpacing: '0.2em', color: '#c8a050', textTransform: 'uppercase', marginBottom: '0.35rem' },
    title:   { fontFamily: 'var(--font-display)', fontSize: '1.6rem', fontWeight: 400, color: '#e8c070', letterSpacing: '-0.01em' },
    body:    { padding: '1.5rem' },
    label:   { display: 'block', fontSize: '0.72rem', color: '#6a8a70', marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.1em' },
    input:   { width: '100%', background: '#0d1a10', border: '1px solid #243028', borderRadius: '7px', padding: '0.65rem 0.85rem', color: '#dde8d8', fontSize: '0.9rem', marginBottom: '0.85rem', outline: 'none' },
    btn:     { width: '100%', background: '#c8a050', border: 'none', borderRadius: '8px', padding: '0.8rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.9rem', marginTop: '0.25rem' },
    error:   { background: '#2a1010', border: '1px solid #c05a40', borderRadius: '6px', padding: '0.6rem 0.8rem', color: '#e07060', fontSize: '0.8rem', marginBottom: '0.75rem' },
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
            <input style={s.input} type="password" value={password} onChange={e=>setPass(e.target.value)} required placeholder="••••••••" />

            <button style={s.btn} disabled={loading}>
              {loading ? 'Just a moment…' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
