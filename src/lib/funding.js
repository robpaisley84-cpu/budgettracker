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
 * The next date a scheduled line is due, on or after `onOrAfter`.
 *   monthly  -> next occurrence of due_day (clamped to the month's length)
 *   periodic -> next_due_date rolled forward by interval_months until it's ahead
 * Returns null when the line has no usable schedule.
 */
export function nextDue(line, onOrAfter = new Date()) {
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
export function shareFor(line, { payday, held = 0, household }) {
  if (isFlexible(line)) return round2(+line.per_check_amount || 0)

  // A scheduled line with no amount has nothing to fund toward. Contributing to
  // it would quietly refill an unbudgeted overspend - that needs a decision, not
  // an allocation. The Schedule page lists these under "needs an amount".
  if (!(billAmount(line) > 0)) return 0

  const due = nextDue(line, payday)
  if (!due) return 0
  const need = billAmount(line) - (+held || 0)
  if (need <= 0) return 0

  const P = startOfDay(payday)
  const paydays = household ? paydaysBetween(household, P, due) : [P]
  const n = Math.max(1, paydays.filter(d => !isBefore(d, P) && !isAfter(d, due)).length)
  return round2(need / n)
}

/**
 * How far BEHIND PACE a scheduled line is - not how far from full.
 *
 * An annual bill is meant to fill over its whole cycle, so "bill minus held"
 * is the wrong question for eleven months of the year. The right one: if the
 * remaining checks each put in the even share for this cycle, would it be full
 * on the due date? The shortfall is what you'd have to add today to make that
 * true. On pace or ahead → 0. A monthly bill kept one payment ahead comes out
 * the same as before (it should already be nearly full).
 */
export function shortfall(line, { held = 0, today = new Date(), household }) {
  if (isFlexible(line) || !(billAmount(line) > 0)) return 0
  const due = nextDue(line, today)
  if (!due) return 0
  const from = startOfDay(today)
  const bill = billAmount(line)
  const need = bill - (+held || 0)
  if (need <= 0) return 0

  // No payday before it's due: nothing is coming to help, so whatever is still
  // needed has to be found now. (Thousand Trails due the 1st, check on the 2nd.)
  const n = household ? paydaysBetween(household, from, due).length : 1
  if (n === 0) return round2(need)

  // Pace runs from where saving for THIS cycle actually started. If the line's
  // anchor (the fiscal-year reset, or a true-up) falls inside the cycle, that
  // is the starting line and what "should" have been saved before it is water
  // under the bridge. Otherwise the cycle start. Even share = what's left to
  // save from that start, spread over the paydays from there to the due date.
  const interval   = Math.max(1, +line.interval_months || 1)
  const cycleStart = addMonths(due, -interval)
  const anchor     = line.saved_as_of ? startOfDay(parseISO(line.saved_as_of)) : null
  const inCycle    = !!anchor && isAfter(anchor, cycleStart)
  const start      = inCycle ? anchor : cycleStart
  const base       = inCycle ? (+line.saved_so_far || 0) : 0
  const total      = household ? paydaysBetween(household, addDays(start, 1), due).length : n
  const steady     = total > 0 ? (bill - base) / total : need
  return round2(Math.max(0, need - steady * n))
}

/** Hayley's number: what can actually be spent from this line right now. */
export function safeToSpend(line, balance) {
  // No bill amount means nothing is reserved - show the balance (an overspend
  // must stay visible, not hide behind "reserved $0").
  if (isFlexible(line) || !(billAmount(line) > 0)) return round2(+balance || 0)
  return round2(Math.max(0, (+balance || 0) - billAmount(line)))
}

/** One line of plain English explaining a share, for the paycheck sheet. */
export function shareReason(line, { payday, held = 0, household }) {
  if (isFlexible(line)) return 'allowance'
  if (!(billAmount(line) > 0)) return 'no amount set — see Schedule'
  const due = nextDue(line, payday)
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
 * The remainder line's own share is ignored - it absorbs the leftover, plan or not.
 */
export function planForCheck(lines, { payday, net, balances = {}, household, checkingId }) {
  const rows = (lines || []).map(l => {
    const held  = balances[l.id] || 0
    const share = l.is_remainder_target ? 0 : shareFor(l, { payday, held, household })
    return {
      id: l.id,
      name: l.name,
      icon: l.category?.icon || '📋',
      catSort: l.category?.sort_order ?? 99,
      suggested: share,
      reason: l.is_remainder_target ? 'gets the leftover' : shareReason(l, { payday, held, household }),
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
