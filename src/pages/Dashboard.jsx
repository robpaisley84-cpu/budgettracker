import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, startOfMonth, endOfMonth } from 'date-fns'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()
const NET_MO = 8424

export default function Dashboard() {
  const { household } = useAuth()
  const [accounts, setAccounts]       = useState([])
  const [summary, setSummary]         = useState({ budgeted: 0, spent: 0 })
  const [recent, setRecent]           = useState([])
  const [loading, setLoading]         = useState(true)
  const month = format(new Date(), 'yyyy-MM')

  useEffect(() => { if (household) load() }, [household])

  async function load() {
    const [{ data: accs }, { data: txns }] = await Promise.all([
      supabase.from('accounts').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('transactions').select('*, budget_item:budget_items(name), account:accounts(name)').eq('household_id', household.id).eq('budget_month', month).order('created_at', { ascending: false }).limit(8),
    ])
    const { data: items } = await supabase.from('budget_items').select('budgeted_amount').eq('household_id', household.id).eq('is_active', true)
    const budgeted = items?.reduce((s, i) => s + +i.budgeted_amount, 0) || 0
    const spent    = txns?.filter(t => t.type === 'expense').reduce((s, t) => s + +t.amount, 0) || 0
    setAccounts(accs || [])
    setSummary({ budgeted, spent })
    setRecent(txns || [])
    setLoading(false)
  }

  const buffer = NET_MO - summary.spent
  const bufColor = buffer >= 1000 ? 'var(--green)' : buffer >= 0 ? 'var(--amber)' : 'var(--red)'

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '1.1rem' }}>
        <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--accent)', textTransform: 'uppercase' }}>Road Budget</div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)' }}>{format(new Date(), 'MMMM yyyy')}</h1>
      </div>

      {/* Key metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '1rem' }}>
        {[
          { l: 'Monthly Income', v: fmt(NET_MO), c: 'var(--green)' },
          { l: 'Spent This Month', v: fmt(summary.spent), c: 'var(--accentL)' },
          { l: 'Budget', v: fmt(summary.budgeted), c: 'var(--muted)' },
          { l: 'Remaining', v: fmt(buffer), c: bufColor },
        ].map(x => (
          <div key={x.l} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.85rem' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.25rem' }}>{x.l}</div>
            <div style={{ fontSize: '1.25rem', fontFamily: 'var(--font-mono)', fontWeight: 500, color: x.c }}>{x.v}</div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.85rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>
          <span>Monthly spending progress</span>
          <span style={{ color: bufColor }}>{Math.round((summary.spent/NET_MO)*100)}% of income used</span>
        </div>
        <div style={{ background: 'var(--border)', borderRadius: '4px', height: '8px', overflow: 'hidden' }}>
          <div style={{ width: `${Math.min((summary.spent/NET_MO)*100, 100)}%`, height: '100%', background: bufColor, borderRadius: '4px', transition: 'width 0.4s' }} />
        </div>
      </div>

      {/* Account balances */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Accounts</h2>
          <Link to="/accounts" style={{ fontSize: '0.72rem', color: 'var(--accent)', textDecoration: 'none' }}>Manage →</Link>
        </div>
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {accounts.map(a => (
            <div key={a.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.75rem 0.9rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <span style={{ fontSize: '1.1rem' }}>{a.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.82rem', color: 'var(--text)' }}>{a.name}</div>
                {a.target_balance && <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>Target: {fmt(a.target_balance)}</div>}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.95rem', fontWeight: 500, color: a.color || 'var(--accentL)' }}>{fmt(a.balance)}</div>
            </div>
          ))}
          {accounts.length === 0 && (
            <div style={{ fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center', padding: '1rem' }}>
              No accounts yet — <Link to="/accounts" style={{ color: 'var(--accent)' }}>add one</Link>
            </div>
          )}
        </div>
      </div>

      {/* Recent transactions */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Recent</h2>
          <Link to="/transactions" style={{ fontSize: '0.72rem', color: 'var(--accent)', textDecoration: 'none' }}>All →</Link>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {recent.length === 0 && (
            <div style={{ fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center', padding: '1.5rem' }}>
              No transactions this month — <Link to="/transactions" style={{ color: 'var(--accent)' }}>log one</Link>
            </div>
          )}
          {recent.map((t, i) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', padding: '0.65rem 0.9rem', borderBottom: i < recent.length-1 ? '1px solid var(--border)' : 'none', gap: '0.6rem' }}>
              <span style={{ fontSize: '0.85rem' }}>{t.type === 'transfer' ? '↔️' : t.type === 'allocation' ? '📅' : t.type === 'income' ? '💵' : '💸'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.82rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description || t.budget_item?.name || t.account?.name || '—'}</div>
                <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>{format(new Date(t.date), 'MMM d')} · {t.type}</div>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.88rem', color: t.type === 'expense' ? 'var(--red)' : 'var(--green)', flexShrink: 0 }}>
                {t.type === 'expense' ? '-' : '+'}{fmt(t.amount)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
