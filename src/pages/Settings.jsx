import { useAuth } from '../contexts/AuthContext'

export default function Settings() {
  const { member, signOut } = useAuth()

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)', marginBottom: '1.25rem' }}>Settings</div>

      {/* Profile */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>Your Profile</div>
        <div style={{ fontSize: '0.88rem', color: 'var(--text)' }}>{member?.display_name || 'No name set'}</div>
        <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{member?.role}</div>
      </div>

      {/* Sign out */}
      <button onClick={signOut} style={{ width: '100%', background: 'transparent', border: '1px solid #c05a40', color: '#c05a40', borderRadius: 'var(--radius)', padding: '0.75rem', fontSize: '0.88rem', marginTop: '0.5rem' }}>
        Sign Out
      </button>
    </div>
  )
}
