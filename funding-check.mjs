// Sanity checks for src/lib/funding.js - not part of the app.
// Run:  node funding-check.mjs      (same pattern as test-accrual.mjs)
import { nextDue, shareFor, safeToSpend, shareReason, planForCheck, monthlyToPerCheck, shortfall } from './src/lib/funding.js'
import { format } from 'date-fns'

const hh = { paycheck_amount: 3801.71, pay_frequency: 'biweekly', pay_anchor_date: '2026-09-04' }
const d  = (s) => new Date(s + 'T12:00')
const on = (s) => format(s, 'MMM d')
let fails = 0
const check = (label, got, want) => {
  const ok = Math.abs(got - want) < 0.011
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}, want ${want}`)
}

// --- Rob's two real bills -------------------------------------------------
const wheel = { name: '5th Wheel Loan', funding_mode: 'scheduled', interval_months: 1, due_day: 15, bill_amount: 835.77 }
const truck = { name: 'Truck Loan',     funding_mode: 'scheduled', interval_months: 1, due_day: 2,  bill_amount: 677 }

console.log('\n5th Wheel due', on(nextDue(wheel, d('2026-09-18'))), '(want Oct 15)')
check('5th Wheel · Sept 18 check, holds 0.23', shareFor(wheel, { payday: d('2026-09-18'), held: 0.23, household: hh }), 417.77)
check('5th Wheel · Oct 2 check, holds 418.00', shareFor(wheel, { payday: d('2026-10-02'), held: 418.00, household: hh }), 417.77)
console.log('  reason:', shareReason(wheel, { payday: d('2026-09-18'), held: 0.23, household: hh }))

console.log('\nTruck Loan due', on(nextDue(truck, d('2026-09-18'))), '(want Oct 2)')
check('Truck · Sept 18 check, holds -0.33', shareFor(truck, { payday: d('2026-09-18'), held: -0.33, household: hh }), 338.67)
check('Truck · Oct 2 check, holds 338.34',  shareFor(truck, { payday: d('2026-10-02'), held: 338.34, household: hh }), 338.66)
console.log('  reason (Oct 2):', shareReason(truck, { payday: d('2026-10-02'), held: 338.34, household: hh }))

// After Truck Loan is paid on Oct 2, the Oct 16 check starts on November's
console.log('\nTruck after paying Oct 2 → next due', on(nextDue(truck, d('2026-10-03'))), '(want Nov 2)')
check('Truck · Oct 16 check, holds 0, Nov 2 due → 2 checks', shareFor(truck, { payday: d('2026-10-16'), held: 0, household: hh }), 338.50)

// --- Edge cases -----------------------------------------------------------
check('over-funded bill contributes 0', shareFor(wheel, { payday: d('2026-09-18'), held: 900, household: hh }), 0)
check('due before next payday → full top-up',
  shareFor({ ...truck, due_day: 20 }, { payday: d('2026-09-18'), held: 100, household: hh }), 577)
check('flexible line is constant', shareFor({ funding_mode: 'flexible', per_check_amount: 623.08 }, { payday: d('2026-09-18'), household: hh }), 623.08)
check('unset funding_mode counts as flexible', shareFor({ per_check_amount: 50 }, { payday: d('2026-09-18'), household: hh }), 50)

// Annual bill: next_due_date rolls forward past today
const reg = { name: 'Truck Reg', funding_mode: 'scheduled', interval_months: 12, next_due_date: '2026-02-20', bill_amount: 240 }
console.log('\nAnnual reg due', on(nextDue(reg, d('2026-09-18'))), '(want Feb 20 2027)')
const regShare = shareFor(reg, { payday: d('2026-09-18'), held: 0, household: hh })
// Sept 18 → Feb 20: Sep 18, Oct 2/16/30, Nov 13/27, Dec 11/25, Jan 8/22, Feb 5/19 = 12
console.log('  annual share from Sept 18 across 12 checks:', regShare, '(want 20)')
check('annual share', regShare, 240 / 12)

// --- Behind pace, not "below full" ----------------------------------------
// RV Insurance: $1081 due Aug 6 2027, cycle 12 months = 26 checks, even share 41.58.
// From Sept 21 2026 there are 23 paydays left -> on pace means holding 1081 - 41.58*23 = 124.7.
const rv = { funding_mode: 'scheduled', interval_months: 12, next_due_date: '2027-08-06', bill_amount: 1081 }
check('annual bill on pace shows 0 behind',   shortfall(rv, { held: 125, today: d('2026-09-21'), household: hh }), 0)
check('annual bill 35 behind pace',           shortfall(rv, { held: 90.08, today: d('2026-09-21'), household: hh }), 990.92 - (1081 * 12 / (26 * 12)) * 23)
check('annual bill ahead of pace shows 0',    shortfall(rv, { held: 400, today: d('2026-09-21'), household: hh }), 0)
check('monthly bill full is not behind',      shortfall(wheel, { held: 836.23, today: d('2026-09-21'), household: hh }), 0)
check('monthly bill empty, one check left → behind by bill minus one even share',
  shortfall(truck, { held: 0, today: d('2026-09-21'), household: hh }), 677 - 677 * 12 / 26)

// --- Safe to spend -------------------------------------------------------
check('flexible safe = balance', safeToSpend({ funding_mode: 'flexible' }, 284.65), 284.65)
check('flexible safe can be negative', safeToSpend({ funding_mode: 'flexible' }, -231.27), -231.27)
check('scheduled safe = 0 when under-funded', safeToSpend(wheel, 418), 0)
check('scheduled safe = surplus when over-funded', safeToSpend(wheel, 900), 64.23)

// --- Conversions ---------------------------------------------------------
check('1350/mo groceries → per check', monthlyToPerCheck(1350, 'biweekly'), 623.08)

// --- Whole check ---------------------------------------------------------
const lines = [wheel, truck,
  { id: 'g', name: 'Groceries', funding_mode: 'flexible', per_check_amount: 623.08 },
  { id: 'x', name: 'Exit Fund', funding_mode: 'flexible', per_check_amount: 161.54, is_remainder_target: true }]
lines[0].id = 'w'; lines[1].id = 't'
const plan = planForCheck(lines, { payday: d('2026-09-18'), net: 3801.71, balances: { w: 0.23, t: -0.33 }, household: hh })
console.log('\nWhole check:')
for (const r of plan) console.log(`  ${r.name.padEnd(16)} ${String(r.amount).padStart(8)}   ${r.reason}`)
const total = plan.reduce((s, r) => s + +r.amount, 0)
check('whole check sums to net', total, 3801.71)

console.log(fails ? `\n*** ${fails} FAILED ***` : '\nALL PASS')
process.exitCode = fails ? 1 : 0
