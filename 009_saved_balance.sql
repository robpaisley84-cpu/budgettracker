-- Migration 009 — real "set aside so far" balance for accruing bills
-- Lets the accrual prorate a catch-up against what you've ACTUALLY banked,
-- instead of assuming you saved the base rate every month.
--
--   accrual = (bill_amount − saved_so_far) ÷ months from saved_as_of to next_due
--
-- The rate is locked for the cycle by that anchor, so it stays steady month to
-- month and resets to the base rate when the bill is paid. Leaving saved_so_far
-- NULL preserves the old base-rate behavior (the on-track assumption).
--
-- Run once in Supabase SQL Editor; safe to re-run.

ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS saved_so_far DECIMAL(10,2); -- real fund balance
ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS saved_as_of  DATE;          -- date that balance was accurate

-- No backfill: existing accruing items stay NULL (base-rate accrual) until you
-- enter a "set aside so far" figure in the Bills editor, which stamps saved_as_of.
