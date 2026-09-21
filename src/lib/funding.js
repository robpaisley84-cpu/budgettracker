// How each paycheck is split across the budget lines, and what each line has
// that is safe to spend. Pure functions - no Supabase, no React.
//
// Two kinds of line (migration 015):
//
//   scheduled  a bill with an amount and a due date. Each check contributes
//              whatever is still needed by the due date, split evenly across the
//              paydays left before it - so a bill due on the 15th is funded half
//              by the check on the 18th and half by the one on the 2nd, and a bill
//              due the day a check lands is topped up in full by that check. Its
//              money is reserved: safe to spend is zero unless it's over-funded.
//
//   flexible   an allowance per check. Safe to spend is simply what the envelope
//              holds - negative means overspent.
//
// The month never appears in here. Paydays come from the household's real
// schedule (paydaysBetween), so a three-check month is just three periods.

import { addMonths, addDays, parseISO, startOfDay, startOfMonth, setDate, getDaysInMonth, isBefore, isAfter, format, differenceInCalendarDays } from 'date-fns'
// Explicit extension so plain `node` can run the check scripts against these
// files directly (Vite resolves either form).
import { paydaysBetween, CHECKS_PER_YEAR } from './projection.js'

const round2 = (n) => Math.round(n * 100) / 100
const fmt    = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()

export const isScheduled = (line) => line?.funding_mode === 'scheduled'
export const isFlexible  = (line) => !isScheduled(line)   // unset counts as flexible

// Converting between the two units, for display and for accepting either as input.
export function perCheckToMonthly(perCheck, freq) {
  return round2((+perCheck || 0) * (CHECKS_PER_YEAR[freq] || 26) / 12)
}
export function monthlyToPerCheck(monthly, freq) {
  return round2(((+monthly || 0) * 12) / (CHECKS_PER_YEAR[freq] || 26))
}

/** The charge when a scheduled line comes due. */
export function billAmount(line) {
  return +line.bill_amount || +line.budgeted_amount || 0
}

/**
 * A payment landing within this many days AFTER a due date belongs to that due
 * date (it was late), not to the next one.
 */
export const LATE_GRACE_DAYS = 7

/**
 * The next date a scheduled line is due, on or after `onOrAfter`.
 *   monthly  -> next occurrence of due_day (clamped to the month's length)
 *   periodic -> next_due_date rolled forward by interval_months until it's ahead
 * Returns null when the line has no usable schedule.
 *
 * `lastPaid` (a Date, see lastPaymentFor) marks a bill PAID EARLY: a payment
 * inside the current cycle - after the previous due date plus the late grace -
 * means this due date is already met and the line is saving for the one after.
 * Rob pays Sam's Club around the 10th for the 23rd; without this the line would
 * read "behind $500" for two weeks every month.
 */
export function nextDue(line, onOrAfter = new Date(), lastPaid = null) {
  const due = rawNextDue(line, onOrAfter)
  if (!due || !lastPaid) return due
  const interval = Math.max(1, +line.interval_months || 1)
  const prevDue  = addMonths(due, -interval)
  const paid     = startOfDay(lastPaid)
  if (isAfter(paid, addDays(prevDue, LATE_GRACE_DAYS)) && !isAfter(paid, due)) return rawNextDue(line, addDays(due, 1))
  return due
}

/**
 * When a bill was last paid, from the expenses logged on its line: the latest
 * charge of at least half the bill. Half, so a fee or a partial logged on the
 * line doesn't pass for the payment. Null for allowances and lines with no amount.
 */
export function lastPaymentFor(line, txns) {
  if (isFlexible(line) || !(billAmount(line) > 0)) return null
  const min = billAmount(line) / 2
  let best = null
  for (const t of txns || []) {
    if (t.budget_item_id !== line.id || !(+t.amount >= min) || !t.date) continue
    const d = startOfDay(parseISO(String(t.date).slice(0, 10)))
    if (!best || isAfter(d, best)) best = d
  }
  return best
}

function rawNextDue(line, onOrAfter) {
  const from     = startOfDay(onOrAfter)
  const interval = +line.interval_months || 0

  if (interval === 1 || (!interval && line.due_day)) {
    const day = +line.due_day
    if (!day) return null
    let cursor = startOfMonth(from)
    for (let i = 0; i < 3; i++) {
      const d = setDate(cursor, Math.min(day, getDaysInMonth(cursor)))
      if (!isBefore(d, from)) return d
      cursor = addMonths(cursor, 1)
    }
    return null
  }

  if (line.next_due_date) {
    let d = startOfDay(parseISO(line.next_due_date))
    let guard = 0
    while (isBefore(d, from) && interval > 0 && guard++ < 120) d = addMonths(d, interval)
    return isBefore(d, from) ? null : d
  }
  return null
}

