import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format } from 'date-fns'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()
const NET_MO = 8424

export default function Dashboard() {
  const { household } = useAuth()
  const [accounts, setAccounts]       = useState([])
  const [funds, setFunds]             = useState([])
  const [summary, setSummary]         = useState({ budgeted: 0, spent: 0 })
  const [recent, setRecent]           = useState([])
  const [loading, setLoading]         = useState(true)
  const [showAll, setShowAll]         = useState(false)
  const month = format(new Date(), 'yyyy-MM')

  useEffect(() => { if (household) load() }, [household])

  async function load() {
    const [{ data: accs }, { data: txns }, { data: items }] = await Promise.all([
      supabase.from('accounts').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('transactions').select('*, budget_item:budget_items(name), account:accounts(name)').eq('household_id', household.id).eq('budget_month', month).order('created_at', { ascending: false }).limit(8),
      supabase.from('budget_items').select('id, name, budgeted_amount, category:budget_categories(name, icon, color)').eq('household_id', household.id).eq('is_active', true),
    ])

    // Build actuals map from all expense transactions this month
    const { data: allTxns } = await supabase
      .from('transactions')
      .select('budget_item_id, amount')
      .eq('household_id', household.id)
      .eq('budget_month', month)
      .eq('type', 'expense')

    const actualsMap = {}
    allTxns?.forEach(t => { actualsMap[t.budget_item_id] = (actualsMap[t.budget_item_id] || 0) + +t.amount })

    // Build funds list: each budget item with its remaining balance
    const fundsList = (items || []).map(item => {
      const budgeted = +item.budgeted_amount
      const spent = actualsMap[item.id] || 0
      const remaining = budgeted - spent
      return {
        id: item.id,
        name: item.name,
        budgeted,
        spent,
        remaining,
        category: item.category?.name || '',
        icon: item.category?.icon || '📋',
        color: item.category?.color || 'var(--muted)',
      }
    }).sort((a, b) => {
      // Show items with activity first, then by remaining ascending (lowest first)
      if (a.spent > 0 && b.spent === 0) return -1
      if (a.spent === 0 && b.spent > 0) return 1
      return a.remaining - b.remaining
    })

    const budgeted = (items || []).reduce((s, i) => s + +i.budgeted_amount, 0)
    const spent = allTxns?.reduce((s, t) => s + +t.amount, 0) || 0

    setAccounts(accs || [])
    setFunds(fundsList)
    setSummary({ budgeted, spent })
    setRecent(txns || [])
    setLoading(false)
  }

  const buffer = NET_MO - summary.spent
  const bufColor = buffer >= 1000 ? 'var(--green)' : buffer >= 0 ? 'var(--amber)' : 'var(--red)'

  // Show top items by default, expand to see all
  const visibleFunds = showAll ? funds : funds.slice(0, 10)

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

      {/* Funds Available — the envelope view */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Funds Available</h2>
          <Link to="/budget" style={{ fontSize: '0.72rem', color: 'var(--accent)', textDecoration: 'none' }}>Edit Budget →</Link>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {visibleFunds.length === 0 && (
            <div style={{ fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center', padding: '1.5rem' }}>
              No budget items yet — <Link to="/budget" style={{ color: 'var(--accent)' }}>set up your budget</Link>
            </div>
          )}
          {visibleFunds.map((f, i) => {
            const pct = f.budgeted > 0 ? Math.min((f.spent / f.budgeted) * 100, 100) : 0
            const remainColor = f.remaining <= 0 ? 'var(--red)' : f.remaining < f.budgeted * 0.25 ? 'var(--amber)' : 'var(--green)'
            return (
              <div key={f.id} style={{ padding: '0.55rem 0.9rem', borderBottom: i < visibleFunds.length-1 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <span style={{ fontSize: '0.75rem' }}>{f.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.92rem', fontWeight: 600, color: remainColor }}>
                    {f.remaining < 0 ? '-' : ''}{fmt(f.remaining)}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ flex: 1, background: 'var(--border)', borderRadius: '3px', height: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: remainColor, borderRadius: '3px', transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ fontSize: '0.58rem', color: 'var(--muted)', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
                    {fmt(f.spent)} / {fmt(f.budgeted)}
                  </div>
                </div>
              </div>
            )
          })}
          {funds.length > 10 && (
            <button onClick={() => setShowAll(!showAll)} style={{ width: '100%', background: 'transparent', border: 'none', borderTop: '1px solid var(--border)', color: 'var(--accent)', fontSize: '0.72rem', padding: '0.6rem', cursor: 'pointer' }}>
              {showAll ? 'Show less' : `Show all ${funds.length} items`}
            </button>
          )}
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
