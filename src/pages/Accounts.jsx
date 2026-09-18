import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format } from 'date-fns'
import { linesPerAccount, anchorsFor, spendSinceAnchor, allocatedSinceAnchor, fundBalance, accountReconciliation } from '../lib/funds'
import BalanceProjection from '../components/BalanceProjection'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()

export default function Accounts() {
  const { household, user } = useAuth()
  const [accounts, setAccounts] = useState([])
  const [items, setItems]       = useState([])   // budget lines, for the envelope split
  const [balances, setBalances] = useState({})   // budget_item_id -> what it holds today
  const [modal, setModal]       = useState(null)  // 'add' | 'transfer' | 'edit'
  const [form, setForm]         = useState({})
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [err, setErr]           = useState('')

  // --- Assign an account's real balance across the lines that live in it ----
  // Writes each line's stated balance (saved_so_far / saved_as_of, migration
  // 009) — the same true-up used on the Dashboard, applied to a whole account
  // at once. Each row saves on its own, like the paycheck sheet.
  const [assignAcc, setAssignAcc]       = useState(null)
  const [assignRows, setAssignRows]     = useState([])
  const [assignStatus, setAssignStatus] = useState('clean')
  const [assignErr, setAssignErr]       = useState('')
  const assignRowsRef = useRef([])
  const assignSavedRef = useRef({})     // budget_item_id -> last written amount
  const assignTimer   = useRef(null)
  const assignQueue   = useRef(Promise.resolve())

  useEffect(() => { assignRowsRef.current = assignRows }, [assignRows])
  useEffect(() => () => clearTimeout(assignTimer.current), [])

  useEffect(() => { if (household) load() }, [household])

  useEffect(() => {
    if (!household) return
    // Balances are derived from transactions now, so changes there move the
    // numbers on this page just as much as changes to accounts do.
    const sub = supabase.channel('accounts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts', filter: `household_id=eq.${household.id}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions', filter: `household_id=eq.${household.id}` }, () => load())
      // ...and so do the budget lines, which decide how each balance is split up
      .on('postgres_changes', { event: '*', schema: 'public', table: 'budget_items', filter: `household_id=eq.${household.id}` }, () => load())
      .subscribe()
    return () => sub.unsubscribe()
  }, [household])

  async function load() {
    // accounts_with_balance derives `balance` from transaction history (012)
    const [{ data, error }, { data: bi }, { data: allocs }, { data: exp }, { data: firstTxn }] = await Promise.all([
      supabase.from('accounts_with_balance').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      // Balance fields for the envelope split, plus the schedule fields the
      // projection walks forward (due dates, intervals, accrual).
      supabase.from('budget_items').select('id, name, account_id, is_remainder_target, saved_so_far, saved_as_of, budgeted_amount, bill_amount, interval_months, bill_frequency, due_day, next_due_date, last_paid_date, auto_accrue, account:accounts(id, name, type), category:budget_categories(icon)').eq('household_id', household.id).eq('is_active', true),
      supabase.from('paycheck_allocations').select('budget_item_id, amount, date').eq('household_id', household.id),
      supabase.from('transactions').select('budget_item_id, budget_month, amount, date').eq('household_id', household.id).eq('type', 'expense'),
      supabase.from('transactions').select('budget_month').eq('household_id', household.id).order('budget_month', { ascending: true }).limit(1),
    ])
    if (error) setErr(`Couldn't load accounts: ${error.message}`)
    else setErr('')

    // Envelope balances as of today — the same arithmetic the Dashboard uses,
    // just not scoped to a month you're browsing (src/lib/funds.js).
    const appStart = firstTxn?.[0]?.budget_month || format(new Date(), 'yyyy-MM')
    const { itemAnchor, savedAsOf } = anchorsFor(bi, appStart)
    const spent      = spendSinceAnchor(exp, itemAnchor, savedAsOf)
    const allocated  = allocatedSinceAnchor(allocs, savedAsOf)
    const perAccount = linesPerAccount(bi)
    const accountBalance = {}
    ;(data || []).forEach(a => { accountBalance[a.id] = +a.balance })

    const bal = {}
    for (const it of bi || []) {
      bal[it.id] = fundBalance(it, {
        allocated: allocated[it.id] || 0,
        spent: spent[it.id] || 0,
        accountBalance, perAccount,
      })
    }

    setAccounts(data || [])
    setItems(bi || [])
    setBalances(bal)
    setLoading(false)
  }

  async function addAccount() {
    if (!form.name || !household) return
    setSaving(true)
    await supabase.from('accounts').insert({
      household_id: household.id,
      name: form.name,
      type: form.type || 'checking',
      icon: form.icon || '🏦',
      color: form.color || '#4a9a7a',
      target_balance: form.target ? +form.target : null,
      opening_balance: form.balance ? +form.balance : 0,
      sort_order: accounts.length + 1,
    })
    setSaving(false); setModal(null); setForm({})
  }

  // Balances are derived (opening_balance + history), so "true up" means
  // solving for the opening balance that makes today's derived figure match
  // what the user says is really there — the same plug migration 012 used.
  async function saveTrueUp() {
    const acc = modal === 'trueup' ? form.acc : null
    if (!acc) return
    setSaving(true)

    const patch = {}

    // An account's name is its own record — renaming the matching budget line
    // does not touch it, so it has to be editable here.
    const newName = (form.name ?? '').trim()
    if (newName && newName !== acc.name) patch.name = newName

    // Balance is derived (opening_balance + history), so "true up" means
    // solving for the opening balance that makes today's figure match what the
    // user says is really there — the plug technique from migration 012.
    if (form.actual !== '' && form.actual != null) {
      const txnEffect = +acc.balance - (+acc.opening_balance || 0)
      patch.opening_balance = Math.round((+form.actual - txnEffect) * 100) / 100
    }

    if (Object.keys(patch).length === 0) { setSaving(false); setModal(null); setForm({}); return }

    const { error } = await supabase.from('accounts').update(patch).eq('id', acc.id)
    if (error) {
      setErr(`Couldn't update ${acc.name}: ${error.message}`)
      setSaving(false)
      return
    }
    setSaving(false); setModal(null); setForm({}); load()
  }

  // Open the assign sheet for one account, pre-filled with what each line in it
  // currently holds — so leaving a row alone means "yes, that's right".
  function openAssign(acc) {
    const lines = items.filter(i => (i.account_id || i.account?.id) === acc.id)
    const rows = lines
      .map(i => ({ id: i.id, name: i.name, icon: i.category?.icon || '📋', amount: String(balances[i.id] ?? 0) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    assignSavedRef.current = Object.fromEntries(rows.map(r => [r.id, +r.amount || 0]))
    setAssignRows(rows)
    setAssignAcc(acc)
    setAssignErr('')
    setAssignStatus('clean')
  }

  // Stating a line's balance is a true-up: record the figure and the date it was
  // true as of. Everything allocated or spent before that date stops counting,
  // which is what makes the number you typed the number you see.
  async function writeAssignRows() {
    if (!assignAcc) return true
    const rows = assignRowsRef.current
    if (!rows.length) return true

    const claimed = rows.reduce((s, r) => s + (+r.amount || 0), 0)
    if (claimed - (+assignAcc.balance || 0) > 0.005) { setAssignStatus('blocked'); return false }

    const changed = rows.filter(r => (assignSavedRef.current[r.id] ?? null) !== (+r.amount || 0))
    if (!changed.length) { setAssignStatus(s => s === 'clean' ? 'clean' : 'saved'); return true }

    setAssignStatus('saving')
    const today = format(new Date(), 'yyyy-MM-dd')
    for (const r of changed) {
      const { error } = await supabase.from('budget_items')
        .update({ saved_so_far: +r.amount || 0, saved_as_of: today })
        .eq('id', r.id)
      if (error) {
        setAssignErr(`Couldn't save ${r.name}: ${error.message} — your numbers are still on screen.`)
        setAssignStatus('pending')
        return false
      }
      assignSavedRef.current[r.id] = +r.amount || 0
    }
    setAssignErr('')
    setAssignStatus('saved')
    return true
  }

  const assignFlushRef = useRef(writeAssignRows)
  useEffect(() => { assignFlushRef.current = writeAssignRows })

  const flushAssign = useCallback(() => {
    clearTimeout(assignTimer.current)
    const next = assignQueue.current.then(() => assignFlushRef.current())
    assignQueue.current = next.catch(() => {})
    return next
  }, [])

  const scheduleAssign = useCallback(() => {
    clearTimeout(assignTimer.current)
    setAssignStatus('pending')
    assignTimer.current = setTimeout(() => flushAssign(), 700)
  }, [flushAssign])

  async function closeAssign() {
    const ok = await flushAssign()
    if (!ok) return
    setAssignAcc(null)
    setAssignStatus('clean')
    load()
  }

  async function doTransfer() {
    if (!form.from || !form.to || !form.amount || form.from === form.to) return
    setSaving(true)
    const amt = +form.amount
    const today = format(new Date(), 'yyyy-MM-dd')
    const month = format(new Date(), 'yyyy-MM')
    const fromAcc = accounts.find(a => a.id === form.from)
    const toAcc   = accounts.find(a => a.id === form.to)

    // The transfer row is the whole record — both balances derive from it (012)
    const { error } = await supabase.from('transactions').insert({
      household_id: household.id,
      account_id: form.from,
      to_account_id: form.to,
      type: 'transfer',
      amount: amt,
      description: form.note || `Transfer: ${fromAcc?.name} → ${toAcc?.name}`,
      date: today, budget_month: month,
      created_by: user.id,
    })

    if (error) {
      setErr(`Transfer failed: ${error.message}`)
      setSaving(false)
      return
    }

    setSaving(false); setModal(null); setForm({}); load()
  }

  const totalBalance = accounts.reduce((s, a) => s + +a.balance, 0)
  const perAccount   = linesPerAccount(items)
  const checking     = accounts.find(a => a.type === 'checking') || null

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      {err && (
        <div style={{ background: 'var(--dangerBg)', border: '1px solid var(--red)', borderRadius: '8px', padding: '0.6rem 0.75rem', marginBottom: '0.85rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.85rem' }}>⚠️</span>
          <div style={{ flex: 1, fontSize: '0.72rem', color: 'var(--text)', lineHeight: 1.45 }}>{err}</div>
          <button onClick={() => setErr('')} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.9rem', lineHeight: 1, padding: 0 }}>×</button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--accent)', textTransform: 'uppercase' }}>Accounts</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)' }}>Total: {fmt(totalBalance)}</div>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={() => { setModal('transfer'); setForm({}) }} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '7px', padding: '0.45rem 0.75rem', fontSize: '0.78rem' }}>↔ Transfer</button>
          <button onClick={() => { setModal('add'); setForm({ type: 'checking', icon: '🏦' }) }} style={{ background: 'var(--accent)', border: 'none', color: 'var(--onAccent)', borderRadius: '7px', padding: '0.45rem 0.75rem', fontSize: '0.78rem', fontWeight: 700 }}>+ Add</button>
        </div>
      </div>

      {/* Where checking is headed, from the bills and paydays already scheduled */}
      <BalanceProjection household={household} checking={checking} items={items} startBalance={+checking?.balance || 0} />

      {/* Account cards */}
      <div style={{ display: 'grid', gap: '0.6rem' }}>
        {accounts.map(a => {
          const pct = a.target_balance ? Math.min((+a.balance / +a.target_balance) * 100, 100) : null
          const rec = accountReconciliation(a, items, balances, perAccount)
          return (
            <div key={a.id} onClick={() => { setModal('trueup'); setForm({ acc: a, name: a.name, actual: String(Math.round(+a.balance * 100) / 100) }) }}
              role="button" title="Rename or set the real balance"
              style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: pct !== null ? '0.6rem' : 0 }}>
                <span style={{ fontSize: '1.3rem' }}>{a.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>{a.name}</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{a.type}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', fontWeight: 500, color: a.color || 'var(--accentL)' }}>{fmt(a.balance)}</div>
                  {a.target_balance && <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>of {fmt(a.target_balance)}</div>}
                </div>
              </div>
              {pct !== null && (
                <div>
                  <div style={{ background: 'var(--border)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: a.color || 'var(--green)', borderRadius: '4px', transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--muted)', marginTop: '0.25rem' }}>{Math.round(pct)}% of goal</div>
                </div>
              )}

              {/* What the budget lines in this account claim, against what it
                  really holds. A sole-occupant fund account is its own envelope
                  (014) and is exactly assigned by definition, so it says so
                  rather than showing an always-zero figure. */}
              {rec.lines.length > 0 && (
                <div style={{ marginTop: '0.7rem', paddingTop: '0.6rem', borderTop: '1px solid var(--hairline)' }}>
                  {rec.sole ? (
                    <div style={{ fontSize: '0.62rem', color: 'var(--muted)' }}>
                      Holds one budget line — <b style={{ color: 'var(--text)' }}>{rec.lines[0].name}</b>. The account balance <i>is</i> that fund.
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--muted)' }}>
                        <span>{rec.lines.length} budget line{rec.lines.length === 1 ? '' : 's'} · assigned {fmt(rec.assigned)}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: rec.unassigned < 0 ? 'var(--red)' : rec.unassigned === 0 ? 'var(--green)' : 'var(--amber)' }}>
                          {rec.unassigned < 0 ? 'over by ' : 'unassigned '}{fmt(rec.unassigned)}
                        </span>
                      </div>
                      <button onClick={e => { e.stopPropagation(); openAssign(a) }}
                        style={{ marginTop: '0.5rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.35rem 0.6rem', color: 'var(--muted)', fontSize: '0.68rem' }}>
                        Assign balance
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Assign this account's real balance across the lines that live in it */}
      {assignAcc && (() => {
        const claimed    = assignRows.reduce((s, r) => s + (+r.amount || 0), 0)
        const unassigned = Math.round(((+assignAcc.balance || 0) - claimed) * 100) / 100
        const edit = (id, val) => {
          setAssignRows(rows => rows.map(r => r.id === id ? { ...r, amount: val } : r))
          scheduleAssign()
        }
        const status = {
          clean: null,
          pending: { text: 'Saving…', c: 'var(--muted)' },
          saving:  { text: 'Saving…', c: 'var(--muted)' },
          saved:   { text: '✓ Saved', c: 'var(--green)' },
          blocked: { text: 'Not saved — over', c: 'var(--red)' },
        }[assignStatus]
        return (
          // No click-to-dismiss, same as the paycheck sheet — closes from Done or ✕.
          <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.1rem 1.1rem 1.6rem', width: '100%', maxWidth: '600px', margin: '0 auto', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
                <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.35rem' }}>Assign balance</div>
                <button onClick={closeAssign} aria-label="Close"
                  style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '1.1rem', lineHeight: 1, padding: '0 0.2rem' }}>✕</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.6rem' }}>
                <div style={{ fontSize: '0.95rem', color: 'var(--text)' }}>{assignAcc.icon} {assignAcc.name} · {fmt(assignAcc.balance)}</div>
                {status && <div style={{ fontSize: '0.6rem', color: status.c, whiteSpace: 'nowrap' }}>{status.text}</div>}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', background: 'var(--bg)', border: `1px solid ${unassigned < 0 ? 'var(--red)' : unassigned === 0 ? 'var(--green)' : 'var(--border)'}`, borderRadius: '8px', padding: '0.6rem 0.8rem', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  {unassigned < 0 ? 'Over-assigned' : 'Unassigned'}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1.15rem', color: unassigned < 0 ? 'var(--red)' : unassigned === 0 ? 'var(--green)' : 'var(--accentL)' }}>
                  {unassigned < 0 ? '-' : ''}{fmt(unassigned)}
                </span>
              </div>

              {assignErr && <div style={{ fontSize: '0.7rem', color: 'var(--red)', marginBottom: '0.5rem' }}>⚠️ {assignErr}</div>}

              <div style={{ flex: 1, overflowY: 'auto', marginBottom: '0.75rem', border: '1px solid var(--border)', borderRadius: '8px' }}>
                {assignRows.map((r, i) => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.45rem 0.7rem', borderBottom: i < assignRows.length - 1 ? '1px solid var(--hairline)' : 'none' }}>
                    <span style={{ fontSize: '0.85rem' }}>{r.icon}</span>
                    <div style={{ flex: 1, minWidth: 0, fontSize: '0.76rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0 0.4rem' }}>
                      <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>$</span>
                      <input type="number" step="0.01" value={r.amount}
                        onChange={e => edit(r.id, e.target.value)} onBlur={flushAssign}
                        style={{ width: '4.6rem', background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '0.82rem', fontFamily: 'var(--font-mono)', padding: '0.35rem 0', textAlign: 'right' }} />
                    </div>
                  </div>
                ))}
              </div>

              <button onClick={closeAssign} disabled={unassigned < 0}
                style={{ background: unassigned < 0 ? 'var(--border)' : 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.7rem', color: unassigned < 0 ? 'var(--muted)' : 'var(--onAccent)', fontWeight: 700, fontSize: '0.85rem' }}>
                Done
              </button>
              <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textAlign: 'center', marginTop: '0.5rem', lineHeight: 1.45 }}>
                {unassigned < 0
                  ? 'These lines claim more than the account holds — nothing is saved until they fit.'
                  : 'Each amount saves as you enter it, and becomes that fund’s balance as of today. Nothing moves at the bank.'}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Modal */}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) { setModal(null); setForm({}) } }}>
          <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.25rem' }}>{modal === 'add' ? 'New Account' : modal === 'trueup' ? 'True up balance' : 'Transfer Funds'}</div>

            {modal === 'trueup' && form.acc && (
              <>
                <div style={{ fontSize: '1rem', color: 'var(--text)', marginBottom: '0.85rem' }}>{form.acc.icon} {form.acc.name}</div>

                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Account name</label>
                <input value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Lincoln's Savings"
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none', marginBottom: '0.85rem' }} />

                <div style={{ fontSize: '0.72rem', color: 'var(--muted)', lineHeight: 1.5, marginBottom: '1rem' }}>
                  Showing <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{fmt(form.acc.balance)}</b> from an opening balance of {fmt(form.acc.opening_balance || 0)} plus everything logged since.
                  Enter what the account really holds and the opening balance is adjusted to match — your transaction history is left alone.
                </div>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Actual balance today</label>
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: '8px', padding: '0 0.85rem', marginBottom: '1rem' }}>
                  <span style={{ color: 'var(--accentL)', fontSize: '1.1rem', marginRight: '0.3rem' }}>$</span>
                  <input type="number" step="0.01" value={form.actual ?? ''} autoFocus onChange={e => setForm(f => ({ ...f, actual: e.target.value }))} placeholder="0.00"
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '1.3rem', fontFamily: 'var(--font-mono)', padding: '0.55rem 0' }} />
                </div>
                <button onClick={saveTrueUp} disabled={saving || form.actual === ''}
                  style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
                  {saving ? 'Saving…' : 'Save balance'}
                </button>
              </>
            )}

            {modal === 'add' && (
              <>
                {[
                  { l: 'Account Name', k: 'name', p: 'e.g. Emergency Fund' },
                  { l: 'Starting Balance', k: 'balance', p: '0', type: 'number' },
                  { l: 'Goal / Target (optional)', k: 'target', p: '10000', type: 'number' },
                  { l: 'Icon (emoji)', k: 'icon', p: '🏦' },
                  { l: 'Color (hex)', k: 'color', p: '#4a9a7a' },
                ].map(f => (
                  <div key={f.k} style={{ marginBottom: '0.75rem' }}>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{f.l}</label>
                    <input type={f.type || 'text'} value={form[f.k] || ''} onChange={e => setForm(x => ({ ...x, [f.k]: e.target.value }))} placeholder={f.p}
                      style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }} />
                  </div>
                ))}
                <div style={{ marginBottom: '0.75rem' }}>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Account Type</label>
                  <select value={form.type || 'checking'} onChange={e => setForm(x => ({ ...x, type: e.target.value }))}
                    style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }}>
                    <option value="checking">Checking</option>
                    <option value="savings">Savings</option>
                    <option value="fund">Fund / Goal</option>
                  </select>
                </div>
                <button onClick={addAccount} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
                  {saving ? 'Saving…' : 'Add Account'}
                </button>
              </>
            )}

            {modal === 'transfer' && (
              <>
                {[
                  { l: 'From Account', k: 'from', type: 'select' },
                  { l: 'To Account', k: 'to', type: 'select' },
                  { l: 'Amount', k: 'amount', p: '0', type: 'number' },
                  { l: 'Note (optional)', k: 'note', p: 'e.g. Monthly savings allocation' },
                ].map(f => (
                  <div key={f.k} style={{ marginBottom: '0.75rem' }}>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{f.l}</label>
                    {f.type === 'select' ? (
                      <select value={form[f.k] || ''} onChange={e => setForm(x => ({ ...x, [f.k]: e.target.value }))}
                        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }}>
                        <option value="">Select account…</option>
                        {accounts.map(a => <option key={a.id} value={a.id}>{a.icon} {a.name} ({fmt(a.balance)})</option>)}
                      </select>
                    ) : (
                      <input type={f.type || 'text'} value={form[f.k] || ''} onChange={e => setForm(x => ({ ...x, [f.k]: e.target.value }))} placeholder={f.p}
                        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }} />
                    )}
                  </div>
                ))}
                <button onClick={doTransfer} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
                  {saving ? 'Processing…' : 'Transfer Funds'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
