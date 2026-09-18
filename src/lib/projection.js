// Walk a balance forward: what checking will look like over the next stretch,
// given the paychecks that are due to land and the bills that are due to leave.
//
// Everything here is a projection from the schedule you have already told the
// app about — pay frequency and anchor on households, due dates and intervals on
// budget_items. Nothing is written; this only reads.
//
// Pure functions: no Supabase, no React.

import { addDays, addMonths, parseISO, startOfDay, startOfMonth, setDate, getDaysInMonth, isBefore, isAfter, format } from 'date-fns'
import { computeAccrual } from './accrual'

const round2 = (n) => Math.round(n * 100) / 100
const sameDay = (a, b) => format(a, 'yyyy-MM-dd') === format(b, 'yyyy-MM-dd')

// How much of one check a monthly plan implies. Approximate by design — it is a
// starting suggestion, not a rule. (Shared with the paycheck page.)
export const CHECKS_PER_MONTH = { weekly: 4, biweekly: 2, semimonthly: 2, monthly: 1 }

export function perCheckShare(monthlyAmount, payFrequency) {
  const checks = CHECKS_PER_MONTH[payFrequency || 'biweekly'] || 2
  return round2((+monthlyAmount || 0) / checks)
}

/** Paydays falling in [from, to], with the net amount expected on each. */
export function paydaysBetween(household, from, to) {
  const amount = +household?.paycheck_amount || 0
  const freq   = household?.pay_frequency || 'biweekly'
  const out    = []
  if (!amount) return out

  if (freq === 'monthly' || freq === 'semimonthly') {
    const days = freq === 'monthly'
      ? [+household?.paycheck_day_1 || 1]
      : [+household?.paycheck_day_1 || 1, +household?.paycheck_day_2 || 15]
    let cursor = startOfMonth(from)
    let guard = 0
    while (!isAfter(cursor, to) && guard++ < 120) {
      const dim = getDaysInMonth(cursor)
      for (const d of days) {
        const when = setDate(cursor, Math.min(d, dim))
        if (!isBefore(when, from) && !isAfter(when, to)) out.push({ date: when, amount })
      }
      cursor = addMonths(cursor, 1)
    }
  } else {
    // Weekly/bi-weekly are stepped from a known payday. Without an anchor there
    // is no way to place them, so return nothing rather than guess.
    if (!household?.pay_anchor_date) return out
    const step = freq === 'weekly' ? 7 : 14
    let d = startOfDay(parseISO(household.pay_anchor_date))
    while (isAfter(d, from)) d = addDays(d, -step)
    let guard = 0
    while (!isAfter(d, to) && guard++ < 400) {
      if (!isBefore(d, from)) out.push({ date: d, amount })
      d = addDays(d, step)
    }
  }
  return out.sort((a, b) => a.date - b.date)
}

/**
 * Dated charges falling in [from, to], one entry per occurrence. Three kinds of
 * line produce them; a flexible line with no due date produces none and is
 * handled as everyday spending instead.
 */
export function billsBetween(items, from, to, today = new Date()) {
  const out = []
  for (const it of items || []) {
    const interval = +it.interval_months || 0
    const push = (date, amount) => out.push({
      date, amount: round2(amount), name: it.name, itemId: it.id, accountId: it.account_id,
    })

    // 1. An accruing bill knows its own next due date and cycle length.
    const calc = computeAccrual(it, today)
    if (calc) {
      let due = calc.nextDue
      let guard = 0
      while (!isAfter(due, to) && guard++ < 60) {
        if (!isBefore(due, from)) push(due, calc.target)
        if (!(interval > 0)) break
        due = addMonths(due, interval)
      }
      continue
    }

    const amt = +it.bill_amount || +it.budgeted_amount || 0
    if (!amt) continue

    // 2. A fixed monthly bill: the same day every month.
    const isMonthly = interval === 1 || it.bill_frequency === 'monthly'
    const day = +it.due_day || 0
    if (isMonthly && day) {
      let cursor = startOfMonth(from)
      let guard = 0
      while (!isAfter(cursor, to) && guard++ < 120) {
        const when = setDate(cursor, Math.min(day, getDaysInMonth(cursor)))
        if (!isBefore(when, from) && !isAfter(when, to)) push(when, amt)
        cursor = addMonths(cursor, 1)
      }
      continue
    }

    // 3. A single dated charge someone entered by hand.
    if (it.next_due_date) {
      const when = startOfDay(parseISO(it.next_due_date))
      if (!isBefore(when, from) && !isAfter(when, to)) push(when, amt)
    }
  }
  return out.sort((a, b) => a.date - b.date)
}

/**
 * Day-by-day balance from `from` for `days` days.
 *
 * Each payday adds the net check and immediately removes the share that is
 * transferred out to savings-backed lines, because that money really does leave
 * checking on payday. Dated bills come off on their due date. Everyday spending
 * (groceries, fuel — lines with a monthly budget but no due date) is spread
 * evenly across the month rather than pretending it all lands at once.
 *
 * Returns { points, low, totalIn, totalOut } where points are
 * { date, balance, income, charges } and `low` is the worst day.
 */
export function projectDaily({ startBalance, from, days = 90, paydays = [], bills = [], monthlyEverydaySpend = 0, perPaydayToSavings = 0 }) {
  const start = startOfDay(from)
  const dailySpend = (+monthlyEverydaySpend || 0) / 30.44   // average month length
  let balance = +startBalance || 0
  const points = []
  let totalIn = 0, totalOut = 0

  for (let i = 0; i <= days; i++) {
    const date = addDays(start, i)
    let income = 0, charges = 0

    // Day 0 is today's actual balance — today's events are already in it.
    if (i > 0) {
      for (const p of paydays) if (sameDay(p.date, date)) {
        income += p.amount
        charges += perPaydayToSavings
      }
      for (const b of bills) if (sameDay(b.date, date)) charges += b.amount
      charges += dailySpend
      balance = balance + income - charges
      totalIn += income
      totalOut += charges
    }

    points.push({ date, balance: round2(balance), income: round2(income), charges: round2(charges) })
  }

  const low = points.reduce((worst, p) => (p.balance < worst.balance ? p : worst), points[0])
  return { points, low, totalIn: round2(totalIn), totalOut: round2(totalOut) }
}
