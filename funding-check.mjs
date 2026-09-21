// Sanity checks for src/lib/funding.js - not part of the app.
// Run:  node funding-check.mjs      (same pattern as test-accrual.mjs)
import { nextDue, shareFor, safeToSpend, shareReason, planForCheck, monthlyToPerCheck, shortfall, reserved, lastPaymentFor } from './src/lib/funding.js'
import { paydaysBetween } from './src/lib/projection.js'
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

// --- Behind pace, from the fiscal-year anchor -----------------------------
// RV Insurance: $1081 due Aug 6 2027, anchored 0 on 31 Aug 2026 (inside the cycle).
// Aug 6 2027 is itself a payday, so the bill is TIGHT: it must be met by the check
// before, i.e. funded over (paydays - 1). Paydays from 1 Sept 2026 to 6 Aug 2027 = 25,
// usable 24, even share 1081/24 = 45.04. From 21 Sept, 23 paydays remain, 22 usable.
const rv = { funding_mode: 'scheduled', interval_months: 12, next_due_date: '2027-08-06', bill_amount: 1081, saved_so_far: 0, saved_as_of: '2026-08-31' }
const rvTotal = paydaysBetween(hh, new Date(2026, 8, 1), d('2027-08-06')).length     // 25
const rvNeedNow = 1081 - (1081 / (rvTotal - 1)) * 22                                   // ≈ 90.08
check('annual bill on pace (2 checks in) shows 0', shortfall(rv, { held: 90.08, today: d('2026-09-21'), household: hh }), Math.max(0, rvNeedNow - 90.08))
check('annual bill behind pace',                    shortfall(rv, { held: 40, today: d('2026-09-21'), household: hh }), rvNeedNow - 40)
check('annual bill ahead of pace shows 0',          shortfall(rv, { held: 400, today: d('2026-09-21'), household: hh }), 0)
// Anchor OUTSIDE the cycle falls back to the cycle start. Count the cycle's paydays
// rather than assume 26 - a year of fortnightly pay can hold 27 (here it does).
const rvOld = { ...rv, saved_as_of: '2025-01-01', saved_so_far: 0 }
// Midnight, not noon: the Aug 7 payday IS in the window, and d() builds noon dates
const cyclePaydays = paydaysBetween(hh, new Date(2026, 7, 7), d('2027-08-06')).length
check('anchor before the cycle → even share over the whole cycle (tight: one fewer)',
  shortfall(rvOld, { held: 90.08, today: d('2026-09-21'), household: hh }), (1081 - (1081 / (cyclePaydays - 1)) * 22) - 90.08)
check('monthly bill full is not behind',            shortfall(wheel, { held: 836.23, today: d('2026-09-21'), household: hh }), 0)
// Truck Loan is due Oct 2 - payday. Tight: it can't count on that check, so all of it is needed now.
check('monthly bill due on payday, empty → behind by the whole bill',
  shortfall(truck, { held: 0, today: d('2026-09-21'), household: hh }), 677)
// Due Oct 1, next check Oct 2: nothing lands in time, so behind = everything still needed
const tt = { funding_mode: 'scheduled', interval_months: 1, due_day: 1, bill_amount: 313 }
check('bill due before any payday → behind by the full remainder',
  shortfall(tt, { held: 3.12, today: d('2026-09-21'), household: hh }), 309.88)

