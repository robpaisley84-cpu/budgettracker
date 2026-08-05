// Quick sanity checks for the accrual engine. Run: node test-accrual.mjs
import { computeAccrual } from './src/lib/accrual.js'

let pass = 0, fail = 0
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps
function check(name, got, want) {
  const ok = near(got, want)
  console.log(`${ok ? '✅' : '❌'} ${name}: got ${got}, want ~${want}`)
  ok ? pass++ : fail++
}

// 1. Clean cycle, no saved balance → base rate ($1200/yr = $100/mo), 3 months in
let c = computeAccrual({ auto_accrue: true, bill_amount: 1200, interval_months: 12,
  last_paid_date: '2026-04-08', next_due_date: '2027-04-08' }, new Date('2026-07-08'))
check('clean cycle accrual', c.accrual, 100)
check('clean cycle accrued (3mo)', c.accrued, 300)

// 2. Catch-up: $0 banked, anchored today, $1200 due in 4 months → $300/mo
c = computeAccrual({ auto_accrue: true, bill_amount: 1200, interval_months: 12,
  saved_so_far: 0, saved_as_of: '2026-07-08', next_due_date: '2026-11-08' }, new Date('2026-07-08'))
check('catch-up accrual', c.accrual, 300)
console.log(`   needsCatchUp = ${c.needsCatchUp} (expect true)`)

// 3. Stability: same anchor, 2 months later → still $300/mo, $600 accrued
c = computeAccrual({ auto_accrue: true, bill_amount: 1200, interval_months: 12,
  saved_so_far: 0, saved_as_of: '2026-07-08', next_due_date: '2026-11-08' }, new Date('2026-09-08'))
check('catch-up stays level', c.accrual, 300)
check('catch-up accrued (2mo)', c.accrued, 600)

// 4. On-track with a real balance: $300 banked, $1200 due in 9 months → $100/mo
c = computeAccrual({ auto_accrue: true, bill_amount: 1200, interval_months: 12,
  saved_so_far: 300, saved_as_of: '2026-07-08', next_due_date: '2027-04-08' }, new Date('2026-07-08'))
check('on-track with balance', c.accrual, 100)

// 5. Cycle roll: due date in the past → resets to a fresh base-rate cycle
c = computeAccrual({ auto_accrue: true, bill_amount: 1200, interval_months: 12,
  last_paid_date: '2025-06-08', next_due_date: '2026-06-08' }, new Date('2026-07-08'))
check('rolled cycle accrual', c.accrual, 100)
console.log(`   rolledCycles = ${c.rolledCycles} (expect 1), resets saved_so_far = ${c.dates?.saved_so_far}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
