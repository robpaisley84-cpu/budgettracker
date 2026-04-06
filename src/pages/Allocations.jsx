import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, addDays, nextDay, startOfDay } from 'date-fns'

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

  useEffect(() => { if (household) load() }, [household])

  async function load() {
    const [{ data: r }, { data: a }, { data: p }] = await Promise.all([
      supabase.from('allocation_rules').select('*, account:accounts(name,icon,color)').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('accounts').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('paychecks').select('*').eq('household_id', household.id).order('date', { ascending: false }).limit(6),
    ])
    setRules(r || [])
    setAccounts(a || [])
    setPaychecks(p || [])
    setLoading(false)
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

    // Process each allocation rule
    for (const rule of rules) {
      const alloc = rule.is_percentage ? (amt * rule.amount / 100) : rule.amount
      const acc   = accounts.find(a => a.id === rule.account_id)

      // Create allocation transaction
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

      // Update account balance
      if (acc) {
        await supabase.from('accounts').update({ balance: +acc.balance + alloc }).eq('id', acc.id)
      }
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
        await supabase.from('accounts').update({ balance: +checking.balance + remainder }).eq('id', checking.id)
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
        <button onClick={() => setShowPaycheck(true)} style={{ background: 'var(--green)', border: 'none', color: '#0d1a10', borderRadius: '8px', padding: '0.5rem 1rem', fontWeight: 700, fontSize: '0.82rem' }}>▶ Process Paycheck</button>
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
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.82rem', color: 'var(--text)' }}>{r.name}</div>
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setShowAdd(false) }}>
          <div style={{ background: '#1a2a1c', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
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
            <button onClick={addRule} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.9rem' }}>Add Rule</button>
          </div>
        </div>
      )}

      {/* Process paycheck modal */}
      {showPaycheck && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setShowPaycheck(false) }}>
          <div style={{ background: '#1a2a1c', borderTop: '2px solid var(--green)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
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
            <button onClick={processPaycheck} disabled={processing} style={{ width: '100%', background: 'var(--green)', border: 'none', borderRadius: '8px', padding: '0.85rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.9rem' }}>
              {processing ? 'Processing…' : '▶ Confirm & Process'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