/**
 * How much of the check landing on `payday` goes to this line.
 *
 * `held` is what the envelope holds just before this check. `household` supplies
 * the pay schedule so the paydays between now and the due date can be counted -
 * this one included, and a payday ON the due date counts, because the money is in
 * the account when the bill hits.
 */
export function shareFor(line, { payday, held = 0, household, lastPaid = null }) {
  if (isFlexible(line)) return round2(+line.per_check_amount || 0)

  // A scheduled line with no amount has nothing to fund toward. Contributing to
  // it would quietly refill an unbudgeted overspend - that needs a decision, not
  // an allocation. The Schedule page lists these under "needs an amount".
  if (!(billAmount(line) > 0)) return 0

  const due = nextDue(line, payday, lastPaid)
  if (!due) return 0
  const need = billAmount(line) - (+held || 0)
  if (need <= 0) return 0

  const P = startOfDay(payday)
  const paydays = household ? paydaysBetween(household, P, due) : [P]
  const n = Math.max(1, paydays.filter(d => !isBefore(d, P) && !isAfter(d, due)).length)
  return round2(need / n)
}

/**
 * A bill is TIGHT when the last paycheck before its due date lands within this
 * many days of it - or when no paycheck lands before it at all. A tight bill is
 * held in full: a deposit that clears the same morning an autopay pulls is not
 * something to plan around. Everything else is funded lean, to its due date.
 */
export const TIGHT_DAYS = 3

/**
 * The one pace calculation behind reserved(), safeToSpend() and shortfall(),
 * so the three can never disagree.
 *
 * Pace runs from where saving for THIS cycle actually started. If the line's
 * anchor (the fiscal-year reset, or a true-up) falls inside the cycle, that is
 * the starting line and what "should" have been saved before it is water under
 * the bridge. Otherwise the cycle start. Even share = what's left to save from
 * that start, spread over the paydays from there to the due date.
 *
 * Returns null for anything that isn't a bill with an amount and a date.
 */
export function pace(line, { held = 0, today = new Date(), household, lastPaid = null }) {
  if (isFlexible(line) || !(billAmount(line) > 0)) return null
  const due = nextDue(line, today, lastPaid)
  if (!due) return null
  const from    = startOfDay(today)
  const bill    = billAmount(line)
  const paydays = household ? paydaysBetween(household, from, due) : []
  const n       = paydays.length
  const last    = paydays[n - 1]
  const tight   = !last || differenceInCalendarDays(due, last.date) <= TIGHT_DAYS

  const interval   = Math.max(1, +line.interval_months || 1)
  const cycleStart = addMonths(due, -interval)
  const anchor     = line.saved_as_of ? startOfDay(parseISO(line.saved_as_of)) : null
  const inCycle    = !!anchor && isAfter(anchor, cycleStart)
  const start      = inCycle ? anchor : cycleStart
  const base       = inCycle ? (+line.saved_so_far || 0) : 0
  const total      = household ? paydaysBetween(household, addDays(start, 1), due).length : Math.max(1, n)
  // A tight bill can't count on its LAST check - that's the one landing the
  // same morning - so it has to be met by the check before. The cycle is
  // therefore funded over one fewer check: a slightly steeper pace all the way
  // along, not a full share demanded up front. For a monthly bill due on payday
  // that means holding it all now; for an annual bill whose due date happens
  // to fall on a payday eleven months out, it means each check saves ~4% more.
  const usable     = tight ? Math.max(0, total - 1) : total
  const steady     = usable > 0 ? (bill - base) / usable : bill
  const fromChecks = steady * (tight ? Math.max(0, n - 1) : n)   // what future checks supply in time

  // requiredNow: what has to be in the envelope today for the bill to be met.
  return { due, bill, held: +held || 0, n, tight, steady, requiredNow: round2(Math.max(0, bill - fromChecks)) }
}

/** How much of a bill's balance is spoken for right now. 0 for an allowance. */
export function reserved(line, ctx) {
  const p = pace(line, ctx)
  if (!p) return 0
  return round2(Math.min(p.requiredNow, Math.max(0, p.held)))
}

