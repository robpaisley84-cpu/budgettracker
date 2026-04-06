import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, addMonths, subMonths, getDaysInMonth, getDate } from 'date-fns'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()
const NET_MO = 8424

export default function Dashboard() {
  const { household } = useAuth()
  const [accounts, setAccounts]       = useState([])
  const [funds, setFunds]             = useState([])
  const [summary, setSummary]         = useState({ budgeted: 0, spent: 0 })
  const [recent, setRecent]           = useState([])
  const [ytd, setYtd]                 = useState({ budgeted: 0, spent: 0, months: 0 })
  const [monthlyBreakdown, setMonthlyBreakdown] = useState([])
  const [loading, setLoading]         = useState(true)
  const [showAll, setShowAll]         = useState(false)
  const [showYtd, setShowYtd]         = useState(false)
  const [editFunds, setEditFunds]     = useState(false)
  const [viewMonth, setViewMonth]     = useState(new Date())
  const month = format(viewMonth, 'yyyy-MM')
  const isCurrentMonth = month === format(new Date(), 'yyyy-MM')

  useEffect(() => { if (household) load() }, [household, month])

  async function load() {
    setLoading(true)
    const year = format(viewMonth, 'yyyy')
    const janMonth = `${year}-01`
    const selectedMonthNum = parseInt(format(viewMonth, 'M'))

    const [{ data: accs }, { data: txns }, { data: items }] = await Promise.all([
      supabase.from('accounts').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('transactions').select('*, budget_item:budget_items(name), account:accounts(name)').eq('household_id', household.id).eq('budget_month', month).order('created_at', { ascending: false }).limit(8),
      supabase.from('budget_items').select('id, name, budgeted_amount, is_pinned, fund_sort_order, category:budget_categories(name, icon, color)').eq('household_id', household.id).eq('is_active', true),
    ])

    // This month's expenses (for monthly metrics)
    const { data: monthTxns } = await supabase
      .from('transactions')
      .select('budget_item_id, amount')
      .eq('household_id', household.id)
      .eq('budget_month', month)
      .eq('type', 'expense')

    // YTD expenses per budget item (for envelope balances)
    const { data: ytdItemTxns } = await supabase
      .from('transactions')
      .select('budget_item_id, budget_month, amount')
      .eq('household_id', household.id)
      .eq('type', 'expense')
      .gte('budget_month', janMonth)
      .lte('budget_month', month)

    // Monthly actuals for this month only (for monthly summary)
    const monthActuals = {}
    monthTxns?.forEach(t => { monthActuals[t.budget_item_id] = (monthActuals[t.budget_item_id] || 0) + +t.amount })

    // YTD actuals per item (for envelope balances)
    const ytdActuals = {}
    ytdItemTxns?.forEach(t => { ytdActuals[t.budget_item_id] = (ytdActuals[t.budget_item_id] || 0) + +t.amount })

    // Monthly breakdown totals
    const monthMap = {}
    ytdItemTxns?.forEach(t => { monthMap[t.budget_month] = (monthMap[t.budget_month] || 0) + +t.amount })

    // Build envelope funds list
    // Fund Balance = (Monthly Budget × Months Through Selected Month) - Total YTD Spent
    const fundsList = (items || []).map(item => {
      const monthlyBudget = +item.budgeted_amount
      const totalAllocated = monthlyBudget * selectedMonthNum
      const ytdSpent = ytdActuals[item.id] || 0
      const thisMonthSpent = monthActuals[item.id] || 0
      const fundBalance = totalAllocated - ytdSpent

      return {
        id: item.id,
        name: item.name,
        monthlyBudget,
        totalAllocated,
        ytdSpent,
        thisMonthSpent,
        fundBalance,
        isPinned: item.is_pinned || false,
        sortOrder: item.fund_sort_order || 0,
        category: item.category?.name || '',
        icon: item.category?.icon || '📋',
        color: item.category?.color || 'var(--muted)',
      }
    }).sort((a, b) => {
      // Pinned items first, then by sort order, then by fund balance
      if (a.isPinned && !b.isPinned) return -1
      if (!a.isPinned && b.isPinned) return 1
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
      return a.fundBalance - b.fundBalance
    })

    const budgeted = (items || []).reduce((s, i) => s + +i.budgeted_amount, 0)
    const monthSpent = monthTxns?.reduce((s, t) => s + +t.amount, 0) || 0
    const ytdBudgeted = budgeted * selectedMonthNum
    const ytdSpentTotal = ytdItemTxns?.reduce((s, t) => s + +t.amount, 0) || 0

    // Monthly breakdown array
    const breakdown = []
    for (let m = 1; m <= selectedMonthNum; m++) {
      const mKey = `${year}-${String(m).padStart(2, '0')}`
      breakdown.push({
        month: mKey,
        label: format(new Date(parseInt(year), m - 1, 1), 'MMM'),
        spent: monthMap[mKey] || 0,
        budgeted,
      })
    }

    setAccounts(accs || [])
    setFunds(fundsList)
    setSummary({ budgeted, spent: monthSpent })
    setRecent(txns || [])
    setYtd({ budgeted: ytdBudgeted, spent: ytdSpentTotal, months: selectedMonthNum })
    setMonthlyBreakdown(breakdown)
    setLoading(false)
  }

  const buffer = NET_MO - summary.spent
  const bufColor = buffer >= 1000 ? 'var(--green)' : buffer >= 0 ? 'var(--amber)' : 'var(--red)'

  // Projection
  const dayOfMonth = isCurrentMonth ? getDate(new Date()) : getDaysInMonth(viewMonth)
  const daysInMonth = getDaysInMonth(viewMonth)
  const dailyRate = dayOfMonth > 0 ? summary.spent / dayOfMonth : 0
  const projectedSpend = Math.round(dailyRate * daysInMonth)
  const projectedRemaining = NET_MO - projectedSpend
  const projColor = projectedRemaining >= 500 ? 'var(--green)' : projectedRemaining >= 0 ? 'var(--amber)' : 'var(--red)'

  // YTD projection
  const ytdDailyRate = ytd.months > 0 ? ytd.spent / (ytd.months * 30) : 0
  const projectedYearSpend = Math.round(ytdDailyRate * 365)
  const yearBudget = summary.budgeted * 12
  const yearIncome = NET_MO * 12

  async function togglePin(itemId, currentlyPinned) {
    await supabase.from('budget_items').update({ is_pinned: !currentlyPinned }).eq('id', itemId)
    load()
  }

  async function moveFund(itemId, direction) {
    const idx = funds.findIndex(f => f.id === itemId)
    if (idx < 0) return
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= funds.length) return

    const current = funds[idx]
    const swap = funds[swapIdx]

    // Only reorder within same group (pinned/unpinned)
    if (current.isPinned !== swap.isPinned) return

    await Promise.all([
      supabase.from('budget_items').update({ fund_sort_order: swap.sortOrder || swapIdx }).eq('id', current.id),
      supabase.from('budget_items').update({ fund_sort_order: current.sortOrder || idx }).eq('id', swap.id),
    ])
    load()
  }

  const visibleFunds = showAll ? funds : funds.slice(0, 12)

  // Total envelope balance
  const totalFundBalance = funds.reduce((s, f) => s + f.fundBalance, 0)

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      {/* Header with month navigation */}
      <div style={{ marginBottom: '1.1rem' }}>
        <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--accent)', textTransform: 'uppercase' }}>Road Budget</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button onClick={() => setViewMonth(d => subMonths(d, 1))} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '5px', width: '28px', height: '28px', fontSize: '1rem' }}>‹</button>
          <h1 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)', textAlign: 'center' }}>{format(viewMonth, 'MMMM yyyy')}</h1>
          <button onClick={() => setViewMonth(d => addMonths(d, 1))} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '5px', width: '28px', height: '28px', fontSize: '1rem' }}>›</button>
        </div>
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

      {/* Projected End of Month */}
      {isCurrentMonth && summary.spent > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.85rem', marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.6rem' }}>Projected End of Month</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem', textAlign: 'center' }}>
            <div>
              <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textTransform: 'uppercase' }}>Daily Avg</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.88rem', color: 'var(--accentL)', fontWeight: 500 }}>{fmt(dailyRate)}/day</div>
            </div>
            <div>
              <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textTransform: 'uppercase' }}>Proj. Spend</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.88rem', color: 'var(--accentL)', fontWeight: 500 }}>{fmt(projectedSpend)}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textTransform: 'uppercase' }}>Proj. Balance</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.88rem', color: projColor, fontWeight: 500 }}>{projectedRemaining < 0 ? '-' : ''}{fmt(projectedRemaining)}</div>
            </div>
          </div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.6rem', color: 'var(--muted)', textAlign: 'center' }}>
            Based on {dayOfMonth} of {daysInMonth} days elapsed
          </div>
        </div>
      )}

      {/* YTD Overview */}
      <div style={{ marginBottom: '1rem' }}>
        <button onClick={() => setShowYtd(!showYtd)} style={{ width: '100%', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: showYtd ? 'var(--radius) var(--radius) 0 0' : 'var(--radius)', padding: '0.75rem 0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', color: 'var(--text)' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 400 }}>Year to Date — {format(viewMonth, 'yyyy')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.88rem', color: ytd.spent <= ytd.budgeted ? 'var(--green)' : 'var(--red)' }}>{fmt(ytd.spent)} / {fmt(ytd.budgeted)}</span>
            <span style={{ color: 'var(--muted)', fontSize: '0.65rem' }}>{showYtd ? '▲' : '▼'}</span>
          </div>
        </button>

        {showYtd && (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 var(--radius) var(--radius)', padding: '0.85rem', marginTop: '-1px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem', textAlign: 'center', marginBottom: '0.85rem' }}>
              {[
                { l: 'YTD Budget', v: fmt(ytd.budgeted), c: 'var(--muted)' },
                { l: 'YTD Spent', v: fmt(ytd.spent), c: 'var(--accentL)' },
                { l: 'YTD Savings', v: fmt(ytd.budgeted - ytd.spent), c: ytd.budgeted - ytd.spent >= 0 ? 'var(--green)' : 'var(--red)' },
              ].map(x => (
                <div key={x.l}>
                  <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{x.l}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: x.c, fontWeight: 500 }}>{x.v}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: '0.6rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>Monthly Breakdown</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.25rem', height: '80px', marginBottom: '0.25rem' }}>
              {monthlyBreakdown.map(m => {
                const maxVal = Math.max(summary.budgeted, ...monthlyBreakdown.map(x => x.spent))
                const barH = maxVal > 0 ? (m.spent / maxVal) * 100 : 0
                const budgetH = maxVal > 0 ? (m.budgeted / maxVal) * 100 : 0
                const overBudget = m.spent > m.budgeted
                return (
                  <div key={m.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end', position: 'relative' }}>
                    <div style={{ position: 'absolute', bottom: `${budgetH}%`, left: 0, right: 0, borderTop: '1px dashed var(--muted)', opacity: 0.3 }} />
                    <div style={{ width: '100%', height: `${barH}%`, background: overBudget ? 'var(--red)' : 'var(--green)', borderRadius: '3px 3px 0 0', minHeight: m.spent > 0 ? '3px' : 0, transition: 'height 0.3s' }} />
                  </div>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              {monthlyBreakdown.map(m => (
                <div key={m.month} style={{ flex: 1, textAlign: 'center', fontSize: '0.55rem', color: m.month === month ? 'var(--accentL)' : 'var(--muted)', fontWeight: m.month === month ? 700 : 400 }}>{m.label}</div>
              ))}
            </div>

            {ytd.spent > 0 && (
              <div style={{ marginTop: '0.85rem', padding: '0.65rem', background: 'var(--bg)', borderRadius: '7px' }}>
                <div style={{ fontSize: '0.6rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.4rem' }}>Year-End Projection</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem', textAlign: 'center' }}>
                  {[
                    { l: 'Proj. Expenses', v: fmt(projectedYearSpend), c: 'var(--accentL)' },
                    { l: 'Annual Budget', v: fmt(yearBudget), c: 'var(--muted)' },
                    { l: 'Proj. Net', v: fmt(yearIncome - projectedYearSpend), c: yearIncome - projectedYearSpend >= 0 ? 'var(--green)' : 'var(--red)' },
                  ].map(x => (
                    <div key={x.l}>
                      <div style={{ fontSize: '0.55rem', color: 'var(--muted)', textTransform: 'uppercase' }}>{x.l}</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: x.c, fontWeight: 500 }}>{x.v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textAlign: 'center', marginTop: '0.35rem' }}>
                  Avg {fmt(ytd.spent / ytd.months)}/mo over {ytd.months} month{ytd.months > 1 ? 's' : ''}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Funds Available — envelope balances */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Funds Available</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: totalFundBalance >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
              {totalFundBalance < 0 ? '-' : ''}{fmt(totalFundBalance)}
            </span>
            <button onClick={() => setEditFunds(!editFunds)} style={{ background: editFunds ? 'var(--accent)' : 'transparent', border: `1px solid ${editFunds ? 'var(--accent)' : 'var(--border)'}`, color: editFunds ? '#0d1a10' : 'var(--muted)', borderRadius: '5px', padding: '0.2rem 0.45rem', fontSize: '0.62rem', cursor: 'pointer', fontWeight: editFunds ? 700 : 400 }}>
              {editFunds ? 'Done' : 'Reorder'}
            </button>
            <Link to="/budget" style={{ fontSize: '0.72rem', color: 'var(--accent)', textDecoration: 'none' }}>Edit →</Link>
          </div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {visibleFunds.length === 0 && (
            <div style={{ fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center', padding: '1.5rem' }}>
              No budget items yet — <Link to="/budget" style={{ color: 'var(--accent)' }}>set up your budget</Link>
            </div>
          )}
          {visibleFunds.map((f, i) => {
            const pct = f.totalAllocated > 0 ? Math.min((f.ytdSpent / f.totalAllocated) * 100, 100) : 0
            const balColor = f.fundBalance <= 0 ? 'var(--red)' : f.fundBalance < f.monthlyBudget * 0.5 ? 'var(--amber)' : 'var(--green)'
            return (
              <div key={f.id} style={{ padding: '0.55rem 0.9rem', borderBottom: i < visibleFunds.length-1 ? '1px solid var(--border)' : 'none', background: f.isPinned ? 'rgba(200,160,80,0.04)' : 'transparent' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  {editFunds && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                      <button onClick={() => moveFund(f.id, 'up')} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.6rem', padding: '0', lineHeight: 1, cursor: 'pointer' }}>▲</button>
                      <button onClick={() => moveFund(f.id, 'down')} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.6rem', padding: '0', lineHeight: 1, cursor: 'pointer' }}>▼</button>
                    </div>
                  )}
                  <button onClick={() => togglePin(f.id, f.isPinned)} style={{ background: 'transparent', border: 'none', fontSize: '0.75rem', padding: 0, cursor: 'pointer', opacity: f.isPinned ? 1 : 0.35 }} title={f.isPinned ? 'Unpin' : 'Pin to top'}>
                    {f.isPinned ? '⭐' : '☆'}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.92rem', fontWeight: 600, color: balColor }}>
                    {f.fundBalance < 0 ? '-' : ''}{fmt(f.fundBalance)}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: editFunds ? '1.1rem' : '1.65rem' }}>
                  <div style={{ flex: 1, background: 'var(--border)', borderRadius: '3px', height: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: balColor, borderRadius: '3px', transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ fontSize: '0.55rem', color: 'var(--muted)', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
                    {fmt(f.ytdSpent)} spent / {fmt(f.totalAllocated)} alloc
                    {f.thisMonthSpent > 0 && <span style={{ color: 'var(--accentL)' }}> · {fmt(f.thisMonthSpent)} this mo</span>}
                  </div>
                </div>
              </div>
            )
          })}
          {funds.length > 12 && (
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
