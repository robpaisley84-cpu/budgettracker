import { parseISO, addMonths, differenceInCalendarMonths, differenceInCalendarDays, startOfDay, isBefore, format } from 'date-fns'

// Sinking-fund accrual for bills that recur on any span (every N months).
//
// The monthly set-aside prorates whatever's LEFT to save over the months left:
//
//   accrual = (bill_amount − saved_so_far) ÷ months from saved_as_of to next_due
//
// That rate is locked for the cycle by the (saved_so_far, saved_as_of) anchor, so
// it stays steady month to month — a behind bill prorates its catch-up over the
// remaining months, then drops back to the base rate once it's paid (the cycle
// resets the fund to 0). Leaving saved_so_far NULL means "assume on-track": the
// fund is treated as empty at the last payment and accrues the base rate.

const round2 = (n) => Math.round(n * 100) / 100
const iso    = (d) => format(d, 'yyyy-MM-dd')

/** A bill the app computes the monthly number for. Monthly bills (interval 1) accrue to themselves, so they're excluded. */
export function isAutoAccrued(item) {
  return !!(item?.auto_accrue && +item?.bill_amount > 0 && +item?.interval_months > 1)
}

/** Human label for an interval — 1/3/6/12 get names, anything else is "every N months". */
export function intervalLabel(months) {
  const n = +months
  return { 1: 'Monthly', 2: 'Every 2 months', 3: 'Quarterly', 4: 'Every 4 months', 6: 'Semiannual', 12: 'Annual', 24: 'Every 2 years' }[n] || `Every ${n} months`
}

/**
 * Returns null when the item isn't an auto-accruing bill or has no schedule yet.
 * Otherwise: { accrual, accrued, saved, target, perMonth, monthsRemaining,
 *              nextDue, lastPaid, daysUntil, rolledCycles, needsCatchUp, dates }
 * `dates` is set only when a cycle rolled forward and should be persisted.
 */
export function computeAccrual(item, today = new Date()) {
  if (!isAutoAccrued(item)) return null

  const amount   = +item.bill_amount
  const interval = +item.interval_months
  const now      = startOfDay(today)

  let lastPaid = item.last_paid_date ? parseISO(item.last_paid_date) : null
  let nextDue  = item.next_due_date  ? parseISO(item.next_due_date)
               : lastPaid            ? addMonths(lastPaid, interval)
               : null
  if (!nextDue) return null // amount + interval set, but no dates yet — unscheduled

  // The fund balance is anchored at a point in time. When the user records a
  // real "set aside so far", saved_as_of is stamped to that day; otherwise the
  // fund is assumed empty at the last payment (base-rate accrual, on-track case).
  const tracked = item.saved_so_far != null
  let saved  = tracked ? +item.saved_so_far : 0
  let anchor = item.saved_as_of ? parseISO(item.saved_as_of)
             : lastPaid         ? lastPaid
             :                    now

  // Advance any fully-elapsed cycles. Each roll treats the old due date as the
  // payment date, which empties the fund and starts the next cycle.
  let rolledCycles = 0
  while (isBefore(nextDue, now)) {
    lastPaid = nextDue
    nextDue  = addMonths(nextDue, interval)
    saved    = 0
    anchor   = lastPaid
    rolledCycles++
    if (rolledCycles > 120) break // guard against a nonsense interval
  }

  const perMonth        = amount / interval
  const monthsAnchorDue = Math.max(1, differenceInCalendarMonths(nextDue, anchor))
  const accrual         = Math.max(0, round2((amount - saved) / monthsAnchorDue)) // locked for the cycle
  const monthsElapsed   = Math.max(0, differenceInCalendarMonths(now, anchor))
  const accrued         = Math.min(amount, round2(saved + accrual * monthsElapsed)) // projected balance today
  const monthsRemaining = Math.max(1, differenceInCalendarMonths(nextDue, now))

  return {
    accrual,                       // what to budget this month
    accrued,                       // projected balance in the envelope today
    saved: round2(saved),          // the anchored real balance
    target: amount,
    perMonth: round2(perMonth),    // the straight-divide baseline, for comparison
    monthsRemaining,
    nextDue,
    lastPaid,
    daysUntil: differenceInCalendarDays(nextDue, now),
    rolledCycles,
    needsCatchUp: accrual > round2(perMonth) + 0.01,
    // Only present when the schedule moved — caller persists these.
    dates: rolledCycles > 0
      ? { last_paid_date: iso(lastPaid), next_due_date: iso(nextDue), saved_so_far: 0, saved_as_of: iso(lastPaid) }
      : null,
  }
}

/**
 * Rows whose stored budgeted_amount / schedule no longer match the computed
 * accrual, as Supabase-ready patches. Returns [] when everything is current.
 */
export function pendingSyncs(items, today = new Date()) {
  const out = []
  for (const item of items || []) {
    const calc = computeAccrual(item, today)
    if (!calc) continue
    const patch = { ...(calc.dates || {}) }
    if (Math.abs(+item.budgeted_amount - calc.accrual) >= 0.01) patch.budgeted_amount = calc.accrual
    if (Object.keys(patch).length) out.push({ id: item.id, patch })
  }
  return out
}

/** Next due date implied by a payment date + interval — used to keep the two fields in sync in the editor. */
export function dueFromLastPaid(lastPaidISO, intervalMonths) {
  if (!lastPaidISO || !intervalMonths) return ''
  return iso(addMonths(parseISO(lastPaidISO), +intervalMonths))
}
