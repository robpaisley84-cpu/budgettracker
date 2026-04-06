import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, addMonths, subMonths } from 'date-fns'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()

export default function Budget() {
  const { household } = useAuth()
  const [currentDate, setCurrentDate] = useState(new Date())
  const [categories, setCategories]   = useState([])
  const [actuals, setActuals]         = useState({})
  const [expanded, setExpanded]       = useState({})
  const [loading, setLoading]         = useState(true)
  const [editing, setEditing]         = useState(null)
  const [editVal, setEditVal]         = useState('')
  const [showAddItem, setShowAddItem] = useState(null)
  const [showAddCat, setShowAddCat]   = useState(false)
  const [form, setForm]               = useState({})
  const [saving, setSaving]           = useState(false)
  const month = format(currentDate, 'yyyy-MM')

  useEffect(() => { if (household) load() }, [household, month])

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

  async function saveItemAmount(itemId) {
    if (!editVal && editVal !== '0') return
    setSaving(true)
    await supabase.from('budget_items').update({ budgeted_amount: +editVal }).eq('id', itemId)
    setEditing(null)
    setEditVal('')
    setSaving(false)
    load()
  }

  async function addItem() {
    if (!form.name || !showAddItem) return
    setSaving(true)
    const cat = categories.find(c => c.id === showAddItem)
    await supabase.from('budget_items').insert({
      household_id: household.id,
      category_id: showAddItem,
      name: form.name,
      budgeted_amount: +form.amount || 0,
      is_fixed: form.is_fixed || false,
      sort_order: (cat?.items?.length || 0) + 1,
    })
    setSaving(false)
    setShowAddItem(null)
    setForm({})
    load()
  }

  async function deleteItem(itemId) {
    await supabase.from('budget_items').update({ is_active: false }).eq('id', itemId)
    load()
  }

  async function addCategory() {
    if (!form.catName) return
    setSaving(true)
    await supabase.from('budget_categories').insert({
      household_id: household.id,
      name: form.catName,
      icon: form.catIcon || '📋',
      color: form.catColor || '#4a9a5a',
      sort_order: categories.length + 1,
    })
    setSaving(false)
    setShowAddCat(false)
    setForm({})
    load()
  }

  async function deleteCategory(catId) {
    await supabase.from('budget_items').update({ is_active: false }).match({ category_id: catId })
    await supabase.from('budget_categories').delete().eq('id', catId)
    load()
  }

  const toggle = (id) => setExpanded(e => ({ ...e, [id]: !e[id] }))

  const totalBudgeted = categories.flatMap(c => (c.items || []).filter(i => i.is_active !== false)).reduce((s, i) => s + +i.budgeted_amount, 0)
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
          const items      = (cat.items || []).filter(i => i.is_active !== false).sort((a, b) => a.sort_order - b.sort_order)
          const catBudget  = items.reduce((s, i) => s + +i.budgeted_amount, 0)
          const catSpent   = items.reduce((s, i) => s + (actuals[i.id] || 0), 0)
          const catPct     = catBudget > 0 ? Math.min((catSpent / catBudget) * 100, 100) : 0
          const over       = catSpent > catBudget

          return (
            <div key={cat.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: '0.6rem', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '0.7rem 0.9rem', cursor: 'pointer', gap: '0.5rem' }}>
                <span onClick={() => toggle(cat.id)}>{cat.icon}</span>
                <span onClick={() => toggle(cat.id)} style={{ flex: 1, fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>{cat.name}</span>
                <div onClick={() => toggle(cat.id)} style={{ textAlign: 'right' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: over ? 'var(--red)' : cat.color }}>
                    {catSpent > 0 ? fmt(catSpent) : '—'}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--muted)' }}> / {fmt(catBudget)}</span>
                </div>
                <button onClick={() => deleteCategory(cat.id)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.7rem', padding: '0.2rem', opacity: 0.5 }} title="Delete category">✕</button>
                <span onClick={() => toggle(cat.id)} style={{ color: 'var(--muted)', fontSize: '0.65rem' }}>{expanded[cat.id] ? '▲' : '▼'}</span>
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
                    const isEditing = editing === item.id

                    return (
                      <div key={item.id} style={{ display: 'flex', padding: '0.42rem 0.9rem', borderBottom: idx < items.length-1 ? '1px solid rgba(255,255,255,0.04)' : 'none', alignItems: 'center', gap: '0.5rem' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text)' }}>{item.name}</div>
                          <div style={{ fontSize: '0.63rem', color: 'var(--muted)' }}>
                            Budget: {isEditing ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                                <span style={{ fontFamily: 'var(--font-mono)' }}>$</span>
                                <input
                                  type="number"
                                  value={editVal}
                                  onChange={e => setEditVal(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') saveItemAmount(item.id); if (e.key === 'Escape') setEditing(null) }}
                                  autoFocus
                                  style={{ width: '70px', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: '4px', padding: '0.15rem 0.3rem', color: 'var(--accentL)', fontSize: '0.65rem', fontFamily: 'var(--font-mono)', outline: 'none' }}
                                />
                                <button onClick={() => saveItemAmount(item.id)} style={{ background: 'var(--green)', border: 'none', borderRadius: '3px', color: '#0d1a10', fontSize: '0.55rem', padding: '0.1rem 0.3rem', fontWeight: 700 }}>✓</button>
                                <button onClick={() => setEditing(null)} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--muted)', fontSize: '0.55rem', padding: '0.1rem 0.3rem' }}>✕</button>
                              </span>
                            ) : (
                              <span onClick={() => { setEditing(item.id); setEditVal(item.budgeted_amount) }} style={{ fontFamily: 'var(--font-mono)', cursor: 'pointer', borderBottom: '1px dashed var(--muted)' }}>{fmt(item.budgeted_amount)}</span>
                            )}
                            {!isEditing && spent > 0 && <span style={{ color: isOver ? 'var(--red)' : 'var(--green)', marginLeft: '0.4rem' }}>{isOver ? '▲' : '▼'} {fmt(Math.abs(left))} {isOver ? 'over' : 'left'}</span>}
                          </div>
                        </div>
                        {spent > 0 && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: isOver ? 'var(--red)' : 'var(--accentL)' }}>{fmt(spent)}</span>
                        )}
                        <button onClick={() => deleteItem(item.id)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.65rem', padding: '0.1rem 0.3rem', opacity: 0.4 }} title="Remove item">✕</button>
                      </div>
                    )
                  })}
                  <div style={{ padding: '0.35rem 0.9rem', borderTop: items.length > 0 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                    <button onClick={() => { setShowAddItem(cat.id); setForm({}) }} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: '0.72rem', padding: 0, cursor: 'pointer' }}>+ Add line item</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        <button onClick={() => { setShowAddCat(true); setForm({}) }} style={{ width: '100%', background: 'transparent', border: '1px dashed var(--border)', borderRadius: 'var(--radius)', padding: '0.7rem', color: 'var(--accent)', fontSize: '0.78rem', marginTop: '0.25rem' }}>+ Add Category</button>
      </div>

      {/* Add item modal */}
      {showAddItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setShowAddItem(null) }}>
          <div style={{ background: '#1a2a1c', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '1rem' }}>New Budget Line Item</div>
            {[
              { l: 'Item Name', k: 'name', p: 'e.g. New Expense' },
              { l: 'Monthly Budget', k: 'amount', p: '0', type: 'number' },
            ].map(f => (
              <div key={f.k} style={{ marginBottom: '0.75rem' }}>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{f.l}</label>
                <input type={f.type || 'text'} value={form[f.k] || ''} onChange={e => setForm(x => ({ ...x, [f.k]: e.target.value }))} placeholder={f.p}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }} />
              </div>
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '1rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.is_fixed || false} onChange={e => setForm(x => ({ ...x, is_fixed: e.target.checked }))} />
              Fixed expense (same every month)
            </label>
            <button onClick={addItem} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.9rem' }}>
              {saving ? 'Saving…' : 'Add Item'}
            </button>
          </div>
        </div>
      )}

      {/* Add category modal */}
      {showAddCat && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setShowAddCat(false) }}>
          <div style={{ background: '#1a2a1c', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '1rem' }}>New Budget Category</div>
            {[
              { l: 'Category Name', k: 'catName', p: 'e.g. Entertainment' },
              { l: 'Icon (emoji)', k: 'catIcon', p: '📋' },
              { l: 'Color (hex)', k: 'catColor', p: '#4a9a5a' },
            ].map(f => (
              <div key={f.k} style={{ marginBottom: '0.75rem' }}>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{f.l}</label>
                <input value={form[f.k] || ''} onChange={e => setForm(x => ({ ...x, [f.k]: e.target.value }))} placeholder={f.p}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }} />
              </div>
            ))}
            <button onClick={addCategory} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.9rem' }}>
              {saving ? 'Saving…' : 'Add Category'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
