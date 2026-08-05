-- Migration 008 — flexible recurring intervals & auto-accrual
-- Lets a bill recur on any span (every N months) and derives its monthly
-- accrual from the real charge + when it was last paid.
-- Run once in Supabase SQL Editor; safe to re-run (all statements guarded).
--
-- Model:
--   Paying the bill zeroes the fund. From last_paid_date forward we accrue
--   monthly so the fund reaches bill_amount by next_due_date.
--
--     accrued  = months since last_paid × (bill_amount / interval_months)
--     accrual  = (bill_amount − accrued) / months until next_due_date
--
--   budgeted_amount is WRITTEN BACK by the app with that accrual, so the
--   Budget totals, category rollups and Dashboard envelope keep working
--   off the same column they always have.

-- ── New columns ──────────────────────────────────────────────────────────────
ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS bill_amount     DECIMAL(10,2); -- the real charge (985.00)
ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS interval_months INT;           -- 1 | 3 | 6 | 12 | any N
ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS last_paid_date  DATE;          -- primary input; zeroes the fund
ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS auto_accrue     BOOLEAN DEFAULT FALSE;

-- due_day, bill_frequency and next_due_date already exist from migration 006.
-- bill_frequency is intentionally KEPT so nothing that still reads it breaks;
-- interval_months is now the source of truth.

-- ── Backfill interval_months from the old three-value enum ───────────────────
UPDATE budget_items SET interval_months = 1
  WHERE interval_months IS NULL AND bill_frequency = 'monthly';
UPDATE budget_items SET interval_months = 3
  WHERE interval_months IS NULL AND bill_frequency = 'quarterly';
UPDATE budget_items SET interval_months = 12
  WHERE interval_months IS NULL AND bill_frequency = 'annual';

-- ── Fix the 006 mis-tag ──────────────────────────────────────────────────────
-- Migration 006 tagged RV/Truck Insurance as 'monthly', but migration 004 set
-- their budgeted_amount to a monthly AMORTIZATION of an annual premium
-- (RV $985/yr → $82, Truck $878/yr → $73). They are annual bills, so the Bills
-- page was asking for a "due day of month" that doesn't exist.
-- Premiums below come from the quotes recorded in 004; correct them in the app
-- if they've changed, and set last_paid_date there to start the accrual.
UPDATE budget_items
   SET bill_frequency = 'annual', interval_months = 12, due_day = NULL,
       auto_accrue = TRUE, bill_amount = COALESCE(bill_amount, 985)
 WHERE name = 'RV Insurance';

UPDATE budget_items
   SET bill_frequency = 'annual', interval_months = 12, due_day = NULL,
       auto_accrue = TRUE, bill_amount = COALESCE(bill_amount, 878)
 WHERE name = 'Truck Insurance';

-- ── Turn on auto-accrual for the other genuinely periodic items ──────────────
-- Seeds bill_amount from the existing monthly figure × the interval, which is
-- how those numbers were derived in the first place. Adjust in the app.
UPDATE budget_items
   SET auto_accrue = TRUE,
       bill_amount = COALESCE(bill_amount, ROUND(budgeted_amount * interval_months, 2))
 WHERE interval_months > 1
   AND auto_accrue IS NOT TRUE
   AND is_active = TRUE;

-- True monthly bills (loans, Starlink, Google Fi, Life Insurance) are left
-- alone on purpose — a 1-month interval accrues to itself and gains nothing.

-- ── Derive next_due_date where it's missing but we know the last payment ─────
UPDATE budget_items
   SET next_due_date = last_paid_date + (interval_months || ' months')::INTERVAL
 WHERE next_due_date IS NULL
   AND last_paid_date IS NOT NULL
   AND interval_months IS NOT NULL;

-- ── Sanity guards ────────────────────────────────────────────────────────────
ALTER TABLE budget_items DROP CONSTRAINT IF EXISTS budget_items_interval_positive;
ALTER TABLE budget_items ADD  CONSTRAINT budget_items_interval_positive
  CHECK (interval_months IS NULL OR interval_months >= 1);
