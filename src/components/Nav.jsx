import { NavLink } from 'react-router-dom'

const TABS = [
  { to: '/',             icon: '📊', label: 'Dashboard' },
  { to: '/budget',       icon: '📋', label: 'Budget'    },
  { to: '/bills',        icon: '🗓️', label: 'Bills'     },
  { to: '/accounts',     icon: '🏦', label: 'Accounts'  },
  { to: '/transactions', icon: '💸', label: 'Log'       },
  { to: '/allocations',  icon: '📅', label: 'Paycheck'  },
]

export default function Nav() {
  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40,
      background: 'var(--nav)',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      maxWidth: '600px', margin: '0 auto',
      paddingBottom: 'env(safe-area-inset-bottom, 0)',
    }}>
      {TABS.map(t => (
        <NavLink key={t.to} to={t.to} end={t.to==='/'} style={({ isActive }) => ({
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '0.55rem 0 0.5rem', textDecoration: 'none', gap: '0.15rem',
          color: isActive ? 'var(--accent)' : 'var(--muted)',
          borderTop: isActive ? '2px solid var(--accent)' : '2px solid transparent',
          transition: 'color 0.15s',
        })}>
          <span style={{ fontSize: '1.15rem' }}>{t.icon}</span>
          <span style={{ fontSize: '0.6rem', letterSpacing: '0.05em' }}>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
