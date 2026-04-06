import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export default function Settings() {
  const { household, member, signOut } = useAuth()
  const [copied, setCopied] = useState(false)

  function copyHouseholdId() {
    navigator.clipboard.writeText(household?.id || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)', marginBottom: '1.25rem' }}>Settings</div>

      {/* Profile */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>Your Profile</div>
        <div style={{ fontSize: '0.88rem', color: 'var(--text)' }}>{member?.display_name || 'No name set'}</div>
        <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{member?.role}</div>
      </div>

      {/* Share household */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>Share Household</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.6rem', lineHeight: 1.5 }}>Share this ID with Hayley so she can join on the Sign In screen using "Join Family"</div>
        <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem 0.75rem', fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--accentL)', wordBreak: 'break-all', marginBottom: '0.6rem' }}>{household?.id}</div>
        <button onClick={copyHouseholdId} style={{ background: copied ? 'var(--green)' : 'var(--accent)', border: 'none', borderRadius: '6px', padding: '0.45rem 0.85rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.78rem' }}>
          {copied ? '✓ Copied!' : 'Copy Household ID'}
        </button>
      </div>

      {/* Sign out */}
      <button onClick={signOut} style={{ width: '100%', background: 'transparent', border: '1px solid #c05a40', color: '#c05a40', borderRadius: 'var(--radius)', padding: '0.75rem', fontSize: '0.88rem', marginTop: '0.5rem' }}>
        Sign Out
      </button>
    </div>
  )
}
