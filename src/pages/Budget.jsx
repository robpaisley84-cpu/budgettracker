import { useState, useEffect, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, addMonths, subMonths } from 'date-fns'
import { isScheduled, nextDue, billAmount, perCheckToMonthly, monthlyToPerCheck } from '../lib/funding'

const fmt  = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()
const fmt2 = (n) => '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const TIERS = {
  essential: { label: 'Essentials', short: 'E', color: 'var(--tierE)' },
  lifestyle: { label: 'Lifestyle',  short: 'L', color: 'var(--tierL)' },
  savings:   { label: 'Savings',    short: 'S', color: 'var(--tierS)' },
}
const TIER_ORDER = ['essential', 'lifestyle', 'savings']

export default function Budget() {
  const { household } = useAuth()
  const [currentDate, setCurrentDate] = useState(new Date())
  const [categories, setCategories]   = useState([])
  const [actuals, setActuals]         = useState({})
  const [txnsByItem, setTxnsByItem]   = useState({})   // the expenses behind each line's total
  const [showTxns, setShowTxns]       = useState({})   // which lines are drilled open
  const [expanded, setExpanded]       = useState({})
  const [loading, setLoading]         = useState(true)
  const [editing, setEditing]         = useState(null)
  const [editVal, setEditVal]         = useState('')
  const [editUnit, setEditUnit]       = useState('check')   // 'check' | 'month' — either is accepted (015)
  const [renaming, setRenaming]       = useState(null)
  const [renameVal, setRenameVal]     = useState('')
  const [confirmDel, setConfirmDel]   = useState(null)
  const [confirmCat, setConfirmCat]   = useState(null)
  const [renamingCat, setRenamingCat] = useState(null)
  const [catNameVal, setCatNameVal]   = useState('')
  const [accounts, setAccounts]       = useState([])
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
    const [{ data: cats }, { data: accs }] = await Promise.all([
      supabase
        .from('budget_categories')
        .select('*, items:budget_items(*)')
        .eq('household_id', household.id)
        .order('sort_order'),
      // Every line lives in an account (014): checking for a virtual envelope,
      // its own savings account for a fund
      supabase.from('accounts').select('id, name, icon, type').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
    ])
    setCategories(cats || [])
    setAccounts(accs || [])
    if (cats?.length) setExpanded(Object.fromEntries(cats.map(c => [c.id, true])))
    await loadActuals()
    setLoading(false)
  }

  // Both the per-line totals and the individual expenses behind them, so a
  // line can be drilled open to see exactly what made up its number.
  async function loadActuals() {
    const { data } = await supabase
      .from('transactions')
      .select('id, budget_item_id, amount, date, description, payment_method')
      .eq('household_id', household.id)
      .eq('budget_month', month)
      .eq('type', 'expense')
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
    const map = {}, byItem = {}
    data?.forEach(t => {
      map[t.budget_item_id] = (map[t.budget_item_id] || 0) + +t.amount
      ;(byItem[t.budget_item_id] ||= []).push(t)
    })
    setActuals(map)
    setTxnsByItem(byItem)
  }

  // A flexible line's allowance. Whichever unit was typed, both columns are
  // written: per_check_amount is what the engine uses, budgeted_amount is the
  // monthly equivalent everything else still reads (015).
  async function saveItemAmount(itemId) {
    if (!editVal && editVal !== '0') return
    setSaving(true)
    const freq = household?.pay_frequency
    const perCheck = editUnit === 'month' ? monthlyToPerCheck(+editVal, freq) : Math.round(+editVal * 100) / 100
    await supabase.from('budget_items').update({
      funding_mode: 'flexible',
      per_check_amount: perCheck,
      budgeted_amount: perCheckToMonthly(perCheck, freq),
    }).eq('id', itemId)
    setEditing(null)
    setEditVal('')
    setSaving(false)
    load()
  }

  async function saveItemName(itemId) {
    const name = renameVal.trim()
    if (!name) { setRenaming(null); setRenameVal(''); return }
    setSaving(true)
    await supabase.from('budget_items').update({ name }).eq('id', itemId)
    setRenaming(null)
    setRenameVal('')
    setSaving(false)
    load()
  }

  async function addItem() {
    if (!form.name || !showAddItem) return
    setSaving(true)
    const cat = categories.find(c => c.id === showAddItem)
    // New lines start flexible with a per-check allowance; make one a scheduled
    // bill on the Schedule page. Both amount columns written (015).
    const perCheck = Math.round((+form.amount || 0) * 100) / 100
    await supabase.from('budget_items').insert({
      household_id: household.id,
      category_id: showAddItem,
      name: form.name,
      funding_mode: 'flexible',
      per_check_amount: perCheck,
      budgeted_amount: perCheckToMonthly(perCheck, household?.pay_frequency),
      is_fixed: form.is_fixed || false,
      sort_order: (cat?.items?.length || 0) + 1,
      account_id: accounts.find(a => a.type === 'checking')?.id || null,
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

  // Tap a line's tier chip to move it between Essentials → Lifestyle → Savings
  async function cycleTier(item) {
    const next = TIER_ORDER[(TIER_ORDER.indexOf(item.tier || 'essential') + 1) % TIER_ORDER.length]
    await supabase.from('budget_items').update({ tier: next }).eq('id', item.id)
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

  // Which account a line lives in. Checking makes it a virtual envelope; any
  // other account makes the line that account, and funding it moves money there.
  async function setBacking(itemId, accountId) {
    await supabase.from('budget_items').update({ account_id: accountId || null }).eq('id', itemId)
    load()
  }

  // Exactly one line receives each paycheck's leftover (enforced by a unique
  // index), so clear the old one before setting the new.
  async function setRemainderTarget(itemId, on) {
    if (on) {
      await supabase.from('budget_items').update({ is_remainder_target: false }).eq('household_id', household.id).eq('is_remainder_target', true)
      await supabase.from('budget_items').update({ is_remainder_target: true }).eq('id', itemId)
    } else {
      await supabase.from('budget_items').update({ is_remainder_target: false }).eq('id', itemId)
    }
    load()
  }

  async function saveCatName(catId) {
    const name = catNameVal.trim()
    if (!name) { setRenamingCat(null); setCatNameVal(''); return }
    setSaving(true)
    await supabase.from('budget_categories').update({ name }).eq('id', catId)
    setRenamingCat(null); setCatNameVal(''); setSaving(false)
    load()
  }

  async function deleteCategory(catId) {
    await supabase.from('budget_items').update({ is_active: false }).match({ category_id: catId })
    await supabase.from('budget_categories').delete().eq('id', catId)
    load()
  }

  const toggle = (id) => setExpanded(e => ({ ...e, [id]: !e[id] }))

  const activeItems  = categories.flatMap(c => (c.items || []).filter(i => i.is_active !== false))
  const totalBudgeted = activeItems.reduce((s, i) => s + +i.budgeted_amount, 0)
  const totalSpent    = Object.values(actuals).reduce((s, v) => s + v, 0)
  const tierTotals = { essential: 0, lifestyle: 0, savings: 0 }
  activeItems.forEach(i => { tierTotals[i.tier || 'essential'] += +i.budgeted_amount })

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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem', marginTop: '0.5rem', textAlign: 'center' }}>
          {TIER_ORDER.map(t => (
            <div key={t}>
              <div style={{ color: TIERS[t].color, fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{TIERS[t].label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: TIERS[t].color }}>{fmt(tierTotals[t])}</div>
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
                {renamingCat === cat.id ? (
                  <span style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                    <input value={catNameVal} onChange={e => setCatNameVal(e.target.value)} autoFocus
                      onKeyDown={e => { if (e.key === 'Enter') saveCatName(cat.id); if (e.key === 'Escape') { setRenamingCat(null); setCatNameVal('') } }}
                      style={{ flex: 1, minWidth: 0, background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: '4px', padding: '0.2rem 0.4rem', color: 'var(--text)', fontSize: '0.85rem', fontWeight: 700, outline: 'none' }} />
                    <button onClick={() => saveCatName(cat.id)} style={{ background: 'var(--green)', border: 'none', borderRadius: '3px', color: 'var(--onAccent)', fontSize: '0.55rem', padding: '0.1rem 0.3rem', fontWeight: 700 }}>✓</button>
                    <button onClick={() => { setRenamingCat(null); setCatNameVal('') }} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--muted)', fontSize: '0.55rem', padding: '0.1rem 0.3rem' }}>✕</button>
                  </span>
                ) : (
                  <span onClick={() => { setRenamingCat(cat.id); setCatNameVal(cat.name) }} title="Tap to rename"
                    style={{ flex: 1, fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>{cat.name}</span>
                )}
                <div onClick={() => toggle(cat.id)} style={{ textAlign: 'right' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: over ? 'var(--red)' : cat.color }}>
                    {catSpent > 0 ? fmt(catSpent) : '—'}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--muted)' }}> / {fmt(catBudget)}</span>
                </div>
                {confirmCat === cat.id ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                    <span style={{ fontSize: '0.58rem', color: 'var(--red)' }}>Delete category and its {items.length} item{items.length === 1 ? '' : 's'}?</span>
                    <button onClick={() => { setConfirmCat(null); deleteCategory(cat.id) }}
                      style={{ background: 'var(--red)', border: 'none', borderRadius: '3px', color: '#fff', fontSize: '0.55rem', fontWeight: 700, padding: '0.1rem 0.35rem' }}>Yes</button>
                    <button onClick={() => setConfirmCat(null)}
                      style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--muted)', fontSize: '0.55rem', padding: '0.1rem 0.35rem' }}>No</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmCat(cat.id)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.7rem', padding: '0.2rem', opacity: 0.5 }} title="Delete category">✕</button>
                )}
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
                    // A scheduled bill's numbers come from its schedule — edit those
                    // on the Schedule page, not here (015).
                    const auto = isScheduled(item)
                    const due  = auto ? nextDue(item, new Date()) : null
                    const isEditing = editing === item.id && !auto

                    const lineTxns = txnsByItem[item.id] || []
                    const open = !!showTxns[item.id] && lineTxns.length > 0

                    return (
                      <Fragment key={item.id}>
                      <div style={{ display: 'flex', padding: '0.42rem 0.9rem', borderBottom: (idx < items.length-1 && !open) ? '1px solid var(--hairline)' : 'none', alignItems: 'center', gap: '0.5rem' }}>
                        <div style={{ flex: 1 }}>
                          {renaming === item.id ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.1rem' }}>
                              <input
                                value={renameVal}
                                onChange={e => setRenameVal(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') saveItemName(item.id); if (e.key === 'Escape') { setRenaming(null); setRenameVal('') } }}
                                autoFocus
                                style={{ flex: 1, minWidth: 0, width: '9rem', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: '4px', padding: '0.15rem 0.35rem', color: 'var(--text)', fontSize: '0.78rem', outline: 'none' }}
                              />
                              <button onClick={() => saveItemName(item.id)} style={{ background: 'var(--green)', border: 'none', borderRadius: '3px', color: 'var(--onAccent)', fontSize: '0.55rem', padding: '0.1rem 0.3rem', fontWeight: 700 }}>✓</button>
                              <button onClick={() => { setRenaming(null); setRenameVal('') }} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--muted)', fontSize: '0.55rem', padding: '0.1rem 0.3rem' }}>✕</button>
                            </span>
                          ) : (
                            <div onClick={() => { setRenaming(item.id); setRenameVal(item.name) }} title="Tap to rename"
                              style={{ fontSize: '0.8rem', color: 'var(--text)', cursor: 'pointer' }}>{item.name}</div>
                          )}
                          <div style={{ fontSize: '0.63rem', color: 'var(--muted)' }}>
                            {isEditing ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                                <span style={{ fontFamily: 'var(--font-mono)' }}>$</span>
                                <input
                                  type="number" step="0.01"
                                  value={editVal}
                                  onChange={e => setEditVal(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') saveItemAmount(item.id); if (e.key === 'Escape') setEditing(null) }}
                                  autoFocus
                                  style={{ width: '70px', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: '4px', padding: '0.15rem 0.3rem', color: 'var(--accentL)', fontSize: '0.65rem', fontFamily: 'var(--font-mono)', outline: 'none' }}
                                />
                                {/* Type in either unit — the other is derived on save */}
                                <button onClick={() => setEditUnit(u => u === 'check' ? 'month' : 'check')} title="Switch between per check and per month"
                                  style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--muted)', fontSize: '0.55rem', padding: '0.1rem 0.3rem' }}>
                                  /{editUnit === 'check' ? 'check' : 'mo'}
                                </button>
                                <button onClick={() => saveItemAmount(item.id)} style={{ background: 'var(--green)', border: 'none', borderRadius: '3px', color: 'var(--onAccent)', fontSize: '0.55rem', padding: '0.1rem 0.3rem', fontWeight: 700 }}>✓</button>
                                <button onClick={() => setEditing(null)} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--muted)', fontSize: '0.55rem', padding: '0.1rem 0.3rem' }}>✕</button>
                              </span>
                            ) : auto ? (
                              <Link to="/bills" style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)', textDecoration: 'none' }} title="A scheduled bill — change its amount or date on the Schedule page">
                                {fmt(billAmount(item))}{due && <> on the {format(due, 'do')}</>} <span style={{ fontSize: '0.6rem', color: 'var(--accent)' }}>📅</span>
                              </Link>
                            ) : (
                              <span onClick={() => { setEditing(item.id); setEditUnit('check'); setEditVal(item.per_check_amount ?? monthlyToPerCheck(item.budgeted_amount, household?.pay_frequency)) }}
                                style={{ fontFamily: 'var(--font-mono)', cursor: 'pointer', borderBottom: '1px dashed var(--muted)' }}>
                                {fmt(item.per_check_amount ?? monthlyToPerCheck(item.budgeted_amount, household?.pay_frequency))}/check
                              </span>
                            )}
                            {!isEditing && !auto && <span style={{ fontFamily: 'var(--font-mono)', marginLeft: '0.35rem', opacity: 0.7 }}>{fmt(item.budgeted_amount)}/mo</span>}
                            {/* Shown even at zero spend — "what's left" is most
                                useful at the start of a month, before anything
                                has been logged against the line. */}
                            {/* A bill is paid or it isn't - "23¢ left" on a loan payment says
                                nothing. Allowances keep left/over, in cents when it's under a dollar. */}
                            {!isEditing && (auto && billAmount(item) > 0
                              ? (spent >= billAmount(item) * 0.98
                                  ? <span style={{ color: 'var(--green)', marginLeft: '0.4rem' }}>✓ paid this month</span>
                                  : <span style={{ color: 'var(--muted)', marginLeft: '0.4rem' }}>not yet paid{due && <> · due the {format(due, 'do')}</>}</span>)
                              : auto
                                ? <span style={{ color: 'var(--red)', marginLeft: '0.4rem' }}>▲ {fmt2(spent)} spent · no amount set</span>
                                : +item.budgeted_amount > 0 && <span style={{ color: isOver ? 'var(--red)' : 'var(--green)', marginLeft: '0.4rem' }}>{isOver ? '▲' : '▼'} {Math.abs(left) < 1 ? fmt2(Math.abs(left)) : fmt(Math.abs(left))} {isOver ? 'over' : 'left'}</span>)}
                          </div>
                          {/* Where this envelope lives. Checking = virtual; anything else = the line is that account. */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.15rem' }}>
                            <span style={{ fontSize: '0.58rem', color: 'var(--muted)' }}>in</span>
                            <select value={item.account_id || ''} onChange={e => setBacking(item.id, e.target.value)}
                              title="The account this line's money lives in"
                              style={{ background: 'transparent', border: 'none', borderBottom: '1px dashed var(--border)', color: 'var(--muted)', fontSize: '0.6rem', padding: '0 0.1rem', outline: 'none', cursor: 'pointer', maxWidth: '11rem' }}>
                              <option value="">— no account —</option>
                              {accounts.map(a => <option key={a.id} value={a.id}>{a.icon} {a.name}{a.type === 'checking' ? ' (virtual)' : ' (moves money)'}</option>)}
                            </select>
                            {item.is_remainder_target && <span style={{ fontSize: '0.58rem', color: 'var(--accent)' }} title="Receives each paycheck's leftover">⤵ leftover</span>}
                          </div>
                        </div>
                        {spent > 0 && (
                          // Tap the total to see the expenses behind it
                          <button onClick={() => setShowTxns(s => ({ ...s, [item.id]: !s[item.id] }))}
                            title={open ? 'Hide expenses' : `Show the ${lineTxns.length} expense${lineTxns.length === 1 ? '' : 's'} behind this`}
                            style={{ background: 'transparent', border: 'none', padding: '0.1rem 0.2rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: isOver ? 'var(--red)' : 'var(--accentL)' }}>{fmt(spent)}</span>
                            <span style={{ fontSize: '0.62rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{lineTxns.length} {open ? '▲' : '▼'}</span>
                          </button>
                        )}
                        {confirmDel === item.id ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                            <span style={{ fontSize: '0.58rem', color: 'var(--muted)' }}>Remove?</span>
                            <button onClick={() => { setConfirmDel(null); deleteItem(item.id) }}
                              style={{ background: 'var(--red)', border: 'none', borderRadius: '3px', color: '#fff', fontSize: '0.55rem', fontWeight: 700, padding: '0.1rem 0.35rem' }}>Yes</button>
                            <button onClick={() => setConfirmDel(null)}
                              style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--muted)', fontSize: '0.55rem', padding: '0.1rem 0.35rem' }}>No</button>
                          </span>
                        ) : (
                          <>
                            <button onClick={() => cycleTier(item)} title={`${TIERS[item.tier || 'essential'].label} — tap to change tier`}
                              style={{ background: 'transparent', border: `1px solid ${TIERS[item.tier || 'essential'].color}`, color: TIERS[item.tier || 'essential'].color, borderRadius: '4px', fontSize: '0.55rem', fontWeight: 700, padding: '0.05rem 0.32rem', fontFamily: 'var(--font-mono)' }}>
                              {TIERS[item.tier || 'essential'].short}
                            </button>
                            <button onClick={() => setRemainderTarget(item.id, !item.is_remainder_target)}
                              title={item.is_remainder_target ? 'Stop sending the paycheck leftover here' : 'Send each paycheck\'s leftover to this line'}
                              style={{ background: item.is_remainder_target ? 'var(--accent)' : 'transparent', border: `1px solid ${item.is_remainder_target ? 'var(--accent)' : 'var(--border)'}`, color: item.is_remainder_target ? 'var(--onAccent)' : 'var(--muted)', borderRadius: '4px', fontSize: '0.6rem', padding: '0.05rem 0.3rem', opacity: item.is_remainder_target ? 1 : 0.6 }}>⤵</button>
                            <button onClick={() => setConfirmDel(item.id)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.65rem', padding: '0.1rem 0.3rem', opacity: 0.4 }} title="Remove item">✕</button>
                          </>
                        )}
                      </div>

                      {/* The expenses behind the total. Each opens on the Log page for editing —
                          a duplicate or a mis-filed entry is fixed from here in two taps. */}
                      {open && (
                        <div style={{ background: 'var(--bg)', padding: '0.25rem 0.9rem 0.45rem 1.5rem', borderBottom: idx < items.length-1 ? '1px solid var(--hairline)' : 'none' }}>
                          {lineTxns.map(t => (
                            <Link key={t.id} to={`/transactions?edit=${t.id}`} title="Edit this entry on the Log page"
                              style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', padding: '0.22rem 0', textDecoration: 'none', color: 'inherit' }}>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.62rem', color: 'var(--muted)', minWidth: '3rem' }}>{format(new Date(t.date + 'T12:00'), 'MMM d')}</span>
                              <span style={{ flex: 1, fontSize: '0.7rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {t.description || <span style={{ color: 'var(--muted)' }}>no description</span>}
                                {t.payment_method && <span style={{ marginLeft: '0.35rem', color: 'var(--muted)', fontSize: '0.58rem', border: '1px solid var(--border)', borderRadius: '999px', padding: '0 0.35rem' }}>{t.payment_method}</span>}
                              </span>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--accentL)' }}>{fmt2(t.amount)}</span>
                            </Link>
                          ))}
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.58rem', color: 'var(--muted)', marginTop: '0.25rem', paddingTop: '0.25rem', borderTop: '1px solid var(--hairline)' }}>
                            <span>{lineTxns.length} entr{lineTxns.length === 1 ? 'y' : 'ies'} · tap one to edit</span>
                            <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt2(spent)}</span>
                          </div>
                        </div>
                      )}
                      </Fragment>
                    )
                  })}
                  <div style={{ padding: '0.35rem 0.9rem', borderTop: items.length > 0 ? '1px solid var(--hairline)' : 'none' }}>
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
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setShowAddItem(null) }}>
          <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '1rem' }}>New Budget Line Item</div>
            {[
              { l: 'Item Name', k: 'name', p: 'e.g. New Expense' },
              { l: 'Allowance per check', k: 'amount', p: '0', type: 'number' },
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
            <button onClick={addItem} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
              {saving ? 'Saving…' : 'Add Item'}
            </button>
          </div>
        </div>
      )}

      {/* Add category modal */}
      {showAddCat && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setShowAddCat(false) }}>
          <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
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
            <button onClick={addCategory} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
              {saving ? 'Saving…' : 'Add Category'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
