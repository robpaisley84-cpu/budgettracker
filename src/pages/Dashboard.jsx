import { useState, useEffect, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, addMonths, subMonths, getDaysInMonth, getDate, startOfMonth, endOfMonth, addDays, parseISO, differenceInCalendarDays, differenceInCalendarMonths } from 'date-fns'
import { computeAccrual } from '../lib/accrual'
import { linesPerAccount, isSoleOccupant, anchorsFor, spendSinceAnchor, allocatedSinceAnchor, fundBalance } from '../lib/funds'
import { CHECKS_PER_YEAR, paydaysBetween } from '../lib/projection'
// safeToSpend is aliased: this component already has a local `safeToSpend`
// (the monthly figure below), and the import was silently shadowed by it -
// the load then called a number, and production showed "A is not a function".
import { isScheduled, safeToSpend as safeToSpendFor, nextDue, billAmount, shortfall, reserved as reservedFor, lastPaymentFor } from '../lib/funding'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()

// How many paydays actually land inside the given calendar month.
// Bi-weekly/weekly are stepped from a known anchor payday, so most months
// have 2 (or 4) checks and a couple each year have 3 (or 5).
function paydaysInMonth(monthDate, freq, anchorISO, day1 = 1, day2 = 15) {
  if (freq === 'monthly') return 1
  if (freq === 'semimonthly') {
    const dim = getDaysInMonth(monthDate)
    return [day1, day2].filter(d => d >= 1 && d <= dim).length || 2
  }
  const step  = freq === 'weekly' ? 7 : 14
  if (!anchorISO) return freq === 'weekly' ? 4 : 2  // fallback until an anchor payday is set
  const start = startOfMonth(monthDate)
  const end   = endOfMonth(monthDate)
  let d = parseISO(anchorISO)
  while (d > start) d = addDays(d, -step)      // rewind to on/before the month
  let count = 0
  while (d <= end) { if (d >= start) count++; d = addDays(d, step) }
  return count
}

