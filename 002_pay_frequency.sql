-- Migration 002 — add pay_frequency and set real take-home pay
-- Run this once in your Supabase SQL Editor (safe to re-run).

-- 1. Add the pay_frequency column if it doesn't exist
ALTER TABLE households
  ADD COLUMN IF NOT EXISTS pay_frequency TEXT DEFAULT 'biweekly';

-- 2. Seed the current household(s) with Rob's real net paycheck.
--    Net pay per bi-weekly check: $3,801.71  →  monthly = 3801.71 * 26 / 12 = 8236.37
UPDATE households
SET paycheck_amount = 3801.71,
    pay_frequency   = 'biweekly',
    monthly_income  = ROUND(3801.71 * 26 / 12, 2);
