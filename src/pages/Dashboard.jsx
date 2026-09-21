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
import { isScheduled, safeToSpend as safeToSpendFor, nextDue, billAmount } from '../lib/funding'

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
  const [moveTo, setMoveTo]           = useState('')
  const [moveAmt, setMoveAmt]         = useState('')
  const [moveNote, setMoveNote]       = useState('')
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
      const due       = scheduled ? nextDue(item, new Date()) : null

      return {
        backedBy: backing?.name || null,
        backingAccountId: backing?.id || null,
        ownAccount,
        soleOwn,
        isRemainderTarget: !!item.is_remainder_target,
        id: item.id,
        name: item.name,
        scheduled,
        safe: safeToSpendFor(item, balance),
        tier: item.tier || 'essential',
        // The number the row displays - a bill shows what it holds, an allowance
        // what's spendable - so the list can sort by what the eye sees.
        shown: (scheduled && billAmount(item) > 0) ? balance : safeToSpendFor(item, balance),
        bill: scheduled ? billAmount(item) : null,
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

  const buffer = NET_MO - summary.spent
  const bufColor = buffer >= 1000 ? 'var(--green)' : buffer >= 0 ? 'var(--amber)' : 'var(--red)'

  // Income minus what's gone AND what's still owed on bills this month.
  const safeToSpend = Math.round((NET_MO - summary.spent - committed) * 100) / 100

  // Carry-over: does this month's income cover the full budget? Lean (2-check) months
  // need money carried in from a prior surplus; extra-check months build the reserve.
  const monthNet = NET_MO - summary.budgeted

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
  const yearIncome = perCheck * (CHECKS_PER_YEAR[payFreq] || 26)  // true annual, not the current month × 12

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

  function openTrueUp(f) {
    setTrueUp(f)
    setTrueUpVal(f.fundBalance != null ? String(Math.round(f.fundBalance * 100) / 100) : '')
    // A line that is its own account has no envelope to true up — its balance
    // is set on the Accounts page — so open straight onto Move money.
    setMoveMode(!!f.soleOwn); setMoveTo(''); setMoveAmt(''); setMoveNote('')
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
    const { error } = await supabase.from('paycheck_allocations').insert([
      { ...base, budget_item_id: trueUp.id, amount: -amt, note: moveNote || `Moved to ${dest?.name || 'another fund'}` },
      { ...base, budget_item_id: moveTo,    amount:  amt, note: moveNote || `Moved from ${trueUp.name}` },
    ])
    if (error) { setTrueUpSaving(false); setRecentErr(`Couldn't move money: ${error.message}`); return }

    // If the two lines live in different accounts, the money has to move at
    // the bank too — record the real transfer so both account balances follow.
    if (trueUp.backingAccountId && dest?.backingAccountId && trueUp.backingAccountId !== dest.backingAccountId) {
      const { error: tErr } = await supabase.from('transactions').insert({
        household_id: household.id,
        account_id: trueUp.backingAccountId,
        to_account_id: dest.backingAccountId,
        type: 'transfer',
        amount: amt,
        description: moveNote || `Moved: ${trueUp.name} → ${dest.name}`,
        date: today, budget_month: today.slice(0, 7),
      })
      if (tErr) { setTrueUpSaving(false); setRecentErr(`Envelopes moved, but the account transfer didn't save: ${tErr.message}`); return }
    }
    setTrueUpSaving(false)
    setTrueUp(null); setMoveTo(''); setMoveAmt(''); setMoveNote(''); setMoveMode(false)
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button onClick={() => setViewMonth(d => subMonths(d, 1))} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '5px', width: '28px', height: '28px', fontSize: '1rem' }}>‹</button>
          <h1 style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)', textAlign: 'center' }}>{format(viewMonth, 'MMMM yyyy')}</h1>
          <button onClick={() => setViewMonth(d => addMonths(d, 1))} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '5px', width: '28px', height: '28px', fontSize: '1rem' }}>›</button>
        </div>
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
        const checkingAcc = accounts.find(a => a.type === 'checking')
        const inChk  = (f) => f.backingAccountId === checkingAcc?.id
        const isBill = (f) => f.scheduled && f.bill > 0
        const flex   = funds.filter(f => inChk(f) && !isBill(f))
        const spendNet   = flex.reduce((s, f) => s + f.safe, 0)
        const spendPos   = flex.reduce((s, f) => s + (f.safe > 0 ? f.safe : 0), 0)
        const overspent  = flex.reduce((s, f) => s + (f.safe < 0 ? f.safe : 0), 0)
        const inSavings  = funds.filter(f => !inChk(f) && !isBill(f)).reduce((s, f) => s + Math.max(0, f.safe), 0)
        const unassigned = checkingAcc ? +checkingAcc.balance - funds.filter(inChk).reduce((s, f) => s + f.fundBalance, 0) : null
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
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.6rem', color: spendNet < 0 ? 'var(--red)' : 'var(--accentL)', lineHeight: 1 }}>
                  {spendNet < 0 ? '-' : ''}{fmt(spendNet)}
                </div>
                <div style={{ fontSize: '0.62rem', color: 'var(--muted)', marginTop: '0.25rem', lineHeight: 1.5 }}>
                  to spend from checking
                  {overspent < 0 && <> · <span style={{ color: 'var(--green)' }}>{fmt(spendPos)}</span> in envelopes <span style={{ color: 'var(--red)' }}>−{fmt(overspent)}</span> overspent</>}
                </div>
                {unassigned != null && Math.abs(unassigned) >= 1 && (
                  <div style={{ fontSize: '0.62rem', marginTop: '0.15rem' }}>
                    <Link to="/accounts" style={{ color: 'var(--amber)', textDecoration: 'none' }}>
                      {unassigned > 0 ? '+' : ''}{fmt(unassigned)} unassigned in checking — assign it →
                    </Link>
                  </div>
                )}
                {inSavings > 0 && (
                  <div style={{ fontSize: '0.58rem', color: 'var(--muted)', marginTop: '0.15rem' }}>{fmt(inSavings)} in savings accounts, not counted</div>
                )}
              </div>
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
                // Same rule as the headline: a scheduled line with no amount counts as an overspend
                const spend    = g.items.reduce((s, f) => s + (!isBill(f) && f.safe > 0 ? f.safe : 0), 0)
                const held     = g.items.reduce((s, f) => s + (isBill(f) ? Math.max(0, f.fundBalance) : 0), 0)
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
                      {/* Green big numbers are spendable. A bill's big number is what it
                          HOLDS, in grey - it's spoken for, not spendable - so a fully funded
                          loan never reads as "empty". Amber if it's behind. */}
                      <div style={{ textAlign: 'right' }}>
                        {f.scheduled && f.bill > 0 ? (() => {
                          const short = f.bill - f.fundBalance
                          const behind = short > 0.5
                          return (
                            <>
                              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.92rem', fontWeight: 600, color: behind ? 'var(--amber)' : 'var(--muted)' }}>
                                {f.fundBalance < 0 ? '-' : ''}{fmt(f.fundBalance)}
                              </div>
                              <div style={{ fontSize: '0.52rem', color: behind ? 'var(--amber)' : 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
                                {behind ? `short ${fmt(short)}` : f.safe >= 1 ? `reserved · ${fmt(f.safe)} spare` : 'reserved'}
                              </div>
                            </>
                          )
                        })() : (
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.92rem', fontWeight: 600, color: safeColor }}>
                            {f.safe < 0 ? '-' : ''}{fmt(f.safe)}
                          </div>
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
                  Biggest first within each tier · tap a header to fold it · tap a fund to set its balance or move money
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Key metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '1rem' }}>
        {[
          { l: `Monthly Income (${payCount}×)`, v: fmt(NET_MO), c: 'var(--green)' },
          { l: 'Spent This Month', v: fmt(summary.spent), c: 'var(--accentL)' },
          { l: 'Budget', v: fmt(summary.budgeted), c: 'var(--muted)' },
          { l: 'Income Left', v: fmt(buffer), c: bufColor },
        ].map(x => (
          <div key={x.l} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.85rem' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.25rem' }}>{x.l}</div>
            <div style={{ fontSize: '1.25rem', fontFamily: 'var(--font-mono)', fontWeight: 500, color: x.c }}>{x.v}</div>
          </div>
        ))}
      </div>

      {/* Safe to spend — income left after everything still owed this month.
          "Income Left" above is income minus spend only, which counts unpaid
          bills as available; this is the number you can actually act on. */}
      <div style={{ background: 'var(--card)', border: `1px solid ${safeToSpend < 0 ? 'var(--red)' : 'var(--accent)'}`, borderRadius: 'var(--radius)', padding: '0.85rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.6rem', marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Safe to Spend</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', color: safeToSpend < 0 ? 'var(--red)' : 'var(--accentL)' }}>
            {safeToSpend < 0 ? '-' : ''}{fmt(safeToSpend)}
          </div>
        </div>
        <div style={{ fontSize: '0.62rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)', lineHeight: 1.6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Income this month</span><span>{fmt(NET_MO)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Spent so far</span><span>−{fmt(summary.spent)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Bills &amp; set-asides still owed</span><span>−{fmt(committed)}</span></div>
        </div>
        <div style={{ fontSize: '0.6rem', color: 'var(--muted)', marginTop: '0.5rem', lineHeight: 1.45 }}>
          Flexible lines like groceries aren't deducted — that's the money this figure is telling you about.
        </div>
      </div>

      {/* Carry-over from previous month */}
      <div style={{ background: 'var(--card)', border: `1px solid ${monthNet < 0 ? 'var(--red)' : 'var(--green)'}`, borderRadius: 'var(--radius)', padding: '0.85rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.6rem' }}>
          <div>
            <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.25rem' }}>
              {monthNet < 0 ? 'Carry-over needed' : 'Building reserve'}
            </div>
            <div style={{ fontSize: '1.35rem', fontFamily: 'var(--font-mono)', fontWeight: 500, color: monthNet < 0 ? 'var(--red)' : 'var(--green)' }}>
              {monthNet >= 0 ? '+' : ''}{fmt(monthNet)}
            </div>
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textAlign: 'right', maxWidth: '60%', lineHeight: 1.4 }}>
            {payCount} paycheck{payCount !== 1 ? 's' : ''} this month.{' '}
            {monthNet < 0
              ? `Income (${fmt(NET_MO)}) is under budget (${fmt(summary.budgeted)}) — cover the gap from last month's surplus.`
              : `Income covers the budget — set this aside for lean months.`}
          </div>
        </div>
      </div>

      {/* Priorities vs income (tiers) */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.85rem', marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.6rem' }}>Priorities vs income</div>
        {(() => {
          const rows = [
            { k: 'essential', label: 'Essentials',    color: 'var(--tierE)' },
            { k: 'lifestyle', label: 'Lifestyle',     color: 'var(--tierL)' },
            { k: 'savings',   label: 'Savings goals', color: 'var(--tierS)' },
          ]
          let cum = 0
          return rows.map((t, i) => {
            cum += tierTotals[t.k] || 0
            const covered = cum <= NET_MO
            const isSavings = t.k === 'savings'
            return (
              <div key={t.k} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.32rem 0', borderTop: i > 0 ? '1px solid var(--hairline)' : 'none' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: t.color, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text)' }}>{t.label}{isSavings && <span style={{ fontSize: '0.6rem', color: 'var(--muted)' }}> · bonus-funded</span>}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: t.color }}>{fmt(tierTotals[t.k] || 0)}</span>
                <span style={{ fontSize: '0.7rem', minWidth: '1.2rem', textAlign: 'right', color: isSavings ? 'var(--muted)' : covered ? 'var(--green)' : 'var(--amber)' }}>{isSavings ? '·' : covered ? '✓' : '△'}</span>
              </div>
            )
          })
        })()}
        <div style={{ fontSize: '0.64rem', color: 'var(--muted)', marginTop: '0.5rem' }}>
          ✓ = covered by this month's income ({fmt(NET_MO)}). Savings goals are meant for bonuses &amp; 3-paycheck months.
        </div>
      </div>

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

      {/* True-up sheet — record what a fund actually holds right now */}
      {trueUp && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setTrueUp(null) }}>
          <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.5rem' }}>{moveMode ? 'Move money' : 'True up fund'}</div>
            <div style={{ fontSize: '1rem', color: 'var(--text)', marginBottom: '0.5rem' }}>{trueUp.name}</div>

            <div style={{ fontSize: '0.72rem', color: 'var(--muted)', lineHeight: 1.5, marginBottom: '0.85rem' }}>
              Holding <b style={{ fontFamily: 'var(--font-mono)', color: trueUp.fundBalance < 0 ? 'var(--red)' : 'var(--text)' }}>{trueUp.fundBalance < 0 ? '-' : ''}{fmt(trueUp.fundBalance)}</b>
              {trueUp.soleOwn
                ? <> — the balance of <b style={{ color: 'var(--text)' }}>{trueUp.backedBy}</b>. To correct it, tap that account on the Accounts page.</>
                : <> — {fmt(trueUp.totalAllocated)} put in, {fmt(trueUp.spent)} spent.</>}
              {!trueUp.soleOwn && trueUp.fundBalance < 0 && ' This fund has lent out more than it holds.'}
            </div>

            {/* Two actions on one sheet: state the real balance, or move dollars
                out. A line that is the only one in its own account only gets the second. */}
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
              {[{ k: false, l: 'Set balance' }, { k: true, l: 'Move money' }].filter(o => !(trueUp.soleOwn && o.k === false)).map(o => (
                <button key={String(o.k)} onClick={() => setMoveMode(o.k)}
                  style={{ flex: 1, background: moveMode === o.k ? 'var(--accent)' : 'transparent', border: `1px solid ${moveMode === o.k ? 'var(--accent)' : 'var(--border)'}`, color: moveMode === o.k ? 'var(--onAccent)' : 'var(--muted)', borderRadius: '6px', padding: '0.4rem', fontSize: '0.75rem', fontWeight: moveMode === o.k ? 700 : 400 }}>
                  {o.l}
                </button>
              ))}
            </div>

            {moveMode ? (
              <>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Move to</label>
                <select value={moveTo} onChange={e => setMoveTo(e.target.value)}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.85rem', outline: 'none', marginBottom: '0.85rem' }}>
                  <option value="">Choose a fund…</option>
                  {funds.filter(f => f.id !== trueUp.id).map(f => (
                    <option key={f.id} value={f.id}>{f.name} ({fmt(f.fundBalance)})</option>
                  ))}
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
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>{funds.find(f => f.id === moveTo)?.name}</span>
                      <span>{fmt(funds.find(f => f.id === moveTo)?.fundBalance || 0)} → {fmt((funds.find(f => f.id === moveTo)?.fundBalance || 0) + +moveAmt)}</span>
                    </div>
                  </div>
                )}

                <button onClick={moveMoney} disabled={trueUpSaving || !moveTo || !(+moveAmt > 0)}
                  style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
                  {trueUpSaving ? 'Moving…' : 'Move money'}
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
