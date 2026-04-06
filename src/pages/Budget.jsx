import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, addMonths, subMonths } from 'date-fns'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()

export default function Budget() {
  const { household } = useAuth()
  const [currentDate, setCurrentDate] = useState(new Date())
  const [categories, setCategories]   = useState([])
  const [actuals, setActuals]         = useState({})  // itemId -> amount
  const [expanded, setExpanded]       = useState({})
  const [loading, setLoading]         = useState(true)
  const month = format(currentDate, 'yyyy-MM')

  useEffect(() => { if (household) load() }, [household, month])

  // Real-time updates
  useEffect(() => {
    if (!household) return
    const sub = supabase
      .channel('budget-transactions')
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'transactions',
        filter: `household_id=eq.${household.id}`,
      }, () => loadActuals())
      .subscribe()
    return () => sub.unsubscribe()
  }, [household, month])

  async function load() {
    setLoading(true)
    const { data: cats } = await supabase
      .from('budget_categories')
      .select('*, items:budget_items(*)')
      .eq('household_id', household.id)
      .order('sort_order')
    setCategories(cats || [])
    if (cats?.length) setExpanded(Object.fromEntries(cats.map(c => [c.id, true])))
    await loadActuals()
    setLoading(false)
  }

  async function loadActuals() {
    const { data } = await supabase
      .from('transactions')
      .select('budget_item_id, amount')
      .eq('household_id', household.id)
      .eq('budget_month', month)
      .eq('type', 'expense')
    const map = {}
    data?.forEach(t => { map[t.budget_item_id] = (map[t.budget_item_id] || 0) + +t.amount })
    setActuals(map)
  }

  const toggle = (id) => setExpanded(e => ({ ...e, [id]: !e[id] }))

  const totalBudgeted = categories.flatMap(c => c.items || []).reduce((s, i) => s + +i.budgeted_amount, 0)
  const totalSpent    = Object.values(actuals).reduce((s, v) => s + v, 0)

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ paddingBottom: '5.5rem' }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg)', borderBottom: '1px solid var(--border)', padding: '0.85rem 0.85rem 0.7rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.6rem' }}>
          <button onClick={() => setCurrentDate(d => subMonths(d, 1))} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '5px', width: '28px', height: '28px', fontSize: '1rem' }}>‹</button>
          <span style={{ flex: 1, textAlign: 'center', fontFamily: 'var(--font-display)', fontSize: '1rem', color: 'var(--accentL)' }}>{format(currentDate, 'MMMM yyyy')}</span>
          <button onClick={() => setCurrentDate(d => addMonths(d, 1))} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '5px', width: '28px', height: '28px', fontSize: '1rem' }}>›</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem', fontSize: '0.72rem', textAlign: 'center' }}>
          {[
            { l: 'Budgeted', v: fmt(totalBudgeted), c: 'var(--muted)' },
            { l: 'Spent', v: fmt(totalSpent), c: 'var(--accentL)' },
            { l: 'Remaining', v: fmt(totalBudgeted - totalSpent), c: totalBudgeted - totalSpent >= 0 ? 'var(--green)' : 'var(--red)' },
          ].map(x => (
            <div key={x.l}>
              <div style={{ color: 'var(--muted)', fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{x.l}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', color: x.c, fontWeight: 500 }}>{x.v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Categories */}
      <div style={{ padding: '0.75rem 0.85rem' }}>
        {categories.map(cat => {
          const items      = (cat.items || []).sort((a, b) => a.sort_order - b.sort_order)
          const catBudget  = items.reduce((s, i) => s + +i.budgeted_amount, 0)
          const catSpent   = items.reduce((s, i) => s + (actuals[i.id] || 0), 0)
          const catPct     = catBudget > 0 ? Math.min((catSpent / catBudget) * 100, 100) : 0
          const over       = catSpent > catBudget

          return (
            <div key={cat.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: '0.6rem', overflow: 'hidden' }}>
              <div onClick={() => toggle(cat.id)} style={{ display: 'flex', alignItems: 'center', padding: '0.7rem 0.9rem', cursor: 'pointer', gap: '0.5rem' }}>
                <span>{cat.icon}</span>
                <span style={{ flex: 1, fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>{cat.name}</span>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: over ? 'var(--red)' : cat.color }}>
                    {catSpent > 0 ? fmt(catSpent) : '—'}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--muted)' }}> / {fmt(catBudget)}</span>
                </div>
                <span style={{ color: 'var(--muted)', fontSize: '0.65rem' }}>{expanded[cat.id] ? '▲' : '▼'}</span>
              </div>

              {catSpent > 0 && (
                <div style={{ height: '3px', background: 'var(--border)', margin: '0 0.9rem' }}>
                  <div style={{ width: `${catPct}%`, height: '100%', background: over ? 'var(--red)' : cat.color, borderRadius: '2px', transition: 'width 0.3s' }} />
                </div>
              )}

              {expanded[cat.id] && (
                <div style={{ borderTop: '1px solid var(--border)' }}>
                  {items.map((item, idx) => {
                    const spent = actuals[item.id] || 0
                    const left  = +item.budgeted_amount - spent
                    const isOver = spent > +item.budgeted_amount
                    return (
                      <div key={item.id} style={{ display: 'flex', padding: '0.42rem 0.9rem', borderBottom: idx < items.length-1 ? '1px solid rgba(255,255,255,0.04)' : 'none', alignItems: 'center', gap: '0.5rem' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text)' }}>{item.name}</div>
                          <div style={{ fontSize: '0.63rem', color: 'var(--muted)' }}>
                            Budget: <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(item.budgeted_amount)}</span>
                            {spent > 0 && <span style={{ color: isOver ? 'var(--red)' : 'var(--green)', marginLeft: '0.4rem' }}>{isOver ? '▲' : '▼'} {fmt(Math.abs(left))} {isOver ? 'over' : 'left'}</span>}
                          </div>
                        </div>
                        {spent > 0 && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: isOver ? 'var(--red)' : 'var(--accentL)' }}>{fmt(spent)}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
