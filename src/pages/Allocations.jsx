import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, startOfDay } from 'date-fns'
import { paydaysBetween } from '../lib/projection'
import { planForCheck, lastPaymentFor } from '../lib/funding'
import { linesPerAccount, anchorsFor, spendSinceAnchor, allocatedSinceAnchor, fundBalance } from '../lib/funds'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()

const FREQ_LABEL = { weekly: 'Weekly', biweekly: 'Bi-Weekly', semimonthly: 'Semi-Monthly', monthly: 'Monthly' }


export default function Allocations() {
  const { household, user } = useAuth()
  const [accounts, setAccounts]   = useState([])
  const [paychecks, setPaychecks] = useState([])
  const [items, setItems]         = useState([])
  const [showPaycheck, setShowPaycheck] = useState(false)
  const [paycheckAmt, setPaycheckAmt] = useState(household?.paycheck_amount || 4212)
  const [payDate, setPayDate]         = useState(format(new Date(), 'yyyy-MM-dd'))
  const [processing, setProcessing] = useState(false)
  const [processErr, setProcessErr] = useState('')
  const [loading, setLoading]     = useState(true)
  const [showDistribute, setShowDistribute] = useState(false)
  const [distPaycheck, setDistPaycheck]     = useState(null)
  const [distRows, setDistRows]   = useState([])
  const [distSaving, setDistSaving] = useState(false)
  const [distErr, setDistErr]     = useState('')
  // 'clean' nothing to write · 'pending' edits waiting on the debounce ·
  // 'saving' · 'saved' · 'blocked' over-assigned, deliberately not written
  const [distStatus, setDistStatus] = useState('clean')
  // What payday just did, shown instead of making you fill the form in
  const [flash, setFlash] = useState(null)

  // --- Autosave plumbing for the distribute sheet -------------------------
  // The sheet used to hold every amount in React state until you pressed Save,
  // so one stray tap lost the lot. Now each row is written shortly after you
  // stop typing. These refs carry the bits the debounce needs without making
  // the timer restart on every render.
  //
  // savedRef: budget_item_id -> what is currently in the database for this
  // paycheck, and the row ids to update in place. Updating beats
  // delete-and-reinsert because both tables are audited (migration 007) and a
  // delete/insert pair per keystroke-pause would bury the Activity feed.
  const savedRef    = useRef({})
  const distRowsRef = useRef([])
  const timerRef    = useRef(null)
  const queueRef    = useRef(Promise.resolve())   // writes run one at a time

  useEffect(() => { distRowsRef.current = distRows }, [distRows])
  useEffect(() => () => clearTimeout(timerRef.current), [])

  useEffect(() => { if (household) load() }, [household])

  // The engine needs to know what each envelope already holds, so this page
  // loads the same ingredients Dashboard and Accounts do and runs them through
  // src/lib/funds.js. Kept as raw parts (not just totals) so a paycheck being
  // re-split can be excluded from "held" - otherwise its own allocations would
  // make every bill look already funded.
  const [ledger, setLedger] = useState(null)

  async function load() {
    const [{ data: a }, { data: p }, { data: bi }, { data: allocs }, { data: exp }, { data: firstTxn }] = await Promise.all([
      // accounts_with_balance so sole-occupant fund lines read their real balance (014)
      supabase.from('accounts_with_balance').select('id, name, icon, type, sort_order, balance').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('paychecks').select('*').eq('household_id', household.id).order('date', { ascending: false }).limit(6),
      supabase.from('budget_items')
        .select('id, name, budgeted_amount, per_check_amount, funding_mode, bill_amount, interval_months, due_day, last_paid_date, next_due_date, auto_accrue, saved_so_far, saved_as_of, account_id, is_remainder_target, account:accounts(id, name, type), category:budget_categories(name, icon, sort_order)')
        .eq('household_id', household.id).eq('is_active', true),
      supabase.from('paycheck_allocations').select('budget_item_id, amount, date, paycheck_id').eq('household_id', household.id),
      supabase.from('transactions').select('budget_item_id, budget_month, amount, date').eq('household_id', household.id).eq('type', 'expense'),
      supabase.from('transactions').select('budget_month').eq('household_id', household.id).order('budget_month', { ascending: true }).limit(1),
    ])
    const appStart = firstTxn?.[0]?.budget_month || format(new Date(), 'yyyy-MM')
    const { itemAnchor, savedAsOf } = anchorsFor(bi, appStart)
    const led = {
      allocs: allocs || [],
      spent: spendSinceAnchor(exp, itemAnchor, savedAsOf),
      // A bill paid early this cycle is funded toward the NEXT due date
      lastPaid: Object.fromEntries((bi || []).map(i => [i.id, lastPaymentFor(i, exp || [])])),
      savedAsOf,
      perAccount: linesPerAccount(bi),
      accountBalance: Object.fromEntries((a || []).map(x => [x.id, +x.balance])),
    }
    setAccounts(a || [])
    setPaychecks(p || [])
    setItems(bi || [])
    setLedger(led)
    setLoading(false)
    // Returned as well as stored: payday needs to build a split from these the
    // moment they land, and the state setters above won't have applied yet.
    return { accounts: a || [], paychecks: p || [], items: bi || [], ledger: led }
  }

  const checking = accounts.find(a => a.type === 'checking') || null
  const remainderLine = items.find(i => i.is_remainder_target) || null

  // What every envelope holds, optionally ignoring one paycheck's own allocations.
  function balancesFrom(itemsList, led, excludePaycheckId = null) {
    if (!led) return {}
    const allocated = allocatedSinceAnchor(
      excludePaycheckId ? led.allocs.filter(x => x.paycheck_id !== excludePaycheckId) : led.allocs,
      led.savedAsOf)
    const out = {}
    for (const it of itemsList) {
      out[it.id] = fundBalance(it, {
        allocated: allocated[it.id] || 0, spent: led.spent[it.id] || 0,
        accountBalance: led.accountBalance, perAccount: led.perAccount,
      })
    }
    return out
  }

  // The plan for one paycheck, from the engine: each scheduled bill gets what it
  // still needs by its due date split across the checks before then, each
  // flexible line gets its allowance, and the leftover lands in the remainder
  // line. `already` (an existing split) overrides the suggestions when present.
  function planRows({ net, date, already = {}, itemsList = items, checkingAcct = checking, led = ledger, excludePaycheckId = null }) {
    const rows = planForCheck(itemsList, {
      payday: new Date(String(date).slice(0, 10) + 'T12:00'),
      net,
      balances: balancesFrom(itemsList, led, excludePaycheckId),
      household,
      checkingId: checkingAcct?.id || null,
      lastPaid: led?.lastPaid || {},
    })
    if (Object.keys(already).length === 0) return rows
    for (const r of rows) r.amount = String(already[r.id] ?? 0)
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

  // Read back what is already stored for this paycheck: the envelope amount per
  // line, plus the ids of the rows holding it so autosave can update them
  // rather than recreate them. Historic data may hold more than one row per
  // line, so keep them all — the first is updated, the rest tidied away on the
  // next write.
  async function loadSaved(paycheckId) {
    const [{ data: allocs, error: aErr }, { data: txs, error: tErr }] = await Promise.all([
      supabase.from('paycheck_allocations').select('id, budget_item_id, amount').eq('paycheck_id', paycheckId),
      supabase.from('transactions').select('id, budget_item_id').eq('paycheck_id', paycheckId).eq('type', 'transfer'),
    ])
    if (aErr || tErr) return { saved: null, error: aErr || tErr }

    const saved = {}
    const entry = (id) => (saved[id] ||= { amount: 0, allocIds: [], txIds: [] })
    allocs?.forEach(a => {
      const e = entry(a.budget_item_id)
      e.amount += +a.amount
      e.allocIds.push(a.id)
    })
    txs?.forEach(t => { if (t.budget_item_id) entry(t.budget_item_id).txIds.push(t.id) })
    return { saved, error: null }
  }

  // Open the distribute sheet for a paycheck, pre-filled with whatever is
  // already allocated to it, falling back to the plan.
  async function openDistribute(paycheck) {
    setDistPaycheck(paycheck)
    setDistErr('')
    const { saved, error } = await loadSaved(paycheck.id)
    if (error) {
      // Opening on a bad read would show zeros and then autosave them over the
      // top of good data. Refuse instead.
      setDistErr(`Couldn't read this paycheck's split: ${error.message}`)
      savedRef.current = {}
      setDistRows([])
      setDistStatus('clean')
      setShowDistribute(true)
      return
    }
    savedRef.current = saved
    const already = {}
    Object.entries(saved).forEach(([id, e]) => { already[id] = e.amount })
    setDistRows(planRows({ net: +paycheck.net_amount, date: paycheck.date, already, excludePaycheckId: paycheck.id }))
    setDistStatus('clean')
    setShowDistribute(true)
  }

  // Write one line's share of this paycheck. Two kinds of record:
  //   * a paycheck_allocations row (the envelope entry), and
  //   * for a line that lives in its own account, a real transfer from checking
  //     to that account, tagged with the paycheck so it can be revised too.
  // Moves between funds carry no paycheck_id and are untouched by this.
  //
  // Existing rows are UPDATED, never delete-and-reinserted: both tables are
  // audited, and recreating them on every pause in typing would flood Activity
  // and churn real money in and out of the savings accounts mid-edit.
  // Returns a Supabase error, or null when the row is stored.
  async function persistRow(r, pid, date, month, saved = savedRef.current, checkingAcct = checking) {
    const prev   = saved[r.id]
    const target = Math.round((+r.amount || 0) * 100) / 100
    if (!prev && target === 0) return null        // nothing stored, nothing to store
    if (prev && prev.amount === target) return null

    // --- the envelope entry ---
    let allocIds = prev ? [...prev.allocIds] : []
    if (target > 0 && allocIds.length) {
      const [keep, ...extra] = allocIds
      const { error } = await supabase.from('paycheck_allocations')
        .update({ amount: target, date, budget_month: month }).eq('id', keep)
      if (error) return error
      if (extra.length) {
        const { error: dupErr } = await supabase.from('paycheck_allocations').delete().in('id', extra)
        if (dupErr) return dupErr
      }
      allocIds = [keep]
    } else if (target > 0) {
      const { data, error } = await supabase.from('paycheck_allocations').insert({
        household_id: household.id,
        paycheck_id: pid,
        budget_item_id: r.id,
        amount: target,
        date, budget_month: month,
        created_by: user.id,
        note: 'Paycheck allocation',
      }).select('id').single()
      if (error) return error
      allocIds = [data.id]
    } else if (allocIds.length) {
      const { error } = await supabase.from('paycheck_allocations').delete().in('id', allocIds)
      if (error) return error
      allocIds = []
    }

    // --- the real transfer, for a line backed by its own account ---
    let txIds = prev ? [...prev.txIds] : []
    const wantsTransfer = !!(checkingAcct && r.ownAccount && target > 0)
    if (wantsTransfer && txIds.length) {
      const [keep, ...extra] = txIds
      const { error } = await supabase.from('transactions').update({
        amount: target, to_account_id: r.accountId, account_id: checkingAcct.id,
        description: `Funding: ${r.name}`, date, budget_month: month,
      }).eq('id', keep)
      if (error) return error
      if (extra.length) {
        const { error: dupErr } = await supabase.from('transactions').delete().in('id', extra)
        if (dupErr) return dupErr
      }
      txIds = [keep]
    } else if (wantsTransfer) {
      const { data, error } = await supabase.from('transactions').insert({
        household_id: household.id,
        paycheck_id: pid,
        budget_item_id: r.id,
        account_id: checkingAcct.id,
        to_account_id: r.accountId,
        type: 'transfer',
        amount: target,
        description: `Funding: ${r.name}`,
        date, budget_month: month,
        created_by: user.id,
      }).select('id').single()
      if (error) return error
      txIds = [data.id]
    } else if (txIds.length) {
      const { error } = await supabase.from('transactions').delete().in('id', txIds)
      if (error) return error
      txIds = []
    }

    saved[r.id] = { amount: target, allocIds, txIds }
    return null
  }

  // Queue a write behind whatever is already running. Two writers at once would
  // race on the row ids in savedRef, and — more to the point — awaiting this has
  // to genuinely mean "everything typed so far is stored", or pressing Done
  // mid-save would close over an edit that never landed.
  function flushDistribution() {
    clearTimeout(timerRef.current)
    const next = queueRef.current.then(() => writeDirtyRows())
    queueRef.current = next.catch(() => {})   // one failure must not jam the queue
    return next
  }

  // Write every row that differs from what is stored. Returns false if anything
  // could not be written, so the caller knows not to close over unsaved numbers.
  async function writeDirtyRows() {
    if (!distPaycheck) return true
    const rows = distRowsRef.current
    if (!rows.length) return true

    // A half-typed number can briefly ask for more than the check holds. Hold
    // off rather than store a split that doesn't balance — the same guard the
    // Save button always had.
    const assigned = rows.reduce((s, r) => s + (+r.amount || 0), 0)
    if (assigned - +distPaycheck.net_amount > 0.005) { setDistStatus('blocked'); return false }

    const changed = rows.filter(r => {
      const prev = savedRef.current[r.id]
      const target = Math.round((+r.amount || 0) * 100) / 100
      return prev ? prev.amount !== target : target > 0
    })
    if (!changed.length) { setDistStatus(s => s === 'clean' ? 'clean' : 'saved'); return true }

    setDistSaving(true)
    setDistStatus('saving')
    const pid   = distPaycheck.id
    const date  = distPaycheck.date
    const month = String(date).slice(0, 7)

    let failure = null
    for (const r of changed) {
      failure = await persistRow(r, pid, date, month)
      if (failure) break
    }

    setDistSaving(false)
    if (failure) {
      setDistErr(`Couldn't save: ${failure.message} — your numbers are still on screen, try again.`)
      setDistStatus('pending')
      return false
    }
    setDistErr('')
    setDistStatus('saved')
    return true
  }

  // The debounce fires long after the render that scheduled it, so go through a
  // ref to reach the current closure rather than a stale one.
  const flushRef = useRef(flushDistribution)
  useEffect(() => { flushRef.current = flushDistribution })

  const SAVE_DELAY = 700
  const scheduleSave = useCallback(() => {
    clearTimeout(timerRef.current)
    setDistStatus('pending')
    timerRef.current = setTimeout(() => flushRef.current(), SAVE_DELAY)
  }, [])
  // Leaving a field is a clear "I'm done with this one" — don't wait it out.
  const flushNow = useCallback(() => { clearTimeout(timerRef.current); return flushRef.current() }, [])

  async function closeDistribute() {
    const ok = await flushNow()
    if (!ok) return              // error or over-assigned: keep the numbers on screen
    setShowDistribute(false)
    setDistStatus('clean')
    load()
  }

  // Apply a whole split in one go, against a fresh (empty) saved map. Used by
  // payday, which writes the plan without anyone opening the sheet.
  async function applyRows(paycheck, rows, checkingAcct) {
    const pid   = paycheck.id
    const date  = paycheck.date
    const month = String(date).slice(0, 7)
    const saved = {}
    for (const r of rows) {
      const err = await persistRow(r, pid, date, month, saved, checkingAcct)
      if (err) return { saved, error: err }
    }
    return { saved, error: null }
  }

  // A paycheck is income into checking, and the split that follows is already
  // fully described by the budget config — each line's plan and the account it
  // lives in (014). So payday writes it: deposit, split, transfer, done. The
  // distribute sheet stays for the check you want to differ from plan.
  async function processPaycheck() {
    if (!paycheckAmt || processing) return
    if (!checking) { setProcessErr('Add a checking account first — the paycheck has to land somewhere.'); return }
    setProcessing(true); setProcessErr('')

    // The date the check actually landed — so a paycheck entered late still
    // sits in the right month, and its split sits with the expenses it paid for.
    const day   = payDate || format(new Date(), 'yyyy-MM-dd')
    const month = day.slice(0, 7)
    const amt   = +paycheckAmt

    // paychecks has only net_amount — the original code also sent gross_amount,
    // which does not exist, and since it never checked the error this insert
    // had silently failed on every paycheck since launch.
    const { data: pc, error: pcErr } = await supabase.from('paychecks').insert({
      household_id: household.id,
      net_amount: amt,
      date: day,
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
      date: day, budget_month: month,
      created_by: user.id,
    })
    if (incErr) { setProcessErr(`Paycheck logged, but the deposit into ${checking.name} failed: ${incErr.message}`); setProcessing(false); return }

    // Build the split from what the database says right now, not from state the
    // setters above haven't applied yet — this writes real transfers.
    const fresh = await load()
    const freshChecking = fresh.accounts.find(a => a.type === 'checking') || checking
    const rows = planRows({ net: amt, date: day, itemsList: fresh.items, checkingAcct: freshChecking, led: fresh.ledger })

    // If the plan asks for more than the check brings in, do NOT write it. The
    // distribute sheet refuses to store a split that doesn't balance, and payday
    // must not quietly do what the sheet refuses to do openly — that would
    // earmark money the account never received. Hand it over to be resolved.
    const planned = rows.reduce((s, r) => s + (+r.amount || 0), 0)
    if (planned - amt > 0.005) {
      setProcessing(false)
      setShowPaycheck(false)
      setDistPaycheck(pc)
      savedRef.current = {}
      setDistRows(rows)
      setDistErr(`Deposited ${fmt(amt)} — but the plan asks for ${fmt(planned)}, which is ${fmt(planned - amt)} more than this check. Nothing has been split yet. Trim the lines below and they'll save as you go.`)
      setDistStatus('clean')
      setShowDistribute(true)
      return
    }

    const { saved, error: splitErr } = await applyRows(pc, rows, freshChecking)
    setProcessing(false)
    setShowPaycheck(false)

    if (splitErr) {
      // The money is banked; only the split faltered. Hand over the sheet with
      // whatever did land, rather than leaving the check silently unassigned.
      setDistPaycheck(pc)
      savedRef.current = saved
      setDistRows(rows)
      setDistErr(`Deposited, but the automatic split stopped partway: ${splitErr.message}. Check the amounts below — they save as you go.`)
      setDistStatus('clean')
      setShowDistribute(true)
      return
    }

    setFlash({
      paycheck: pc,
      funded: rows.filter(r => +r.amount > 0).length,
      moved:  rows.filter(r => r.ownAccount && +r.amount > 0).length,
    })
    load()
  }

  // What the NEXT check will do, from the engine and today's balances. This moves
  // as bills get paid and envelopes fill - that's the point.
  const perCheck = +(household?.paycheck_amount || 4212)
  const nextPayday = paydaysBetween(household, new Date(), new Date(Date.now() + 45 * 86400000))[0]?.date || new Date()
  const nextPlan = ledger ? planRows({ net: perCheck, date: format(nextPayday, 'yyyy-MM-dd') }) : []
  const plannedOthers = nextPlan.filter(r => !r.isRemainder).reduce((s, r) => s + (+r.amount || 0), 0)
  const plannedLeft = Math.round((perCheck - plannedOthers) * 100) / 100

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--accent)', textTransform: 'uppercase' }}>{FREQ_LABEL[household?.pay_frequency] || 'Bi-Weekly'}</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)' }}>Paycheck</div>
        </div>
        <button onClick={() => { setShowPaycheck(true); setProcessErr(''); setPayDate(format(new Date(), 'yyyy-MM-dd')) }} style={{ background: 'var(--green)', border: 'none', color: 'var(--onAccent)', borderRadius: '8px', padding: '0.5rem 1rem', fontWeight: 700, fontSize: '0.82rem' }}>▶ Process Paycheck</button>
      </div>

      {/* What payday just did. The split is applied automatically, so this
          reports it rather than asking for it. */}
      {flash && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--green)', borderRadius: 'var(--radius)', padding: '0.85rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
            <div style={{ fontSize: '0.82rem', color: 'var(--text)', lineHeight: 1.5 }}>
              <b style={{ color: 'var(--green)' }}>{fmt(flash.paycheck.net_amount)}</b> deposited into {checking?.name || 'checking'} and split across {flash.funded} budget line{flash.funded === 1 ? '' : 's'}
              {flash.moved > 0 && <> · {flash.moved} transfer{flash.moved === 1 ? '' : 's'} to savings</>}.
            </div>
            <button onClick={() => setFlash(null)} aria-label="Dismiss"
              style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '1rem', lineHeight: 1, padding: '0 0.2rem' }}>✕</button>
          </div>
          <button onClick={() => { setFlash(null); openDistribute(flash.paycheck) }}
            style={{ marginTop: '0.6rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.45rem 0.75rem', color: 'var(--muted)', fontSize: '0.75rem' }}>
            Adjust this check
          </button>
        </div>
      )}

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
        const edit = (id, val) => {
          setDistRows(rows => withRemainder(rows.map(x => x.id === id ? { ...x, amount: val } : x), net))
          scheduleSave()
        }
        const status = {
          clean:   null,
          pending: { text: 'Saving…',        c: 'var(--muted)' },
          saving:  { text: 'Saving…',        c: 'var(--muted)' },
          saved:   { text: '✓ Saved',        c: 'var(--green)' },
          blocked: { text: 'Not saved — over', c: 'var(--red)' },
        }[distStatus]
        return (
          // Deliberately no click-to-dismiss: tapping off this sheet used to
          // throw away everything typed into it. It closes from Done or ✕.
          <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--green)', borderRadius: '16px 16px 0 0', padding: '1.1rem 1.1rem 1.6rem', width: '100%', maxWidth: '600px', margin: '0 auto', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
                <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.35rem' }}>Distribute paycheck</div>
                <button onClick={closeDistribute} aria-label="Close"
                  style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '1.1rem', lineHeight: 1, padding: '0 0.2rem' }}>✕</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.6rem' }}>
                <div style={{ fontSize: '0.95rem', color: 'var(--text)' }}>
                  {format(startOfDay(new Date(distPaycheck.date + 'T12:00')), 'EEE, MMM d')} · {fmt(net)}
                </div>
                {status && <div style={{ fontSize: '0.6rem', color: status.c, whiteSpace: 'nowrap' }}>{status.text}</div>}
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
                        <div style={{ fontSize: '0.58rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>fills from what's left</div>
                      ) : (
                        // The engine's suggestion and, in plain words, why - tap to take it
                        <button onClick={() => edit(r.id, String(r.suggested))} title="Use the suggested amount"
                          style={{ background: 'transparent', border: 'none', padding: 0, fontSize: '0.58rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)', textAlign: 'left' }}>
                          {fmt(r.suggested)} · {r.reason}
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: `1px solid ${r.isRemainder ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '6px', padding: '0 0.4rem', opacity: r.isRemainder ? 0.85 : 1 }}>
                      <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>$</span>
                      <input type="number" step="0.01" value={r.amount} readOnly={r.isRemainder}
                        onChange={e => edit(r.id, e.target.value)}
                        onBlur={r.isRemainder ? undefined : flushNow}
                        style={{ width: '4.6rem', background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '0.82rem', fontFamily: 'var(--font-mono)', padding: '0.35rem 0', textAlign: 'right' }} />
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={() => { setDistRows(planRows({ net, date: distPaycheck.date, excludePaycheckId: distPaycheck.id })); scheduleSave() }}
                  style={{ flex: 1, background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.7rem', color: 'var(--muted)', fontSize: '0.8rem' }}>
                  Reset to plan
                </button>
                <button onClick={closeDistribute} disabled={distSaving || left < 0}
                  style={{ flex: 2, background: left < 0 ? 'var(--border)' : 'var(--green)', border: 'none', borderRadius: '8px', padding: '0.7rem', color: left < 0 ? 'var(--muted)' : 'var(--onAccent)', fontWeight: 700, fontSize: '0.85rem' }}>
                  {distSaving ? 'Saving…' : 'Done'}
                </button>
              </div>
              <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textAlign: 'center', marginTop: '0.5rem', lineHeight: 1.45 }}>
                {left < 0
                  ? 'Over-assigned — nothing is being saved until the lines fit the check.'
                  : `Each amount saves as you enter it. Lines marked "moves" transfer from ${checking?.name || 'checking'} to their own account.`}
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
              Deposits the check into <b style={{ color: 'var(--text)' }}>{checking?.name || 'checking'}</b> and splits it straight away — every line at its plan, the leftover into {remainderLine ? <b style={{ color: 'var(--text)' }}>{remainderLine.name}</b> : 'the leftover line'}, and a real transfer for each line that lives in its own savings account. Nothing to fill in; adjust afterwards only if this check needs to differ.
            </div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Net Paycheck Amount</label>
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--green)', borderRadius: '8px', padding: '0 0.85rem', marginBottom: '1rem' }}>
              <span style={{ color: 'var(--green)', fontSize: '1.1rem', marginRight: '0.3rem' }}>$</span>
              <input type="number" value={paycheckAmt} onChange={e => setPaycheckAmt(e.target.value)} autoFocus
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--green)', fontSize: '1.3rem', fontFamily: 'var(--font-mono)', padding: '0.55rem 0' }} />
            </div>
            <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Date it landed</label>
            <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)}
              style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.55rem 0.7rem', color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'var(--font-mono)', outline: 'none', marginBottom: '0.35rem' }} />
            <div style={{ fontSize: '0.62rem', color: 'var(--muted)', marginBottom: '1rem', lineHeight: 1.45 }}>
              Back-date a check you're entering late so it lands in the right month alongside the expenses it paid for.
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
