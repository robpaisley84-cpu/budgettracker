import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, addDays, nextDay, startOfDay } from 'date-fns'
import { computeAccrual, isAutoAccrued } from '../lib/accrual'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()

export default function Allocations() {
  const { household, user } = useAuth()
  const [rules, setRules]         = useState([])
  const [accounts, setAccounts]   = useState([])
  const [paychecks, setPaychecks] = useState([])
  const [showAdd, setShowAdd]     = useState(false)
  const [showPaycheck, setShowPaycheck] = useState(false)
  const [form, setForm]           = useState({})
  const [paycheckAmt, setPaycheckAmt] = useState(household?.paycheck_amount || 4212)
  const [processing, setProcessing] = useState(false)
  const [loading, setLoading]     = useState(true)
  const [items, setItems]         = useState([])
  const [showDistribute, setShowDistribute] = useState(false)
  const [distPaycheck, setDistPaycheck]     = useState(null)
  const [distRows, setDistRows]   = useState([])
  const [distSaving, setDistSaving] = useState(false)
  const [distErr, setDistErr]     = useState('')
  const [renamingRule, setRenamingRule] = useState(null)
  const [ruleNameVal, setRuleNameVal]   = useState('')

  useEffect(() => { if (household) load() }, [household])

  async function load() {
    const [{ data: r }, { data: a }, { data: p }, { data: bi }] = await Promise.all([
      supabase.from('allocation_rules').select('*, account:accounts(name,icon,color)').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('accounts').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('paychecks').select('*').eq('household_id', household.id).order('date', { ascending: false }).limit(6),
      // Budget lines, for distributing a paycheck across them
      supabase.from('budget_items')
        .select('id, name, budgeted_amount, bill_amount, interval_months, last_paid_date, next_due_date, auto_accrue, saved_so_far, saved_as_of, category:budget_categories(name, icon, sort_order)')
        .eq('household_id', household.id).eq('is_active', true),
    ])
    setRules(r || [])
    setAccounts(a || [])
    setPaychecks(p || [])
    setItems(bi || [])
    setLoading(false)
  }

  // How much of one check a monthly plan implies. Approximate by design — it is
  // a starting suggestion you then adjust, not a rule.
  const CHECKS_PER_MONTH = { weekly: 4, biweekly: 2, semimonthly: 2, monthly: 1 }

  function suggestedFor(item) {
    const perMonth = isAutoAccrued(item)
      ? (computeAccrual(item)?.accrual ?? +item.budgeted_amount)
      : +item.budgeted_amount
    const checks = CHECKS_PER_MONTH[household?.pay_frequency || 'biweekly'] || 2
    return Math.round((perMonth / checks) * 100) / 100
  }

  // Open the distribute sheet for a paycheck, pre-filled with whatever is
  // already allocated to it, falling back to the suggestion per line.
  async function openDistribute(paycheck) {
    setDistPaycheck(paycheck)
    const { data: existing } = await supabase
      .from('paycheck_allocations')
      .select('budget_item_id, amount')
      .eq('paycheck_id', paycheck.id)
    const already = {}
    existing?.forEach(e => { already[e.budget_item_id] = (already[e.budget_item_id] || 0) + +e.amount })
    const rows = (items || [])
      .map(i => ({
        id: i.id,
        name: i.name,
        icon: i.category?.icon || '📋',
        catSort: i.category?.sort_order ?? 99,
        suggested: suggestedFor(i),
        amount: String(already[i.id] ?? suggestedFor(i)),
      }))
      .sort((a, b) => a.catSort - b.catSort || a.name.localeCompare(b.name))
    setDistRows(rows)
    setShowDistribute(true)
  }

  // Replace this paycheck's distribution wholesale. Transfers between lines
  // carry no paycheck_id, so they are untouched by this.
  async function saveDistribution() {
    if (!distPaycheck) return
    setDistSaving(true)
    await supabase.from('paycheck_allocations').delete().eq('paycheck_id', distPaycheck.id)
    const rows = distRows
      .filter(r => +r.amount > 0)
      .map(r => ({
        household_id: household.id,
        paycheck_id: distPaycheck.id,
        budget_item_id: r.id,
        amount: +r.amount,
        date: distPaycheck.date,
        budget_month: String(distPaycheck.date).slice(0, 7),
        created_by: user.id,
        note: 'Paycheck allocation',
      }))
    if (rows.length) {
      const { error } = await supabase.from('paycheck_allocations').insert(rows)
      if (error) { setDistErr(`Couldn't save: ${error.message}`); setDistSaving(false); return }
    }
    setDistErr('')
    setDistSaving(false)
    setShowDistribute(false)
    load()
  }

  async function addRule() {
    if (!form.account_id || !form.amount || !form.name) return
    await supabase.from('allocation_rules').insert({
      household_id: household.id,
      account_id: form.account_id,
      name: form.name,
      amount: +form.amount,
      sort_order: rules.length + 1,
    })
    setShowAdd(false); setForm({}); load()
  }

  async function deleteRule(id) {
    await supabase.from('allocation_rules').update({ is_active: false }).eq('id', id)
    load()
  }

  // A rule's name is its own record — it shows up in the description of every
  // allocation transaction it creates, so a stale one is worth fixing.
  async function saveRuleName(id) {
    const name = ruleNameVal.trim()
    if (!name) { setRenamingRule(null); setRuleNameVal(''); return }
    await supabase.from('allocation_rules').update({ name }).eq('id', id)
    setRenamingRule(null); setRuleNameVal('')
    load()
  }

  async function processPaycheck() {
    if (!paycheckAmt || processing) return
    setProcessing(true)

    const today = format(new Date(), 'yyyy-MM-dd')
    const month = today.slice(0, 7)
    const amt   = +paycheckAmt

    // Log the paycheck
    await supabase.from('paychecks').insert({
      household_id: household.id,
      gross_amount: amt,
      net_amount: amt,
      date: today,
      created_by: user.id,
    })

    // Process each allocation rule. The allocation transaction is the only
    // record needed — account balances derive from these rows (012).
    for (const rule of rules) {
      const alloc = rule.is_percentage ? (amt * rule.amount / 100) : rule.amount

      await supabase.from('transactions').insert({
        household_id: household.id,
        account_id: rule.account_id,
        type: 'allocation',
        amount: alloc,
        description: `Paycheck allocation: ${rule.name}`,
        date: today,
        budget_month: month,
        created_by: user.id,
      })
    }

    // Remaining goes to checking (first checking account)
    const totalAllocated = rules.reduce((s, r) => s + (r.is_percentage ? (amt * r.amount / 100) : r.amount), 0)
    const remainder = amt - totalAllocated
    if (remainder > 0) {
      const checking = accounts.find(a => a.type === 'checking')
      if (checking) {
        await supabase.from('transactions').insert({
          household_id: household.id,
          account_id: checking.id,
          type: 'allocation',
          amount: remainder,
          description: 'Paycheck — remaining to checking',
          date: today, budget_month: month,
          created_by: user.id,
        })
      }
    }

    setProcessing(false); setShowPaycheck(false); load()
  }

  const totalAllocated = rules.reduce((s, r) => s + +r.amount, 0)
  const remainder = (household?.paycheck_amount || 4212) - totalAllocated

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--accent)', textTransform: 'uppercase' }}>Bi-Weekly</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)' }}>Paycheck</div>
        </div>
        <button onClick={() => setShowPaycheck(true)} style={{ background: 'var(--green)', border: 'none', color: 'var(--onAccent)', borderRadius: '8px', padding: '0.5rem 1rem', fontWeight: 700, fontSize: '0.82rem' }}>▶ Process Paycheck</button>
      </div>

      {/* Paycheck summary */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem', marginBottom: '1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem', textAlign: 'center', fontSize: '0.78rem' }}>
          {[
            { l: 'Paycheck', v: fmt(household?.paycheck_amount || 4212), c: 'var(--green)' },
            { l: 'Allocated', v: fmt(totalAllocated), c: 'var(--accentL)' },
            { l: 'To Checking', v: fmt(Math.max(0, remainder)), c: remainder < 0 ? 'var(--red)' : 'var(--muted)' },
          ].map(x => (
            <div key={x.l}>
              <div style={{ fontSize: '0.6rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.2rem' }}>{x.l}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, color: x.c }}>{x.v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Distribute sheet */}
      {showDistribute && distPaycheck && (() => {
        const assigned = distRows.reduce((s, r) => s + (+r.amount || 0), 0)
        const left = Math.round((+distPaycheck.net_amount - assigned) * 100) / 100
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
            onClick={e => { if (e.target === e.currentTarget) setShowDistribute(false) }}>
            <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--green)', borderRadius: '16px 16px 0 0', padding: '1.1rem 1.1rem 1.6rem', width: '100%', maxWidth: '600px', margin: '0 auto', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.35rem' }}>Distribute paycheck</div>
              <div style={{ fontSize: '0.95rem', color: 'var(--text)', marginBottom: '0.6rem' }}>
                {format(startOfDay(new Date(distPaycheck.date + 'T12:00')), 'EEE, MMM d')} · {fmt(distPaycheck.net_amount)}
              </div>

              {/* Running remainder — the number that tells you the check is balanced */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', background: 'var(--bg)', border: `1px solid ${left < 0 ? 'var(--red)' : left === 0 ? 'var(--green)' : 'var(--border)'}`, borderRadius: '8px', padding: '0.6rem 0.8rem', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  {left < 0 ? 'Over-assigned' : 'Left to assign'}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1.15rem', color: left < 0 ? 'var(--red)' : left === 0 ? 'var(--green)' : 'var(--accentL)' }}>
                  {left < 0 ? '-' : ''}{fmt(left)}
                </span>
              </div>

              {distErr && <div style={{ fontSize: '0.7rem', color: 'var(--red)', marginBottom: '0.5rem' }}>⚠️ {distErr}</div>}

              <div style={{ flex: 1, overflowY: 'auto', marginBottom: '0.75rem', border: '1px solid var(--border)', borderRadius: '8px' }}>
                {distRows.map((r, i) => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.45rem 0.7rem', borderBottom: i < distRows.length - 1 ? '1px solid var(--hairline)' : 'none' }}>
                    <span style={{ fontSize: '0.85rem' }}>{r.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.76rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                      <button onClick={() => setDistRows(rows => rows.map(x => x.id === r.id ? { ...x, amount: String(x.suggested) } : x))}
                        style={{ background: 'transparent', border: 'none', padding: 0, fontSize: '0.58rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                        suggested {fmt(r.suggested)}
                      </button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0 0.4rem' }}>
                      <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>$</span>
                      <input type="number" step="0.01" value={r.amount}
                        onChange={e => setDistRows(rows => rows.map(x => x.id === r.id ? { ...x, amount: e.target.value } : x))}
                        style={{ width: '4.6rem', background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '0.82rem', fontFamily: 'var(--font-mono)', padding: '0.35rem 0', textAlign: 'right' }} />
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={() => setDistRows(rows => rows.map(r => ({ ...r, amount: String(r.suggested) })))}
                  style={{ flex: 1, background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.7rem', color: 'var(--muted)', fontSize: '0.8rem' }}>
                  Reset to plan
                </button>
                <button onClick={saveDistribution} disabled={distSaving}
                  style={{ flex: 2, background: 'var(--green)', border: 'none', borderRadius: '8px', padding: '0.7rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.85rem' }}>
                  {distSaving ? 'Saving…' : 'Save distribution'}
                </button>
              </div>
              <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textAlign: 'center', marginTop: '0.5rem', lineHeight: 1.45 }}>
                Replaces this paycheck's distribution. Money you've moved between funds isn't affected.
              </div>
            </div>
          </div>
        )
      })()}

      {/* Distribute a logged paycheck across the budget lines */}
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.5rem' }}>Distribute to Budget</h2>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {paychecks.length === 0 && (
            <div style={{ fontSize: '0.78rem', color: 'var(--muted)', textAlign: 'center', padding: '1.25rem' }}>
              No paychecks logged yet — process one above, then distribute it.
            </div>
          )}
          {paychecks.slice(0, 3).map((p, i) => (
            <button key={p.id} onClick={() => openDistribute(p)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.6rem', background: 'transparent', border: 'none', borderBottom: i < Math.min(paychecks.length, 3) - 1 ? '1px solid var(--border)' : 'none', padding: '0.7rem 0.9rem', textAlign: 'left' }}>
              <span style={{ fontSize: '1rem' }}>📅</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.82rem', color: 'var(--text)' }}>{format(startOfDay(new Date(p.date + 'T12:00')), 'EEE, MMM d')}</div>
                <div style={{ fontSize: '0.62rem', color: 'var(--muted)' }}>Tap to split across budget lines</div>
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.88rem', color: 'var(--green)' }}>{fmt(p.net_amount)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Allocation rules */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Allocation Rules</h2>
        <button onClick={() => { setShowAdd(true); setForm({}) }} style={{ background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: '6px', padding: '0.3rem 0.65rem', fontSize: '0.75rem' }}>+ Add Rule</button>
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: '1.25rem' }}>
        {rules.length === 0 && <div style={{ fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center', padding: '1.5rem' }}>No rules yet — add one to auto-allocate funds on each paycheck</div>}
        {rules.map((r, i) => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', padding: '0.7rem 0.9rem', borderBottom: i < rules.length-1 ? '1px solid var(--border)' : 'none', gap: '0.6rem' }}>
            <span>{r.account?.icon || '🏦'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {renamingRule === r.id ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <input value={ruleNameVal} onChange={e => setRuleNameVal(e.target.value)} autoFocus
                    onKeyDown={e => { if (e.key === 'Enter') saveRuleName(r.id); if (e.key === 'Escape') { setRenamingRule(null); setRuleNameVal('') } }}
                    style={{ width: '9rem', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: '4px', padding: '0.15rem 0.35rem', color: 'var(--text)', fontSize: '0.8rem', outline: 'none' }} />
                  <button onClick={() => saveRuleName(r.id)} style={{ background: 'var(--green)', border: 'none', borderRadius: '3px', color: 'var(--onAccent)', fontSize: '0.55rem', padding: '0.1rem 0.3rem', fontWeight: 700 }}>✓</button>
                  <button onClick={() => { setRenamingRule(null); setRuleNameVal('') }} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--muted)', fontSize: '0.55rem', padding: '0.1rem 0.3rem' }}>✕</button>
                </span>
              ) : (
                <div onClick={() => { setRenamingRule(r.id); setRuleNameVal(r.name) }} title="Tap to rename"
                  style={{ fontSize: '0.82rem', color: 'var(--text)', cursor: 'pointer' }}>{r.name}</div>
              )}
              <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>{r.account?.name}</div>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', color: r.account?.color || 'var(--accentL)' }}>{fmt(r.amount)}</span>
            <button onClick={() => deleteRule(r.id)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.9rem', padding: '0.2rem 0.4rem' }}>✕</button>
          </div>
        ))}
      </div>

      {/* Paycheck history */}
      <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.5rem' }}>Recent Paychecks</h2>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        {paychecks.length === 0 && <div style={{ fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center', padding: '1.5rem' }}>No paychecks processed yet</div>}
        {paychecks.map((p, i) => (
          <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.65rem 0.9rem', borderBottom: i < paychecks.length-1 ? '1px solid var(--border)' : 'none' }}>
            <div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text)' }}>{format(new Date(p.date + 'T12:00'), 'MMM d, yyyy')}</div>
              {p.notes && <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>{p.notes}</div>}
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.88rem', color: 'var(--green)' }}>+{fmt(p.net_amount)}</span>
          </div>
        ))}
      </div>

      {/* Add rule modal */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setShowAdd(false) }}>
          <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '1rem' }}>New Allocation Rule</div>
            {[
              { l: 'Rule Name', k: 'name', p: 'e.g. RV Emergency Fund' },
              { l: 'Amount per Paycheck', k: 'amount', p: '150', type: 'number' },
            ].map(f => (
              <div key={f.k} style={{ marginBottom: '0.75rem' }}>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{f.l}</label>
                <input type={f.type || 'text'} value={form[f.k] || ''} onChange={e => setForm(x => ({ ...x, [f.k]: e.target.value }))} placeholder={f.p}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }} />
              </div>
            ))}
            <div style={{ marginBottom: '0.85rem' }}>
              <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Destination Account</label>
              <select value={form.account_id || ''} onChange={e => setForm(x => ({ ...x, account_id: e.target.value }))}
                style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }}>
                <option value="">Select account…</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
              </select>
            </div>
            <button onClick={addRule} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>Add Rule</button>
          </div>
        </div>
      )}

      {/* Process paycheck modal */}
      {showPaycheck && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setShowPaycheck(false) }}>
          <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--green)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--green)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.25rem' }}>Process Paycheck</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '1rem' }}>This will apply all allocation rules and update account balances.</div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Net Paycheck Amount</label>
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--green)', borderRadius: '8px', padding: '0 0.85rem', marginBottom: '1rem' }}>
              <span style={{ color: 'var(--green)', fontSize: '1.1rem', marginRight: '0.3rem' }}>$</span>
              <input type="number" value={paycheckAmt} onChange={e => setPaycheckAmt(e.target.value)} autoFocus
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--green)', fontSize: '1.3rem', fontFamily: 'var(--font-mono)', padding: '0.55rem 0' }} />
            </div>
            <div style={{ background: 'var(--bg)', borderRadius: '7px', padding: '0.75rem', marginBottom: '1rem', fontSize: '0.78rem' }}>
              {rules.map(r => {
                const alloc = r.is_percentage ? (paycheckAmt * r.amount / 100) : r.amount
                return (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.2rem 0', color: 'var(--muted)' }}>
                    <span>{r.account?.icon} {r.name}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accentL)' }}>{fmt(alloc)}</span>
                  </div>
                )
              })}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0', marginTop: '0.3rem', borderTop: '1px solid var(--border)', color: 'var(--muted)' }}>
                <span>💳 Remainder → Checking</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>{fmt(Math.max(0, +paycheckAmt - totalAllocated))}</span>
              </div>
            </div>
            <button onClick={processPaycheck} disabled={processing} style={{ width: '100%', background: 'var(--green)', border: 'none', borderRadius: '8px', padding: '0.85rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
              {processing ? 'Processing…' : '▶ Confirm & Process'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
