import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, startOfDay } from 'date-fns'
import { computeAccrual, isAutoAccrued } from '../lib/accrual'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()

const FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Bi-Weekly', semimonthly: 'Semi-Monthly', monthly: 'Monthly' }

// How much of one check a monthly plan implies. Approximate by design — it is
// a starting suggestion you then adjust, not a rule.
const CHECKS_PER_MONTH = { weekly: 4, biweekly: 2, semimonthly: 2, monthly: 1 }

export default function Allocations() {
  const { household, user } = useAuth()
  const [accounts, setAccounts]   = useState([])
  const [paychecks, setPaychecks] = useState([])
  const [items, setItems]         = useState([])
  const [showPaycheck, setShowPaycheck] = useState(false)
  const [paycheckAmt, setPaycheckAmt] = useState(household?.paycheck_amount || 4212)
  const [processing, setProcessing] = useState(false)
  const [processErr, setProcessErr] = useState('')
  const [loading, setLoading]     = useState(true)
  const [showDistribute, setShowDistribute] = useState(false)
  const [distPaycheck, setDistPaycheck]     = useState(null)
  const [distRows, setDistRows]   = useState([])
  const [distSaving, setDistSaving] = useState(false)
  const [distErr, setDistErr]     = useState('')

  useEffect(() => { if (household) load() }, [household])

  async function load() {
    const [{ data: a }, { data: p }, { data: bi }] = await Promise.all([
      supabase.from('accounts').select('id, name, icon, type, sort_order').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('paychecks').select('*').eq('household_id', household.id).order('date', { ascending: false }).limit(6),
      // Budget lines with the account each one lives in (014)
      supabase.from('budget_items')
        .select('id, name, budgeted_amount, bill_amount, interval_months, last_paid_date, next_due_date, auto_accrue, saved_so_far, saved_as_of, account_id, is_remainder_target, category:budget_categories(name, icon, sort_order)')
        .eq('household_id', household.id).eq('is_active', true),
    ])
    setAccounts(a || [])
    setPaychecks(p || [])
    setItems(bi || [])
    setLoading(false)
  }

  const checking = accounts.find(a => a.type === 'checking') || null
  const remainderLine = items.find(i => i.is_remainder_target) || null

  function suggestedFor(item) {
    const perMonth = isAutoAccrued(item)
      ? (computeAccrual(item)?.accrual ?? +item.budgeted_amount)
      : +item.budgeted_amount
    const checks = CHECKS_PER_MONTH[household?.pay_frequency || 'biweekly'] || 2
    return Math.round((perMonth / checks) * 100) / 100
  }

  // The plan applied to one paycheck: every line at its suggested share, and
  // whatever is left lands in the remainder line so every dollar has a job.
  // The remainder line's own suggestion is shown for reference only — it
  // absorbs the leftover, plan or not.
  function planRows(netAmount, already = {}) {
    const rows = items.map(i => ({
      id: i.id,
      name: i.name,
      icon: i.category?.icon || '📋',
      catSort: i.category?.sort_order ?? 99,
      suggested: suggestedFor(i),
      accountId: i.account_id,
      ownAccount: !!(i.account_id && checking && i.account_id !== checking.id),
      isRemainder: !!i.is_remainder_target,
      amount: '',
    })).sort((a, b) => (a.isRemainder - b.isRemainder) || a.catSort - b.catSort || a.name.localeCompare(b.name))

    const hasExisting = Object.keys(already).length > 0
    let assigned = 0
    for (const r of rows) {
      if (r.isRemainder) continue
      const v = hasExisting ? (already[r.id] ?? 0) : r.suggested
      r.amount = String(v)
      assigned += +v
    }
    const target = rows.find(r => r.isRemainder)
    if (target) {
      target.amount = hasExisting
        ? String(already[target.id] ?? 0)
        : String(Math.max(0, Math.round((netAmount - assigned) * 100) / 100))
    }
    return rows
  }

  // Re-derive the remainder line from the other rows as they're edited
  function withRemainder(rows, netAmount) {
    const target = rows.find(r => r.isRemainder)
    if (!target) return rows
    const others = rows.filter(r => !r.isRemainder).reduce((s, r) => s + (+r.amount || 0), 0)
    const left = Math.max(0, Math.round((netAmount - others) * 100) / 100)
    return rows.map(r => r.isRemainder ? { ...r, amount: String(left) } : r)
  }

  // Open the distribute sheet for a paycheck, pre-filled with whatever is
  // already allocated to it, falling back to the plan.
  async function openDistribute(paycheck) {
    setDistPaycheck(paycheck)
    setDistErr('')
    const { data: existing } = await supabase
      .from('paycheck_allocations')
      .select('budget_item_id, amount')
      .eq('paycheck_id', paycheck.id)
    const already = {}
    existing?.forEach(e => { already[e.budget_item_id] = (already[e.budget_item_id] || 0) + +e.amount })
    setDistRows(planRows(+paycheck.net_amount, already))
    setShowDistribute(true)
  }

  // Replace this paycheck's distribution wholesale. Two kinds of record:
  //   * a paycheck_allocations row per funded line (the envelope entry), and
  //   * for a line that lives in its own account, a real transfer from checking
  //     to that account, tagged with the paycheck so it can be replaced too.
  // Moves between funds carry no paycheck_id and are untouched by this.
  async function saveDistribution() {
    if (!distPaycheck) return
    setDistSaving(true)
    const pid = distPaycheck.id
    const date = distPaycheck.date
    const month = String(date).slice(0, 7)

    await supabase.from('paycheck_allocations').delete().eq('paycheck_id', pid)
    await supabase.from('transactions').delete().eq('paycheck_id', pid).eq('type', 'transfer')

    const funded = distRows.filter(r => +r.amount > 0)

    const allocRows = funded.map(r => ({
      household_id: household.id,
      paycheck_id: pid,
      budget_item_id: r.id,
      amount: +r.amount,
      date, budget_month: month,
      created_by: user.id,
      note: 'Paycheck allocation',
    }))
    if (allocRows.length) {
      const { error } = await supabase.from('paycheck_allocations').insert(allocRows)
      if (error) { setDistErr(`Couldn't save: ${error.message}`); setDistSaving(false); return }
    }

    const transferRows = checking
      ? funded.filter(r => r.ownAccount).map(r => ({
          household_id: household.id,
          paycheck_id: pid,
          budget_item_id: r.id,
          account_id: checking.id,
          to_account_id: r.accountId,
          type: 'transfer',
          amount: +r.amount,
          description: `Funding: ${r.name}`,
          date, budget_month: month,
          created_by: user.id,
        }))
      : []
    if (transferRows.length) {
      const { error } = await supabase.from('transactions').insert(transferRows)
      if (error) { setDistErr(`Envelopes saved, but the transfers didn't: ${error.message}`); setDistSaving(false); return }
    }

    setDistErr('')
    setDistSaving(false)
    setShowDistribute(false)
    load()
  }

  // A paycheck is income into checking. Log it, then hand straight to the
  // distribute sheet pre-filled at plan with the leftover already assigned, so
  // the usual case is: glance, adjust anything, save.
  async function processPaycheck() {
    if (!paycheckAmt || processing) return
    if (!checking) { setProcessErr('Add a checking account first — the paycheck has to land somewhere.'); return }
    setProcessing(true); setProcessErr('')

    const today = format(new Date(), 'yyyy-MM-dd')
    const month = today.slice(0, 7)
    const amt   = +paycheckAmt

    // paychecks has only net_amount — the original code also sent gross_amount,
    // which does not exist, and since it never checked the error this insert
    // had silently failed on every paycheck since launch.
    const { data: pc, error: pcErr } = await supabase.from('paychecks').insert({
      household_id: household.id,
      net_amount: amt,
      date: today,
      created_by: user.id,
    }).select('*').single()
    if (pcErr || !pc) { setProcessErr(`Couldn't log the paycheck: ${pcErr?.message || 'unknown error'}`); setProcessing(false); return }

    const { error: incErr } = await supabase.from('transactions').insert({
      household_id: household.id,
      paycheck_id: pc.id,
      account_id: checking.id,
      type: 'income',
      amount: amt,
      description: 'Paycheck',
      date: today, budget_month: month,
      created_by: user.id,
    })
    if (incErr) { setProcessErr(`Paycheck logged, but the deposit into ${checking.name} failed: ${incErr.message}`); setProcessing(false); return }

    setProcessing(false)
    setShowPaycheck(false)
    await load()
    setDistPaycheck(pc)
    setDistRows(planRows(amt))
    setDistErr('')
    setShowDistribute(true)
  }

  // Summary of the plan for one check
  const perCheck = +(household?.paycheck_amount || 4212)
  const plannedOthers = items.filter(i => !i.is_remainder_target).reduce((s, i) => s + suggestedFor(i), 0)
  const plannedLeft = Math.round((perCheck - plannedOthers) * 100) / 100

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--accent)', textTransform: 'uppercase' }}>{FREQ_LABEL[household?.pay_frequency] || 'Bi-Weekly'}</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)' }}>Paycheck</div>
        </div>
        <button onClick={() => { setShowPaycheck(true); setProcessErr('') }} style={{ background: 'var(--green)', border: 'none', color: 'var(--onAccent)', borderRadius: '8px', padding: '0.5rem 1rem', fontWeight: 700, fontSize: '0.82rem' }}>▶ Process Paycheck</button>
      </div>

      {/* Plan summary for one check */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem', marginBottom: '1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem', textAlign: 'center', fontSize: '0.78rem' }}>
          {[
            { l: 'Per check', v: fmt(perCheck), c: 'var(--green)' },
            { l: 'Planned', v: fmt(plannedOthers), c: 'var(--accentL)' },
            { l: remainderLine ? `→ ${remainderLine.name}` : 'Unassigned', v: `${plannedLeft < 0 ? '-' : ''}${fmt(plannedLeft)}`, c: plannedLeft < 0 ? 'var(--red)' : 'var(--muted)' },
          ].map(x => (
            <div key={x.l}>
              <div style={{ fontSize: '0.6rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.2rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.l}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, color: x.c }}>{x.v}</div>
            </div>
          ))}
        </div>
        {plannedLeft < 0 && (
          <div style={{ fontSize: '0.66rem', color: 'var(--red)', marginTop: '0.6rem', lineHeight: 1.45 }}>
            The plan asks for more than one check brings in. Something has to give each payday — trim a line on Budget, or accept a deficit.
          </div>
        )}
        {!remainderLine && (
          <div style={{ fontSize: '0.66rem', color: 'var(--muted)', marginTop: '0.6rem', lineHeight: 1.45 }}>
            No line is set to receive the leftover. On Budget, tap ⤵ on the line that should (your Exit Fund).
          </div>
        )}
      </div>

      {/* Distribute sheet */}
      {showDistribute && distPaycheck && (() => {
        const net = +distPaycheck.net_amount
        const assigned = distRows.reduce((s, r) => s + (+r.amount || 0), 0)
        const left = Math.round((net - assigned) * 100) / 100
        const edit = (id, val) => setDistRows(rows => withRemainder(rows.map(x => x.id === id ? { ...x, amount: val } : x), net))
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
            onClick={e => { if (e.target === e.currentTarget) setShowDistribute(false) }}>
            <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--green)', borderRadius: '16px 16px 0 0', padding: '1.1rem 1.1rem 1.6rem', width: '100%', maxWidth: '600px', margin: '0 auto', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.35rem' }}>Distribute paycheck</div>
              <div style={{ fontSize: '0.95rem', color: 'var(--text)', marginBottom: '0.6rem' }}>
                {format(startOfDay(new Date(distPaycheck.date + 'T12:00')), 'EEE, MMM d')} · {fmt(net)}
              </div>

              {/* With a remainder line this is 0 by construction; it only goes
                  red when the other lines alone exceed the check. */}
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
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.45rem 0.7rem', borderBottom: i < distRows.length - 1 ? '1px solid var(--hairline)' : 'none', background: r.isRemainder ? 'var(--pinned)' : 'transparent' }}>
                    <span style={{ fontSize: '0.85rem' }}>{r.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.76rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.name}
                        {r.ownAccount && <span style={{ fontSize: '0.56rem', color: 'var(--muted)' }} title="Moves to its own account"> · moves</span>}
                        {r.isRemainder && <span style={{ fontSize: '0.56rem', color: 'var(--accent)' }}> · gets the leftover</span>}
                      </div>
                      {r.isRemainder ? (
                        <div style={{ fontSize: '0.58rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>plan {fmt(r.suggested)} · fills from what's left</div>
                      ) : (
                        <button onClick={() => edit(r.id, String(r.suggested))}
                          style={{ background: 'transparent', border: 'none', padding: 0, fontSize: '0.58rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                          suggested {fmt(r.suggested)}
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: `1px solid ${r.isRemainder ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '6px', padding: '0 0.4rem', opacity: r.isRemainder ? 0.85 : 1 }}>
                      <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>$</span>
                      <input type="number" step="0.01" value={r.amount} readOnly={r.isRemainder}
                        onChange={e => edit(r.id, e.target.value)}
                        style={{ width: '4.6rem', background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '0.82rem', fontFamily: 'var(--font-mono)', padding: '0.35rem 0', textAlign: 'right' }} />
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={() => setDistRows(planRows(net))}
                  style={{ flex: 1, background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.7rem', color: 'var(--muted)', fontSize: '0.8rem' }}>
                  Reset to plan
                </button>
                <button onClick={saveDistribution} disabled={distSaving || left < 0}
                  style={{ flex: 2, background: left < 0 ? 'var(--border)' : 'var(--green)', border: 'none', borderRadius: '8px', padding: '0.7rem', color: left < 0 ? 'var(--muted)' : 'var(--onAccent)', fontWeight: 700, fontSize: '0.85rem' }}>
                  {distSaving ? 'Saving…' : 'Save distribution'}
                </button>
              </div>
              <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textAlign: 'center', marginTop: '0.5rem', lineHeight: 1.45 }}>
                Lines marked "moves" transfer from {checking?.name || 'checking'} to their own account. Money you've moved between funds isn't affected.
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

      {/* Process paycheck modal */}
      {showPaycheck && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setShowPaycheck(false) }}>
          <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--green)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--green)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.25rem' }}>Process Paycheck</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '1rem', lineHeight: 1.5 }}>
              Deposits the check into <b style={{ color: 'var(--text)' }}>{checking?.name || 'checking'}</b>, then opens the split with every line at plan and the leftover already in {remainderLine ? <b style={{ color: 'var(--text)' }}>{remainderLine.name}</b> : 'the leftover line'}. Adjust anything, then save.
            </div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Net Paycheck Amount</label>
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--green)', borderRadius: '8px', padding: '0 0.85rem', marginBottom: '1rem' }}>
              <span style={{ color: 'var(--green)', fontSize: '1.1rem', marginRight: '0.3rem' }}>$</span>
              <input type="number" value={paycheckAmt} onChange={e => setPaycheckAmt(e.target.value)} autoFocus
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--green)', fontSize: '1.3rem', fontFamily: 'var(--font-mono)', padding: '0.55rem 0' }} />
            </div>
            {processErr && <div style={{ fontSize: '0.72rem', color: 'var(--red)', marginBottom: '0.75rem' }}>⚠️ {processErr}</div>}
            <button onClick={processPaycheck} disabled={processing} style={{ width: '100%', background: 'var(--green)', border: 'none', borderRadius: '8px', padding: '0.85rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
              {processing ? 'Processing…' : '▶ Deposit & Split'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