// --- Reserved: lean where safe, full where tight ------------------------------
// 5th Wheel ($835.77) due Oct 15; last payday before it is Oct 2 (13 days earlier) → lean.
// Cycle Sept 15→Oct 15 has 2 paydays (Sept 18, Oct 2), even share 417.885; 1 check left supplies that.
const wheelA = { ...wheel, saved_so_far: 836, saved_as_of: '2026-08-31' }
check('lean bill: reserved is only what checks can\'t cover', reserved(wheelA, { held: 836.23, today: d('2026-09-21'), household: hh }), 835.77 / 2)
check('lean bill: the rest is spare',                         safeToSpend(wheelA, 836.23, { today: d('2026-09-21'), household: hh }), 836.23 - 835.77 / 2)
// Truck Loan due Oct 2 = payday → tight → hold it all
const truckA = { ...truck, saved_so_far: 677, saved_as_of: '2026-08-31' }
check('tight bill (same-day check): fully reserved',          reserved(truckA, { held: 676.67, today: d('2026-09-21'), household: hh }), 676.67)
check('tight bill: nothing spare',                            safeToSpend(truckA, 676.67, { today: d('2026-09-21'), household: hh }), 0)
check('tight bill: behind by what\'s missing',                shortfall(truckA, { held: 600, today: d('2026-09-21'), household: hh }), 77)
// Starlink due Sept 24, no payday before → tight
const star = { funding_mode: 'scheduled', interval_months: 1, due_day: 24, bill_amount: 175 }
check('no payday before due → tight, fully reserved',         reserved(star, { held: 175, today: d('2026-09-21'), household: hh }), 175)
// Google Fi due Oct 13, last payday Oct 2 (11 days) → lean; cycle Sept 13→Oct 13 = 2 paydays, share 75
const fi = { funding_mode: 'scheduled', interval_months: 1, due_day: 13, bill_amount: 150 }
check('lean bill holding more than pace: spare above pace',   safeToSpend(fi, 99.63, { today: d('2026-09-21'), household: hh }), 24.63)
check('without a household context a bill is fully reserved', safeToSpend(wheelA, 836.23), 836.23 - 835.77)

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

// --- Paid early: this due date is met, the line saves for the next one -------
// Sam's Club: $500 due the 23rd, Rob pays around the 10th. On Sept 21 with the
// Sept 10 payment logged, the line is saving for Oct 23 - not "behind $500" on Sept 23.
const sams = { id: 's', funding_mode: 'scheduled', interval_months: 1, due_day: 23, bill_amount: 500, saved_so_far: 500, saved_as_of: '2026-08-31' }
const samsPaid = lastPaymentFor(sams, [{ budget_item_id: 's', amount: 500, date: '2026-09-10' }])
console.log('\nSam\'s Club paid Sept 10 → next due', on(nextDue(sams, d('2026-09-21'), samsPaid)), '(want Oct 23)')
check('paid early: on pace, nothing behind',            shortfall(sams, { held: 0, today: d('2026-09-21'), household: hh, lastPaid: samsPaid }), 0)
check('not paid: behind by the whole bill (no check before the 23rd)', shortfall(sams, { held: 0, today: d('2026-09-21'), household: hh }), 500)
check('a fee on the line is not the payment',           lastPaymentFor(sams, [{ budget_item_id: 's', amount: 40, date: '2026-09-10' }]) ? 1 : 0, 0)
check('Oct 2 check funds half of Oct 23',               shareFor(sams, { payday: d('2026-10-02'), held: 0, household: hh, lastPaid: samsPaid }), 250)
// Truck Loan paid Sept 3 for the Sept 2 due date is a LATE payment - October is still owed
const truckPaid = lastPaymentFor({ ...truck, id: 't' }, [{ budget_item_id: 't', amount: 677.33, date: '2026-09-03' }])
console.log('Truck paid Sept 3 (a day late) → next due', on(nextDue(truck, d('2026-09-21'), truckPaid)), '(want Oct 2)')
check('late payment does not roll the due date',        shortfall(truckA, { held: 600, today: d('2026-09-21'), household: hh, lastPaid: truckPaid }), 77)
// 5th Wheel paid Sept 8 for Sept 15: by Sept 21 that cycle is over, Oct 15 is next either way
const wheelPaid = lastPaymentFor({ ...wheel, id: 'w' }, [{ budget_item_id: 'w', amount: 835.77, date: '2026-09-08' }])
check('payment from a finished cycle changes nothing',   reserved(wheelA, { held: 836.23, today: d('2026-09-21'), household: hh, lastPaid: wheelPaid }), 835.77 / 2)

console.log(fails ? `\n*** ${fails} FAILED ***` : '\nALL PASS')
process.exitCode = fails ? 1 : 0