export default function Dashboard() {
  const { household } = useAuth()
  const [accounts, setAccounts]       = useState([])
  const [funds, setFunds]             = useState([])
  const [summary, setSummary]         = useState({ budgeted: 0, spent: 0 })
  const [recent, setRecent]           = useState([])
  const [recentErr, setRecentErr]     = useState('')
  const [ytd, setYtd]                 = useState({ budgeted: 0, spent: 0, months: 0 })
  const [monthlyBreakdown, setMonthlyBreakdown] = useState([])
  const [dueSoon, setDueSoon]         = useState([])
  const [tierTotals, setTierTotals]   = useState({ essential: 0, lifestyle: 0, savings: 0 })
  const [committed, setCommitted]     = useState(0)
  const [loading, setLoading]         = useState(true)
  const [loadErr, setLoadErr]         = useState('')   // shown instead of spinning forever
  const [showYtd, setShowYtd]         = useState(false)
  const [collapsed, setCollapsed]     = useState({})   // tier groups folded shut on the Safe to spend list
  const [trueUp, setTrueUp]           = useState(null)   // fund being trued up
  const [trueUpVal, setTrueUpVal]     = useState('')
  const [trueUpSaving, setTrueUpSaving] = useState(false)
  const [moveMode, setMoveMode]       = useState(false)
  const [pullMode, setPullMode]       = useState(false)   // "Move from": bring money IN from another fund
  const [pullFrom, setPullFrom]       = useState('')
  const [pullAmt, setPullAmt]         = useState('')
  const [moveTo, setMoveTo]           = useState('')
  const [moveAmt, setMoveAmt]         = useState('')
  const [moveNote, setMoveNote]       = useState('')
  const [addAmt, setAddAmt]           = useState('')   // top up this fund from unassigned
  const [viewMonth, setViewMonth]     = useState(new Date())
  const month = format(viewMonth, 'yyyy-MM')
  const isCurrentMonth = month === format(new Date(), 'yyyy-MM')

  // Monthly income = the paychecks that actually hit the account in the viewed month
  const perCheck = +household?.paycheck_amount || 0
  const payFreq  = household?.pay_frequency || 'biweekly'
  const payCount = paydaysInMonth(viewMonth, payFreq, household?.pay_anchor_date, household?.paycheck_day_1, household?.paycheck_day_2)
  const NET_MO   = perCheck * payCount

  useEffect(() => { if (household) load() }, [household, month])

  // Anything thrown in here used to leave the page on "Loading…" with no way to
  // see why. Now the error is caught, shown, and loading always resolves.
  async function load() {
    setLoading(true)
    setLoadErr('')
    try { await loadInner() }
    catch (e) { console.error('Dashboard load failed:', e); setLoadErr(String(e?.message || e)) }
    finally { setLoading(false) }
  }

  async function loadInner() {
    const year = format(viewMonth, 'yyyy')
    const janMonth = `${year}-01`
    const selectedMonthNum = parseInt(format(viewMonth, 'M'))

    const [{ data: accs }, { data: txns, error: txnErr }, { data: items }, { data: firstTxn }] = await Promise.all([
      // accounts_with_balance derives `balance` from transaction history (012)
      supabase.from('accounts_with_balance').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      // accounts must be embedded via account_id — transactions also has to_account_id
      supabase.from('transactions').select('*, budget_item:budget_items(name), account:accounts!account_id(name)').eq('household_id', household.id).eq('budget_month', month).order('created_at', { ascending: false }).limit(8),
      supabase.from('budget_items').select('id, name, budgeted_amount, funding_mode, per_check_amount, due_day, is_pinned, fund_sort_order, bill_amount, interval_months, last_paid_date, next_due_date, auto_accrue, saved_so_far, saved_as_of, tier, account_id, is_remainder_target, account:accounts(id, name, icon, type), category:budget_categories(name, icon, color)').eq('household_id', household.id).eq('is_active', true),
      // Oldest transaction = when this household started budgeting. Envelope
      // funds accrue from here, not from January, so a mid-year start does not
      // claim months of funding that never happened.
      supabase.from('transactions').select('budget_month').eq('household_id', household.id).order('budget_month', { ascending: true }).limit(1),
    ])

    const appStartMonth = firstTxn?.[0]?.budget_month || month

    // This month's expenses (for monthly metrics)
    const { data: monthTxns } = await supabase
      .from('transactions')
      .select('budget_item_id, amount')
      .eq('household_id', household.id)
      .eq('budget_month', month)
      .eq('type', 'expense')

    // Calendar-year expenses per budget item — drives the YTD overview and the
    // month-by-month breakdown, which stay calendar-year by definition.
    const { data: ytdItemTxns } = await supabase
      .from('transactions')
      .select('budget_item_id, budget_month, amount')
      .eq('household_id', household.id)
      .eq('type', 'expense')
      .gte('budget_month', janMonth)
      .lte('budget_month', month)

    // Each fund accrues from its own anchor: an explicit "actual balance as of"
    // date if one was recorded, otherwise the month budgeting began. Envelopes
    // are running funds, so this can reach back past January.
    const { itemAnchor, savedAsOf } = anchorsFor(items, appStartMonth)
    const fundFloor = [appStartMonth, ...Object.values(itemAnchor)].sort()[0] || month

    const { data: fundTxns } = await supabase
      .from('transactions')
      .select('budget_item_id, budget_month, amount, date')
      .eq('household_id', household.id)
      .eq('type', 'expense')
      .gte('budget_month', fundFloor)
      .lte('budget_month', month)

    const anchoredSpend = spendSinceAnchor(fundTxns, itemAnchor, savedAsOf)

    const { data: allocs } = await supabase
      .from('paycheck_allocations')
      .select('budget_item_id, amount, date')
      .eq('household_id', household.id)

    const allocatedTo = allocatedSinceAnchor(allocs, savedAsOf)

    // Monthly actuals for this month only (for monthly summary)
    const monthActuals = {}
    monthTxns?.forEach(t => { monthActuals[t.budget_item_id] = (monthActuals[t.budget_item_id] || 0) + +t.amount })

    // YTD actuals per item (for envelope balances)
    const ytdActuals = {}
    ytdItemTxns?.forEach(t => { ytdActuals[t.budget_item_id] = (ytdActuals[t.budget_item_id] || 0) + +t.amount })

    // Monthly breakdown totals
    const monthMap = {}
    ytdItemTxns?.forEach(t => { monthMap[t.budget_month] = (monthMap[t.budget_month] || 0) + +t.amount })

    // Build envelope funds list.
    //
    //   balance = opening balance + allocated since the anchor - spent since it
    //
    // One rule for every line, accruing bills included: they are funded by
    // allocation like anything else, and computeAccrual now only supplies the
    // SUGGESTED set-aside and the due date, not the balance. Paying such a bill
    // is an expense, which draws the envelope down naturally — no cycle reset.
    const asOf = endOfMonth(viewMonth)

    // Derived balances by account, for lines that live in their own account
    const accountBalance = {}
    ;(accs || []).forEach(a => { accountBalance[a.id] = +a.balance })
    // How many lines share each account — decides whether a line can read its
    // balance straight off the account, or has to earn it by allocation.
    const perAccount = linesPerAccount(items)

    const fundsList = (items || []).map(item => {
      const calc = computeAccrual(item, asOf)
      const thisMonthSpent = monthActuals[item.id] || 0
      const spent = anchoredSpend[item.id] || 0

      // The plan: what to put in each month. Accruing bills derive theirs.
      const monthlyBudget = calc ? calc.accrual : +item.budgeted_amount

      const savedBase      = item.saved_as_of ? (+item.saved_so_far || 0) : 0
      const putIn          = allocatedTo[item.id] || 0
      const totalAllocated = savedBase + putIn

      // A line that is the SOLE occupant of its own account IS that account
      // (014): its balance is the account's derived balance, so envelope and
      // bank can never disagree. Share a savings account between several lines
      // and that shortcut breaks — each would report the whole balance — so
      // those lines use the same envelope arithmetic as checking-backed ones,
      // and Accounts reports whatever is left unassigned.
      const backing    = item.account || null
      const ownAccount = !!(backing && backing.type !== 'checking')  // funding moves real money
      const soleOwn    = isSoleOccupant(item, perAccount)            // ...and nothing else shares it
      const balance    = fundBalance(item, { allocated: putIn, spent, accountBalance, perAccount })

      // Hayley's number (015): a flexible line's balance is spendable; a
      // scheduled bill's is reserved, so only a surplus over the bill counts.
      const scheduled = isScheduled(item)
      // A bill paid early this cycle (Sam's Club on the 10th for the 23rd) is
      // already saving for the following due date - not "behind" on this one.
      const lastPaid  = scheduled ? lastPaymentFor(item, fundTxns || []) : null
      const ctx       = { household, lastPaid }
      const due       = scheduled ? nextDue(item, new Date(), lastPaid) : null

      return {
        backedBy: backing?.name || null,
        backingAccountId: backing?.id || null,
        ownAccount,
        soleOwn,
        isRemainderTarget: !!item.is_remainder_target,
        id: item.id,
        name: item.name,
        scheduled,
        // Lean where the timing allows, full where the check and the bill are
        // close (TIGHT_DAYS): a bill's spare is what it holds beyond what's
        // reserved for it, and that spare IS spendable.
        safe: safeToSpendFor(item, balance, ctx),
        reserved: scheduled ? reservedFor(item, { ...ctx, held: balance }) : 0,
        tier: item.tier || 'essential',
        // The number the row displays - a bill shows what it holds, an allowance
        // what's spendable - so the list can sort by what the eye sees.
        shown: (scheduled && billAmount(item) > 0) ? balance : safeToSpendFor(item, balance, ctx),
        bill: scheduled ? billAmount(item) : null,
        // Behind an even funding pace, not merely below full - an annual bill
        // three checks into its year is meant to be mostly empty.
        short: scheduled ? shortfall(item, { ...ctx, held: balance }) : 0,
        dueNext: due,
        perCheck: +item.per_check_amount || 0,
        monthlyBudget,
        totalAllocated,
        spent,
        thisMonthSpent,
        fundBalance: balance,
        anchorMonth: itemAnchor[item.id] || month,
        putIn,
        neverFunded: putIn === 0 && savedBase === 0,
        trued: !!item.saved_as_of,
        accruing: !!calc,
        accrualTarget: calc?.target ?? null,
        accrualDue: calc?.nextDue ?? null,
        isPinned: item.is_pinned || false,
        sortOrder: item.fund_sort_order || 0,
        category: item.category?.name || '',
        icon: item.category?.icon || '📋',
        color: item.category?.color || 'var(--muted)',
      }
    }).sort((a, b) => {
      // Pinned first; then essentials, lifestyle, savings; within a tier the
      // biggest displayed number first. Rule-based, so no manual reorder.
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
      const rank = { essential: 0, lifestyle: 1, savings: 2 }
      if (rank[a.tier] !== rank[b.tier]) return (rank[a.tier] ?? 9) - (rank[b.tier] ?? 9)
      if (b.shown !== a.shown) return b.shown - a.shown
      return a.name.localeCompare(b.name)
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

    // Upcoming annual/quarterly bills (reminders)
    const { data: periodicItems } = await supabase
      .from('budget_items')
      .select('id, name, budgeted_amount, next_due_date, bill_frequency, bill_amount, interval_months, last_paid_date, auto_accrue, saved_so_far, saved_as_of, category:budget_categories(icon)')
      .eq('household_id', household.id)
      .eq('is_active', true)
      .gt('interval_months', 1)
      .not('next_due_date', 'is', null)
    const soon = (periodicItems || [])
      .map(i => {
        const calc = computeAccrual(i)
        // Show the real charge and the rolled-forward date, not the stale row
        return {
          ...i,
          dueDate: calc ? calc.nextDue : parseISO(i.next_due_date),
          dueAmount: calc ? calc.target : +i.budgeted_amount,
          shortfall: calc ? Math.max(0, calc.target - calc.accrued) : 0,
          daysUntil: calc ? calc.daysUntil : differenceInCalendarDays(parseISO(i.next_due_date), new Date()),
        }
      })
      .filter(i => i.daysUntil <= 45)
      .sort((a, b) => a.daysUntil - b.daysUntil)
      .slice(0, 4)

    // What this month is still committed to: fixed monthly bills that have not
    // been paid yet, plus set-asides still owed on longer-cycle bills. Flexible
    // lines (groceries, fuel) are deliberately NOT counted — that remaining
    // budget is exactly the money "safe to spend" is meant to describe.
    let committedTotal = 0
    for (const it of items || []) {
      const spentOnIt = monthActuals[it.id] || 0
      const calc = computeAccrual(it, asOf)
      if (calc) {
        committedTotal += Math.max(0, calc.accrual - spentOnIt)          // set-aside still owed
      } else if (+it.interval_months === 1) {
        committedTotal += Math.max(0, +it.budgeted_amount - spentOnIt)   // unpaid fixed bill
      }
    }

    setAccounts(accs || [])
    setFunds(fundsList)
    setCommitted(Math.round(committedTotal * 100) / 100)
    setSummary({ budgeted, spent: monthSpent })
    setRecent(txns || [])
    setRecentErr(txnErr ? `Couldn't load recent activity: ${txnErr.message}` : '')
    setYtd({ budgeted: ytdBudgeted, spent: ytdSpentTotal, months: selectedMonthNum })
    setMonthlyBreakdown(breakdown)
    setDueSoon(soon)
    const tierT = { essential: 0, lifestyle: 0, savings: 0 }
    ;(items || []).forEach(i => { tierT[i.tier || 'essential'] += +i.budgeted_amount })
    setTierTotals(tierT)
  }

  // The month-model cards (income vs spend, carry-over, priorities, projections,
  // YTD) came off this page on 2026-09-21: they answered "how is the month going"
  // with a second definition of safe-to-spend that contradicted the envelopes.
  // The envelopes ARE the page now (015); history lives on Budget and Transactions.

  async function togglePin(itemId, currentlyPinned) {
    await supabase.from('budget_items').update({ is_pinned: !currentlyPinned }).eq('id', itemId)
    load()
  }

  // The Safe to spend list, grouped: pinned, then each tier in priority order.
  // `funds` is already sorted that way, so each group keeps its order.
  const TIER_META = {
    pinned:    { label: 'Pinned',     color: 'var(--accent)' },
    essential: { label: 'Essentials', color: 'var(--tierE)' },
    lifestyle: { label: 'Lifestyle',  color: 'var(--tierL)' },
    savings:   { label: 'Savings',    color: 'var(--tierS)' },
  }
  const fundGroups = [
    { key: 'pinned', items: funds.filter(f => f.isPinned) },
    ...['essential', 'lifestyle', 'savings'].map(t => ({ key: t, items: funds.filter(f => !f.isPinned && f.tier === t) })),
  ].filter(g => g.items.length > 0)

  // Shared by the headline and the Balance sheet. A "bill" is a scheduled line
  // WITH an amount; a scheduled line with none is just an overspend.
  const checkingAcc = accounts.find(a => a.type === 'checking')
  const inChk  = (f) => f.backingAccountId === checkingAcc?.id
  const isBill = (f) => f.scheduled && f.bill > 0
  const unassigned = checkingAcc ? +checkingAcc.balance - funds.filter(inChk).reduce((s, f) => s + f.fundBalance, 0) : null

  // --- Balance the funds: cover overspent allowances and short bills from
  // unassigned, in one pass. Rob's monthly job, as one sheet. Bills are only
  // ever ADDED to here - a bill's envelope is never a source. ---
  const [showBalance, setShowBalance] = useState(false)
  const [balRows, setBalRows]         = useState([])
  const [balSaving, setBalSaving]     = useState(false)
  const [balErr, setBalErr]           = useState('')

  function openBalance() {
    const rows = funds.filter(inChk).flatMap(f => {
      if (isBill(f)) {
        // Only bills that are BEHIND PACE - a half-filled annual bill on schedule isn't a problem
        return f.short > 0.5 ? [{ id: f.id, name: f.name, kind: 'bill', deficit: f.short, amount: String(Math.round(f.short * 100) / 100), on: true }] : []
      }
      return f.safe < -0.5 ? [{ id: f.id, name: f.name, kind: 'over', deficit: -f.safe, amount: String(Math.round(-f.safe * 100) / 100), on: true }] : []
    }).sort((a, b) => b.deficit - a.deficit)
    setBalRows(rows); setBalErr(''); setShowBalance(true)
  }

  async function applyBalance() {
    const picks = balRows.filter(r => r.on && +r.amount > 0)
    const total = picks.reduce((s, r) => s + +r.amount, 0)
    if (!picks.length || total > (unassigned || 0) + 0.005) return
    setBalSaving(true)
    const today = format(new Date(), 'yyyy-MM-dd')
    const { error } = await supabase.from('paycheck_allocations').insert(picks.map(r => ({
      household_id: household.id, budget_item_id: r.id, amount: Math.round(+r.amount * 100) / 100,
      date: today, budget_month: today.slice(0, 7), note: 'Balanced from unassigned',
    })))
    setBalSaving(false)
    if (error) { setBalErr(`Couldn't balance: ${error.message}`); return }
    setShowBalance(false)
    load()
  }

  function openTrueUp(f) {
    setTrueUp(f)
    setTrueUpVal(f.fundBalance != null ? String(Math.round(f.fundBalance * 100) / 100) : '')
    // A line that is its own account has no envelope to true up — its balance
    // is set on the Accounts page — so open straight onto Move money.
    setMoveMode(!!f.soleOwn); setPullMode(false); setPullFrom(''); setPullAmt(''); setMoveTo(''); setMoveAmt(''); setMoveNote(''); setAddAmt('')
  }

  // Funds this one may draw from: anything with spendable money, except bills -
  // a bill's envelope is reserved and is never a source (Rob's rule).
  const pullSources = trueUp
    ? funds.filter(f => f.id !== trueUp.id && !(f.scheduled && f.bill > 0) && f.safe > 0.005)
           .sort((a, b) => b.safe - a.safe)
    : []

  // Move money INTO this fund from another. Same two-row record as moveMoney,
  // reversed; the amount is capped at what the source actually has available.
  async function pullMoney() {
    const src = funds.find(f => f.id === pullFrom)
    const amt = Math.round(Math.min(Math.abs(+pullAmt) || 0, src?.safe || 0) * 100) / 100
    if (!trueUp || !src || !(amt > 0)) return
    setTrueUpSaving(true)
    const group = crypto.randomUUID()
    const today = format(new Date(), 'yyyy-MM-dd')
    const base  = { household_id: household.id, transfer_group: group, date: today, budget_month: today.slice(0, 7) }
    const { error } = await supabase.from('paycheck_allocations').insert([
      { ...base, budget_item_id: src.id,    amount: -amt, note: moveNote || `Moved to ${trueUp.name}` },
      { ...base, budget_item_id: trueUp.id, amount:  amt, note: moveNote || `Moved from ${src.name}` },
    ])
    if (error) { setTrueUpSaving(false); setRecentErr(`Couldn't move money: ${error.message}`); return }
    // Different accounts → the money really moves; record the transfer so both balances follow
    if (src.backingAccountId && trueUp.backingAccountId && src.backingAccountId !== trueUp.backingAccountId) {
      const { error: tErr } = await supabase.from('transactions').insert({
        household_id: household.id, account_id: src.backingAccountId, to_account_id: trueUp.backingAccountId,
        type: 'transfer', amount: amt, description: moveNote || `Moved: ${src.name} → ${trueUp.name}`,
        date: today, budget_month: today.slice(0, 7),
      })
      if (tErr) { setTrueUpSaving(false); setRecentErr(`Envelopes moved, but the account transfer didn't save: ${tErr.message}`); return }
    }
    setTrueUpSaving(false)
    setTrueUp(null); setPullFrom(''); setPullAmt(''); setMoveNote(''); setPullMode(false)
    load()
  }

  // The mirror of "Back to unassigned": pull dollars that no fund has claimed
  // into this one. A single positive allocation - a move, not a correction, so
  // the line's history stays intact and it shows in Activity. A savings-backed
  // fund also gets the real checking -> account transfer.
  async function addFromPot() {
    if (!trueUp || !(+addAmt > 0)) return
    setTrueUpSaving(true)
    const amt   = Math.round(Math.abs(+addAmt) * 100) / 100
    const today = format(new Date(), 'yyyy-MM-dd')
    const { error } = await supabase.from('paycheck_allocations').insert({
      household_id: household.id, budget_item_id: trueUp.id, amount: amt,
      date: today, budget_month: today.slice(0, 7), note: 'Added from unassigned',
    })
    if (error) { setTrueUpSaving(false); setRecentErr(`Couldn't add to ${trueUp.name}: ${error.message}`); return }
    const checkingId = accounts.find(a => a.type === 'checking')?.id || null
    if (trueUp.backingAccountId && checkingId && trueUp.backingAccountId !== checkingId) {
      const { error: tErr } = await supabase.from('transactions').insert({
        household_id: household.id, account_id: checkingId, to_account_id: trueUp.backingAccountId,
        type: 'transfer', amount: amt, description: `Added to ${trueUp.name} from checking`,
        date: today, budget_month: today.slice(0, 7),
      })
      if (tErr) { setTrueUpSaving(false); setRecentErr(`Envelope topped up, but the account transfer didn't save: ${tErr.message}`); return }
    }
    setTrueUpSaving(false); setTrueUp(null); setAddAmt('')
    load()
  }

  // Records what a fund really holds today and anchors future accrual to it.
  async function saveTrueUp() {
    if (!trueUp || trueUpVal === '') return
    setTrueUpSaving(true)
    await supabase.from('budget_items')
      .update({ saved_so_far: +trueUpVal, saved_as_of: format(new Date(), 'yyyy-MM-dd') })
      .eq('id', trueUp.id)
    setTrueUpSaving(false)
    setTrueUp(null)
    load()
  }

  // Drops the anchor — the fund falls back to accruing from the start of budgeting.
  async function clearTrueUp() {
    if (!trueUp) return
    setTrueUpSaving(true)
    await supabase.from('budget_items')
      .update({ saved_so_far: null, saved_as_of: null })
      .eq('id', trueUp.id)
    setTrueUpSaving(false)
    setTrueUp(null)
    load()
  }

  // Move allocated dollars from this fund to another. Written as two rows that
  // sum to zero and share a transfer_group, so the source simply goes down (and
  // can go negative if it lends more than it holds) and the pair is the record
  // of where the money went.
  async function moveMoney() {
    if (!trueUp || !moveTo || !(+moveAmt > 0)) return
    setTrueUpSaving(true)
    const group = crypto.randomUUID()
    const today = format(new Date(), 'yyyy-MM-dd')
    const dest  = funds.find(f => f.id === moveTo)
    const base  = {
      household_id: household.id,
      transfer_group: group,
      date: today,
      budget_month: today.slice(0, 7),
    }
    const amt = Math.abs(+moveAmt)
    // "Back to unassigned" is a one-sided move: the source drops, nothing else
    // rises, and the dollars fall out of every envelope's claim on checking -
    // which is exactly what "the pot" means. Reassign them on Accounts, or let
    // the next check's leftover pick them up. The plan is untouched.
    const toPot = moveTo === '__pot__'
    const rows = toPot
      ? [{ ...base, budget_item_id: trueUp.id, amount: -amt, note: moveNote || 'Returned to unassigned' }]
      : [{ ...base, budget_item_id: trueUp.id, amount: -amt, note: moveNote || `Moved to ${dest?.name || 'another fund'}` },
         { ...base, budget_item_id: moveTo,    amount:  amt, note: moveNote || `Moved from ${trueUp.name}` }]
    const { error } = await supabase.from('paycheck_allocations').insert(rows)
    if (error) { setTrueUpSaving(false); setRecentErr(`Couldn't move money: ${error.message}`); return }

    // If the money changes accounts, it has to move at the bank too — record the
    // real transfer so both balances follow. The pot lives in checking.
    const checkingId  = accounts.find(a => a.type === 'checking')?.id || null
    const destAccount = toPot ? checkingId : (dest?.backingAccountId || null)
    if (trueUp.backingAccountId && destAccount && trueUp.backingAccountId !== destAccount) {
      const { error: tErr } = await supabase.from('transactions').insert({
        household_id: household.id,
        account_id: trueUp.backingAccountId,
        to_account_id: destAccount,
        type: 'transfer',
        amount: amt,
        description: moveNote || (toPot ? `Returned to checking from ${trueUp.name}` : `Moved: ${trueUp.name} → ${dest.name}`),
        date: today, budget_month: today.slice(0, 7),
      })
      if (tErr) { setTrueUpSaving(false); setRecentErr(`Envelopes moved, but the account transfer didn't save: ${tErr.message}`); return }
    }
    setTrueUpSaving(false)
    setTrueUp(null); setMoveTo(''); setMoveAmt(''); setMoveNote(''); setMoveMode(false); setPullMode(false)
    load()
  }

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      {/* Header with month navigation */}
      <div style={{ marginBottom: '1.1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--accent)', textTransform: 'uppercase' }}>Road Budget</div>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <Link to="/help" title="How it works" style={{ textDecoration: 'none', fontSize: '1.1rem' }}>❓</Link>
            <Link to="/activity" title="Activity" style={{ textDecoration: 'none', fontSize: '1.1rem' }}>📜</Link>
            <Link to="/settings" title="Settings" style={{ textDecoration: 'none', fontSize: '1.1rem' }}>⚙️</Link>
          </div>
        </div>
        {/* Today, not a month: every number on this page is "right now" */}
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)', textAlign: 'center' }}>{format(new Date(), 'EEEE, MMMM d')}</h1>
      </div>

      {loadErr && (
        <div style={{ background: 'var(--dangerBg)', border: '1px solid var(--red)', borderRadius: '8px', padding: '0.7rem 0.85rem', marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.3rem' }}>Couldn't load the dashboard</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text)', fontFamily: 'var(--font-mono)', wordBreak: 'break-word', lineHeight: 1.45 }}>{loadErr}</div>
          <button onClick={load} style={{ marginTop: '0.6rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.35rem 0.7rem', color: 'var(--muted)', fontSize: '0.72rem' }}>Try again</button>
        </div>
      )}

      {/* Safe to spend — the front page is the envelopes, not the month (015).
          One number per fund, right now. Scheduled bills show as reserved. */}
      {(() => {
        // The headline is CHECKING's spendable money, net. Overspent envelopes have
        // already consumed cash out from under the positive ones, so adding up only
        // the greens overstates it; and savings-account funds aren't checking at
        // all. A scheduled line with no amount is a plain overspend, not a bill.
        const flex   = funds.filter(f => inChk(f) && !isBill(f))
        const billSpare  = funds.filter(f => inChk(f) && isBill(f)).reduce((s, f) => s + f.safe, 0)   // held beyond reserved
        const spendNet   = flex.reduce((s, f) => s + f.safe, 0) + billSpare
        const spendPos   = flex.reduce((s, f) => s + (f.safe > 0 ? f.safe : 0), 0) + billSpare
        const overspent  = flex.reduce((s, f) => s + (f.safe < 0 ? f.safe : 0), 0)
        const inSavings  = funds.filter(f => !inChk(f) && !isBill(f)).reduce((s, f) => s + Math.max(0, f.safe), 0)
        const shortBills = funds.filter(f => inChk(f) && isBill(f) && f.short > 0.5).length
        const outOfBalance = overspent < -0.5 || shortBills > 0 || Math.abs(unassigned || 0) >= 1
        const nextPay     = paydaysBetween(household, new Date(), addDays(new Date(), 45))[0]?.date
        const daysToPay   = nextPay ? differenceInCalendarDays(nextPay, new Date()) : null
        return (
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
              <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Safe to spend</h2>
              <Link to="/bills" style={{ fontSize: '0.72rem', color: 'var(--accent)', textDecoration: 'none' }}>Schedule →</Link>
            </div>

            {/* Headline: what's spendable across every fund, and when the next check lands */}
            <div style={{ background: 'var(--card)', border: '1px solid var(--accent)', borderRadius: 'var(--radius) var(--radius) 0 0', padding: '0.85rem 0.9rem', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.6rem' }}>
              {/* Headline = what's in checking that isn't reserved for a bill: allowance
                  envelopes (net of overspend) plus unassigned. Moving money between the
                  pot and an envelope leaves it alone - nothing left checking. Scheduling a
                  bill or overspending brings it down. */}
              {(() => { const uncommitted = spendNet + (unassigned || 0); return (
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.6rem', color: uncommitted < 0 ? 'var(--red)' : 'var(--accentL)', lineHeight: 1 }}>
                  {uncommitted < 0 ? '-' : ''}{fmt(uncommitted)}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--muted)', marginTop: '0.25rem', lineHeight: 1.5 }}>
                  uncommitted in checking · <span style={{ color: spendNet < 0 ? 'var(--red)' : 'var(--green)' }}>{spendNet < 0 ? '-' : ''}{fmt(spendNet)}</span> in envelopes
                  {unassigned != null && Math.abs(unassigned) >= 1 && <> · <Link to="/accounts" style={{ color: 'var(--amber)', textDecoration: 'none' }}>{fmt(unassigned)} unassigned →</Link></>}
                </div>
                {overspent < 0 && (
                  <div style={{ fontSize: '0.58rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
                    envelopes: <span style={{ color: 'var(--green)' }}>{fmt(spendPos)}</span> showing green, <span style={{ color: 'var(--red)' }}>−{fmt(overspent)}</span> overspent already taken out
                  </div>
                )}
                {inSavings > 0 && (
                  <div style={{ fontSize: '0.58rem', color: 'var(--muted)', marginTop: '0.15rem' }}>{fmt(inSavings)} in savings accounts, not counted</div>
                )}
                {outOfBalance && (
                  <button onClick={openBalance}
                    style={{ marginTop: '0.55rem', background: (overspent < -0.5 || shortBills > 0) && (unassigned || 0) > 1 ? 'var(--accent)' : 'transparent', border: '1px solid var(--accent)', borderRadius: '7px', padding: '0.4rem 0.75rem', color: (overspent < -0.5 || shortBills > 0) && (unassigned || 0) > 1 ? 'var(--onAccent)' : 'var(--accent)', fontSize: '0.74rem', fontWeight: 700 }}>
                    ⚖ Balance the funds
                  </button>
                )}
              </div>
              ) })()}
              {nextPay && (
                <div style={{ textAlign: 'right', fontSize: '0.66rem', color: 'var(--muted)', lineHeight: 1.45 }}>
                  next check {format(nextPay, 'EEE MMM d')}<br />
                  <span style={{ color: 'var(--text)' }}>{daysToPay === 0 ? 'today' : `in ${daysToPay} day${daysToPay === 1 ? '' : 's'}`}</span>
                </div>
              )}
            </div>

            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 var(--radius) var(--radius)', overflow: 'hidden' }}>
              {funds.length === 0 && (
                <div style={{ fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center', padding: '1.5rem' }}>
                  No budget items yet — <Link to="/budget" style={{ color: 'var(--accent)' }}>set up your budget</Link>
                </div>
              )}
              {fundGroups.map(g => {
                const meta     = TIER_META[g.key]
                const isOpen   = !collapsed[g.key]
                // Same rule as the headline: a bill's spare counts as spendable, only its reserved part as held
                const spend    = g.items.reduce((s, f) => s + (f.safe > 0 ? f.safe : 0), 0)
                const held     = g.items.reduce((s, f) => s + (isBill(f) ? f.reserved : 0), 0)
                const over     = g.items.reduce((s, f) => s + (!isBill(f) && f.safe < 0 ? f.safe : 0), 0)
                return (
                  <Fragment key={g.key}>
                    {/* Tier header - tap to fold the group. Shows what the tier has to
                        spend, what it's holding for bills, and any overspend. */}
                    <button onClick={() => setCollapsed(c => ({ ...c, [g.key]: !c[g.key] }))}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.9rem', background: 'var(--bgAlt)', border: 'none', borderTop: '1px solid var(--border)', borderBottom: isOpen ? '1px solid var(--border)' : 'none', textAlign: 'left', cursor: 'pointer' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: '0.68rem', color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
                        {meta.label} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {g.items.length}</span>
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.66rem', whiteSpace: 'nowrap' }}>
                        {spend > 0 && <span style={{ color: 'var(--green)' }}>{fmt(spend)} to spend</span>}
                        {held > 0 && <span style={{ color: 'var(--muted)' }}>{spend > 0 ? ' · ' : ''}{fmt(held)} held</span>}
                        {over < 0 && <span style={{ color: 'var(--red)' }}> · {fmt(over)} over</span>}
                      </span>
                      <span style={{ color: 'var(--muted)', fontSize: '0.6rem' }}>{isOpen ? '▲' : '▼'}</span>
                    </button>

                    {isOpen && g.items.map((f, i) => {
                const safeColor = f.safe < 0 ? 'var(--red)' : f.safe === 0 ? 'var(--muted)' : f.safe < f.perCheck * 0.35 ? 'var(--amber)' : 'var(--green)'
                const pct = f.scheduled && f.bill > 0 ? Math.min(100, Math.max(0, (f.fundBalance / f.bill) * 100)) : null
                return (
                  <div key={f.id} style={{ padding: '0.55rem 0.9rem', borderBottom: i < g.items.length-1 ? '1px solid var(--hairline)' : 'none', background: f.isPinned ? 'var(--pinned)' : 'transparent' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <button onClick={() => togglePin(f.id, f.isPinned)} style={{ background: 'transparent', border: 'none', fontSize: '0.75rem', padding: 0, cursor: 'pointer', opacity: f.isPinned ? 1 : 0.35 }} title={f.isPinned ? 'Unpin' : 'Pin to top'}>
                        {f.isPinned ? '⭐' : '☆'}
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}
                        onClick={() => openTrueUp(f)}
                        role="button"
                        title={f.soleOwn ? 'Move money' : 'Set the real balance or move money'}>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                          {f.name}
                          {f.trued && !f.soleOwn && <span style={{ color: 'var(--muted)', fontSize: '0.58rem' }} title="Balance trued up"> ✓</span>}
                          {f.isRemainderTarget && <span style={{ color: 'var(--accent)', fontSize: '0.58rem' }} title="Receives each paycheck's leftover"> ⤵</span>}
                        </div>
                        <div style={{ fontSize: '0.56rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
                          {f.scheduled
                            ? <>{f.bill > 0 ? <>{fmt(f.bill)} bill</> : <span style={{ color: 'var(--red)' }}>no amount set</span>}{f.dueNext && <> · due {format(f.dueNext, 'MMM d')}</>}</>
                            : <>{fmt(f.perCheck)}/check{f.thisMonthSpent > 0 && <> · {fmt(f.thisMonthSpent)} spent this mo</>}</>}
                          {f.ownAccount && <> · 🏦 {f.backedBy}</>}
                        </div>
                      </div>
                      {/* Every row says in words what its number means, so Hayley never
                          has to infer it from a colour. An allowance: the big number IS
                          what's safe to spend, captioned as such (or "overspent"). A bill:
                          the big number is what it HOLDS, in grey - spoken for, not
                          spendable - and the caption says how much of it, if any, is safe
                          to spend. A fund in its own savings account is savings, not
                          spending money, and says so. */}
                      <div style={{ textAlign: 'right' }}>
                        {f.scheduled && f.bill > 0 ? (() => {
                          const behind = f.short > 0.5
                          return (
                            <>
                              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.92rem', fontWeight: 600, color: behind ? 'var(--amber)' : 'var(--muted)' }}>
                                {f.fundBalance < 0 ? '-' : ''}{fmt(f.fundBalance)}
                                <span style={{ fontSize: '0.56rem', fontWeight: 400, color: 'var(--muted)' }}> held</span>
                              </div>
                              <div style={{ fontSize: '0.54rem', color: behind ? 'var(--amber)' : f.safe >= 1 ? 'var(--green)' : 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap', fontWeight: f.safe >= 1 ? 700 : 400 }}>
                                {behind ? `behind ${fmt(f.short)} · $0 to spend`
                                  : f.safe >= 1 ? `${fmt(f.safe)} safe to spend`
                                  : f.fundBalance < f.bill - 0.5 ? 'on pace · $0 to spend' : 'reserved · $0 to spend'}
                              </div>
                            </>
                          )
                        })() : (
                          <>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.92rem', fontWeight: 600, color: f.ownAccount ? 'var(--muted)' : safeColor }}>
                              {f.safe < 0 ? '-' : ''}{fmt(f.safe)}
                            </div>
                            <div style={{ fontSize: '0.54rem', color: f.ownAccount ? 'var(--muted)' : safeColor, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap', fontWeight: f.safe >= 1 && !f.ownAccount ? 700 : 400 }}>
                              {f.ownAccount ? 'in savings'
                                : f.safe < -0.5 ? 'overspent'
                                : f.safe < 1 ? 'nothing left'
                                : 'safe to spend'}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    {pct !== null && (
                      <div style={{ marginTop: '0.3rem', marginLeft: '1.65rem', background: 'var(--border)', borderRadius: '3px', height: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? 'var(--green)' : 'var(--accent)', borderRadius: '3px', transition: 'width 0.3s' }} />
                      </div>
                    )}
                  </div>
                )
                    })}
                  </Fragment>
                )
              })}
              {funds.length > 0 && (
                <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textAlign: 'center', padding: '0.45rem', borderTop: '1px solid var(--border)' }}>
                  Green = safe to spend now · grey = held for a bill · red = already overspent · tap a fund to move money
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Due soon reminders */}
      {dueSoon.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.85rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>🔔 Due soon</div>
            <Link to="/bills" style={{ fontSize: '0.65rem', color: 'var(--accent)', textDecoration: 'none' }}>All bills →</Link>
          </div>
          {dueSoon.map((i, idx) => {
            const past = i.daysUntil < 0, urgent = i.daysUntil <= 14
            const c = past ? 'var(--red)' : urgent ? 'var(--amber)' : 'var(--muted)'
            return (
              <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.32rem 0', borderTop: idx > 0 ? '1px solid var(--hairline)' : 'none' }}>
                <span style={{ fontSize: '0.85rem' }}>{i.category?.icon || '📄'}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text)' }}>{i.name}</div>
                  {i.shortfall > 0 && <div style={{ fontSize: '0.6rem', color: 'var(--amber)' }}>{fmt(i.shortfall)} still to set aside</div>}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--accentL)' }}>{fmt(i.dueAmount)}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--muted)' }}>{format(i.dueDate, 'MMM d')}</span>
                <span style={{ fontSize: '0.68rem', color: c, minWidth: '3.2rem', textAlign: 'right' }}>{past ? `${Math.abs(i.daysUntil)}d over` : i.daysUntil === 0 ? 'today' : `in ${i.daysUntil}d`}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Balance the funds — cover every overspent allowance and short bill from
          unassigned in one pass. No tap-outside dismiss; Cancel or Apply. */}
      {showBalance && (() => {
        const avail  = unassigned || 0
        const picks  = balRows.filter(r => r.on && +r.amount > 0)
        const total  = picks.reduce((s, r) => s + (+r.amount || 0), 0)
        const over   = total > avail + 0.005
        const need   = balRows.reduce((s, r) => s + r.deficit, 0)
        const setRow = (id, patch) => setBalRows(rows => rows.map(r => r.id === id ? { ...r, ...patch } : r))
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.1rem 1.1rem 1.6rem', width: '100%', maxWidth: '600px', margin: '0 auto', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.35rem' }}>Balance the funds</div>
                <button onClick={() => setShowBalance(false)} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '1.1rem', lineHeight: 1 }}>✕</button>
              </div>
              <div style={{ fontSize: '0.74rem', color: 'var(--muted)', lineHeight: 1.5, marginBottom: '0.75rem' }}>
                Cover what's overspent and top up any bill that's behind, from money in checking that no fund has claimed. Bills are never a source. Untick anything you'd rather leave.
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem', background: 'var(--bg)', border: `1px solid ${over ? 'var(--red)' : 'var(--border)'}`, borderRadius: '8px', padding: '0.6rem 0.8rem', marginBottom: '0.75rem', textAlign: 'center' }}>
                {[
                  { l: 'Unassigned', v: fmt(avail), c: 'var(--amber)' },
                  { l: 'Needed', v: fmt(need), c: 'var(--muted)' },
                  { l: 'Covering', v: fmt(total), c: over ? 'var(--red)' : 'var(--green)' },
                ].map(x => (
                  <div key={x.l}>
                    <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{x.l}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.95rem', color: x.c }}>{x.v}</div>
                  </div>
                ))}
              </div>
              {over && <div style={{ fontSize: '0.68rem', color: 'var(--red)', marginBottom: '0.5rem' }}>That's {fmt(total - avail)} more than is unassigned — untick or trim something.</div>}
              {balErr && <div style={{ fontSize: '0.7rem', color: 'var(--red)', marginBottom: '0.5rem' }}>⚠️ {balErr}</div>}

              <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '0.75rem' }}>
                {balRows.length === 0 && <div style={{ padding: '1rem', fontSize: '0.78rem', color: 'var(--muted)', textAlign: 'center' }}>Nothing is overspent or behind. The funds balance.</div>}
                {balRows.map((r, i) => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.45rem 0.7rem', borderBottom: i < balRows.length - 1 ? '1px solid var(--hairline)' : 'none', opacity: r.on ? 1 : 0.5 }}>
                    <input type="checkbox" checked={r.on} onChange={e => setRow(r.id, { on: e.target.checked })} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                      <div style={{ fontSize: '0.58rem', color: r.kind === 'bill' ? 'var(--amber)' : 'var(--red)', fontFamily: 'var(--font-mono)' }}>
                        {r.kind === 'bill' ? `bill behind pace by ${fmt(r.deficit)}` : `overspent ${fmt(r.deficit)}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0 0.4rem' }}>
                      <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>$</span>
                      <input type="number" step="0.01" value={r.amount} disabled={!r.on} onChange={e => setRow(r.id, { amount: e.target.value })}
                        style={{ width: '4.6rem', background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '0.82rem', fontFamily: 'var(--font-mono)', padding: '0.35rem 0', textAlign: 'right' }} />
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={() => setShowBalance(false)} style={{ flex: 1, background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.7rem', color: 'var(--muted)', fontSize: '0.8rem' }}>Cancel</button>
                <button onClick={applyBalance} disabled={balSaving || over || picks.length === 0}
                  style={{ flex: 2, background: over || picks.length === 0 ? 'var(--border)' : 'var(--green)', border: 'none', borderRadius: '8px', padding: '0.7rem', color: over || picks.length === 0 ? 'var(--muted)' : 'var(--onAccent)', fontWeight: 700, fontSize: '0.85rem' }}>
                  {balSaving ? 'Applying…' : `Apply · ${fmt(total)} from unassigned`}
                </button>
              </div>
              <div style={{ fontSize: '0.58rem', color: 'var(--muted)', textAlign: 'center', marginTop: '0.5rem', lineHeight: 1.45 }}>
                Each cover is recorded as an allocation, so Activity shows exactly what was balanced and when. The plan is untouched.
              </div>
            </div>
          </div>
        )
      })()}

      {/* True-up sheet — record what a fund actually holds right now */}
      {trueUp && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setTrueUp(null) }}>
          <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.5rem' }}>{pullMode ? 'Move money in' : moveMode ? 'Move money out' : 'True up fund'}</div>
            <div style={{ fontSize: '1rem', color: 'var(--text)', marginBottom: '0.5rem' }}>{trueUp.name}</div>

            <div style={{ fontSize: '0.72rem', color: 'var(--muted)', lineHeight: 1.5, marginBottom: '0.85rem' }}>
              Holding <b style={{ fontFamily: 'var(--font-mono)', color: trueUp.fundBalance < 0 ? 'var(--red)' : 'var(--text)' }}>{trueUp.fundBalance < 0 ? '-' : ''}{fmt(trueUp.fundBalance)}</b>
              {trueUp.soleOwn
                ? <> — the balance of <b style={{ color: 'var(--text)' }}>{trueUp.backedBy}</b>. To correct it, tap that account on the Accounts page.</>
                : <> — {fmt(trueUp.totalAllocated)} put in, {fmt(trueUp.spent)} spent.</>}
              {!trueUp.soleOwn && trueUp.fundBalance < 0 && ' This fund has lent out more than it holds.'}
            </div>

            {/* Three actions on one sheet: state the real balance, pull money in from
                another fund, or push it out. A line that is the only one in its own
                account has no envelope to true up, so it gets the two moves only. */}
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
              {[
                { k: 'set',  l: 'Set balance' },
                { k: 'pull', l: 'Move from…' },
                { k: 'move', l: 'Move to…' },
              ].filter(o => !(trueUp.soleOwn && o.k === 'set')).map(o => {
                const on = o.k === 'pull' ? pullMode : o.k === 'move' ? (moveMode && !pullMode) : (!moveMode && !pullMode)
                return (
                  <button key={o.k} onClick={() => { setPullMode(o.k === 'pull'); setMoveMode(o.k === 'move') }}
                    style={{ flex: 1, background: on ? 'var(--accent)' : 'transparent', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, color: on ? 'var(--onAccent)' : 'var(--muted)', borderRadius: '6px', padding: '0.4rem', fontSize: '0.75rem', fontWeight: on ? 700 : 400 }}>
                    {o.l}
                  </button>
                )
              })}
            </div>

            {pullMode ? (
              <>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Move from</label>
                <select value={pullFrom} onChange={e => { setPullFrom(e.target.value); setPullAmt('') }}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.85rem', outline: 'none', marginBottom: '0.35rem' }}>
                  <option value="">Choose a fund…</option>
                  {pullSources.map(f => (
                    <option key={f.id} value={f.id}>{f.name} · {fmt(f.safe)} available{f.ownAccount ? ` · ${f.backedBy}` : ''}</option>
                  ))}
                </select>
                <div style={{ fontSize: '0.6rem', color: 'var(--muted)', marginBottom: '0.85rem', lineHeight: 1.45 }}>
                  {pullSources.length === 0 ? 'No fund has spendable money to lend right now.' : 'Only funds with money to spare are offered. Bills aren’t — their money is reserved until they’re paid.'}
                </div>

                {(() => {
                  const src = funds.find(f => f.id === pullFrom)
                  if (!src) return null
                  const cap = Math.round(src.safe * 100) / 100
                  const amt = Math.min(+pullAmt || 0, cap)
                  return (
                    <>
                      <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Amount · up to {fmt(cap)}</label>
                      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.35rem' }}>
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: 'var(--bg)', border: `1px solid ${+pullAmt > cap ? 'var(--red)' : 'var(--accent)'}`, borderRadius: '8px', padding: '0 0.85rem' }}>
                          <span style={{ color: 'var(--accentL)', fontSize: '1.1rem', marginRight: '0.3rem' }}>$</span>
                          <input type="number" step="0.01" min="0" max={cap} value={pullAmt} autoFocus onChange={e => setPullAmt(e.target.value)} placeholder="0.00"
                            onKeyDown={e => { if (e.key === 'Enter') pullMoney() }}
                            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '1.3rem', fontFamily: 'var(--font-mono)', padding: '0.55rem 0' }} />
                        </div>
                        <button onClick={() => setPullAmt(String(cap))} title={`Everything ${src.name} has available`}
                          style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', padding: '0 0.8rem', color: 'var(--muted)', fontSize: '0.75rem' }}>all</button>
                      </div>
                      {+pullAmt > cap && <div style={{ fontSize: '0.66rem', color: 'var(--red)', marginBottom: '0.5rem' }}>Capped at {fmt(cap)} — that's all {src.name} has to spare.</div>}

                      <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', margin: '0.5rem 0 0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Why (optional)</label>
                      <input value={moveNote} onChange={e => setMoveNote(e.target.value)} placeholder="e.g. Thousand Trails due before payday"
                        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.85rem', outline: 'none', marginBottom: '0.85rem' }} />

                      {amt > 0 && (
                        <div style={{ fontSize: '0.66rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)', marginBottom: '0.85rem', lineHeight: 1.6 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>{src.name}</span><span>{fmt(src.safe)} → {fmt(src.safe - amt)}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>{trueUp.name}</span><span style={{ color: 'var(--green)' }}>{trueUp.fundBalance < 0 ? '-' : ''}{fmt(trueUp.fundBalance)} → {fmt(trueUp.fundBalance + amt)}</span>
                          </div>
                          {src.backingAccountId !== trueUp.backingAccountId && <div style={{ color: 'var(--amber)' }}>Different accounts — a real transfer is recorded too.</div>}
                        </div>
                      )}

                      <button onClick={pullMoney} disabled={trueUpSaving || !(amt > 0)}
                        style={{ width: '100%', background: amt > 0 ? 'var(--accent)' : 'var(--border)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: amt > 0 ? 'var(--onAccent)' : 'var(--muted)', fontWeight: 700, fontSize: '0.9rem' }}>
                        {trueUpSaving ? 'Moving…' : amt > 0 ? `Move ${fmt(amt)} from ${src.name}` : 'Move money in'}
                      </button>
                    </>
                  )
                })()}
              </>
            ) : moveMode ? (
              <>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Move to</label>
                <select value={moveTo} onChange={e => setMoveTo(e.target.value)}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.85rem', outline: 'none', marginBottom: '0.85rem' }}>
                  <option value="">Choose a fund…</option>
                  <option value="__pot__">↩ Back to unassigned — reallocate later</option>
                  <optgroup label="Another fund">
                    {funds.filter(f => f.id !== trueUp.id).map(f => (
                      <option key={f.id} value={f.id}>{f.name} ({fmt(f.fundBalance)})</option>
                    ))}
                  </optgroup>
                </select>

                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Amount</label>
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: '8px', padding: '0 0.85rem', marginBottom: '0.85rem' }}>
                  <span style={{ color: 'var(--accentL)', fontSize: '1.1rem', marginRight: '0.3rem' }}>$</span>
                  <input type="number" step="0.01" value={moveAmt} autoFocus onChange={e => setMoveAmt(e.target.value)} placeholder="0.00"
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '1.3rem', fontFamily: 'var(--font-mono)', padding: '0.55rem 0' }} />
                </div>

                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Why (optional)</label>
                <input value={moveNote} onChange={e => setMoveNote(e.target.value)} placeholder="e.g. trailer registration came in high"
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.85rem', outline: 'none', marginBottom: '0.85rem' }} />

                {+moveAmt > 0 && moveTo && (
                  <div style={{ fontSize: '0.66rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)', marginBottom: '0.85rem', lineHeight: 1.6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>{trueUp.name}</span>
                      <span style={{ color: (trueUp.fundBalance - +moveAmt) < 0 ? 'var(--red)' : 'var(--text)' }}>{fmt(trueUp.fundBalance)} → {(trueUp.fundBalance - +moveAmt) < 0 ? '-' : ''}{fmt(trueUp.fundBalance - +moveAmt)}</span>
                    </div>
                    {moveTo === '__pot__' ? (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>Unassigned in checking</span>
                        <span style={{ color: 'var(--amber)' }}>+{fmt(+moveAmt)} · assign it on Accounts, or the next check's leftover takes it</span>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{funds.find(f => f.id === moveTo)?.name}</span>
                        <span>{fmt(funds.find(f => f.id === moveTo)?.fundBalance || 0)} → {fmt((funds.find(f => f.id === moveTo)?.fundBalance || 0) + +moveAmt)}</span>
                      </div>
                    )}
                  </div>
                )}

                <button onClick={moveMoney} disabled={trueUpSaving || !moveTo || !(+moveAmt > 0)}
                  style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
                  {trueUpSaving ? 'Moving…' : moveTo === '__pot__' ? 'Return to unassigned' : 'Move money'}
                </button>
              </>
            ) : (
            <>
            <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Actual balance today</label>
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: '8px', padding: '0 0.85rem', marginBottom: '1rem' }}>
              <span style={{ color: 'var(--accentL)', fontSize: '1.1rem', marginRight: '0.3rem' }}>$</span>
              <input type="number" step="0.01" value={trueUpVal} autoFocus onChange={e => setTrueUpVal(e.target.value)} placeholder="0.00"
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '1.3rem', fontFamily: 'var(--font-mono)', padding: '0.55rem 0' }} />
            </div>

            <button onClick={saveTrueUp} disabled={trueUpSaving || trueUpVal === ''}
              style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
              {trueUpSaving ? 'Saving…' : 'Save balance'}
            </button>

            {trueUp.trued && (
              <button onClick={clearTrueUp} disabled={trueUpSaving}
                style={{ width: '100%', marginTop: '0.6rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.65rem', color: 'var(--muted)', fontSize: '0.78rem' }}>
                Clear the opening balance
              </button>
            )}
            </>
            )}

            {/* Top up from the pot - available whichever mode is showing */}
            <div style={{ marginTop: '1rem', paddingTop: '0.85rem', borderTop: '1px solid var(--hairline)' }}>
              <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Add from unassigned</label>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0 0.75rem' }}>
                  <span style={{ color: 'var(--muted)', fontSize: '1rem', marginRight: '0.3rem' }}>$</span>
                  <input type="number" step="0.01" value={addAmt} onChange={e => setAddAmt(e.target.value)} placeholder="0.00"
                    onKeyDown={e => { if (e.key === 'Enter') addFromPot() }}
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '1.05rem', fontFamily: 'var(--font-mono)', padding: '0.5rem 0' }} />
                </div>
                <button onClick={addFromPot} disabled={trueUpSaving || !(+addAmt > 0)}
                  style={{ background: +addAmt > 0 ? 'var(--green)' : 'var(--border)', border: 'none', borderRadius: '8px', padding: '0 1rem', color: +addAmt > 0 ? 'var(--onAccent)' : 'var(--muted)', fontWeight: 700, fontSize: '0.85rem' }}>
                  Add
                </button>
              </div>
              <div style={{ fontSize: '0.6rem', color: 'var(--muted)', marginTop: '0.35rem', lineHeight: 1.45 }}>
                Pulls from money in checking that no fund has claimed. A move, not a correction — the plan and the line's history are untouched.
                {trueUp.ownAccount && ' This fund lives in its own account, so the money really moves there.'}
              </div>
            </div>
          </div>
        </div>
      )}

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
          {recentErr && (
            <div style={{ fontSize: '0.72rem', color: 'var(--red)', padding: '1rem', lineHeight: 1.45 }}>⚠️ {recentErr}</div>
          )}
          {recent.length === 0 && !recentErr && (
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