/**
 * How far BEHIND PACE a scheduled line is - not how far from full. What you'd
 * have to add today so the bill is met on its due date given what future
 * checks will contribute. A tight bill must be met in full now.
 */
export function shortfall(line, ctx) {
  const p = pace(line, ctx)
  if (!p) return 0
  return round2(Math.max(0, p.requiredNow - p.held))
}

/**
 * Hayley's number: what can actually be spent from this line right now.
 * Allowance → its balance (negative = overspent). Bill → whatever it holds
 * beyond what's reserved. Without a pace context (no household), a bill is
 * treated as fully reserved - the conservative fallback.
 */
export function safeToSpend(line, balance, ctx) {
  const bal = round2(+balance || 0)
  // No bill amount means nothing is reserved - show the balance (an overspend
  // must stay visible, not hide behind "reserved $0").
  if (isFlexible(line) || !(billAmount(line) > 0)) return bal
  if (!ctx?.household) return round2(Math.max(0, bal - billAmount(line)))
  return round2(Math.max(0, bal - reserved(line, { ...ctx, held: bal })))
}

/** One line of plain English explaining a share, for the paycheck sheet. */
export function shareReason(line, { payday, held = 0, household, lastPaid = null }) {
  if (isFlexible(line)) return 'allowance'
  if (!(billAmount(line) > 0)) return 'no amount set — see Schedule'
  const due = nextDue(line, payday, lastPaid)
  if (!due) return 'no due date set'
  const need = billAmount(line) - (+held || 0)
  if (need <= 0) return `already holds the ${fmt(billAmount(line))} due ${format(due, 'MMM d')}`
  const P = startOfDay(payday)
  const paydays = household ? paydaysBetween(household, P, due) : [P]
  const n = Math.max(1, paydays.filter(d => !isBefore(d, P) && !isAfter(d, due)).length)
  const when = format(due, 'MMM d')
  if (n === 1) return `tops up the ${fmt(billAmount(line))} due ${when}`
  const frac = n === 2 ? '½' : n === 3 ? '⅓' : n === 4 ? '¼' : `1/${n}`
  return `${frac} of ${fmt(need)} still needed by ${when}`
}

/**
 * The full split of one check. Every non-remainder line gets shareFor; whatever
 * is left goes to the remainder line (the Exit Fund). Mirrors the row shape the
 * paycheck sheet already uses so it can drop straight in.
 *
 * `balances` is budget_item_id -> what the envelope holds before this check.
 * `lastPaid` is budget_item_id -> Date of the bill's last payment (lastPaymentFor),
 * so a bill already paid this cycle is funded toward the following due date.
 * The remainder line's own share is ignored - it absorbs the leftover, plan or not.
 */
export function planForCheck(lines, { payday, net, balances = {}, household, checkingId, lastPaid = {} }) {
  const rows = (lines || []).map(l => {
    const held  = balances[l.id] || 0
    const paid  = lastPaid[l.id] || null
    const share = l.is_remainder_target ? 0 : shareFor(l, { payday, held, household, lastPaid: paid })
    return {
      id: l.id,
      name: l.name,
      icon: l.category?.icon || '📋',
      catSort: l.category?.sort_order ?? 99,
      suggested: share,
      reason: l.is_remainder_target ? 'gets the leftover' : shareReason(l, { payday, held, household, lastPaid: paid }),
      accountId: l.account_id,
      ownAccount: !!(l.account_id && checkingId && l.account_id !== checkingId),
      isRemainder: !!l.is_remainder_target,
      scheduled: isScheduled(l),
      amount: '',
    }
  }).sort((a, b) => (a.isRemainder - b.isRemainder) || a.catSort - b.catSort || a.name.localeCompare(b.name))

  let assigned = 0
  for (const r of rows) {
    if (r.isRemainder) continue
    r.amount = String(r.suggested)
    assigned += r.suggested
  }
  const target = rows.find(r => r.isRemainder)
  if (target) target.amount = String(Math.max(0, round2((+net || 0) - assigned)))
  return rows
}

/** Days until a scheduled line is next due, for sorting and colour. */
export function daysUntilDue(line, today = new Date()) {
  const due = nextDue(line, today)
  return due ? differenceInCalendarDays(due, startOfDay(today)) : null
}
