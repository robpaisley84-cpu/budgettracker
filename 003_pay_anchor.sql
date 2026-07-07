-- Migration 003 — anchor the pay cycle to a known payday
-- Lets the Dashboard count the actual paydays that land in each calendar month
-- (bi-weekly → 2 checks most months, 3 twice a year).
-- Run once in your Supabase SQL Editor (safe to re-run).

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS pay_anchor_date DATE;

-- Seed from Rob's June 26, 2026 paystub (bi-weekly).
UPDATE households
SET pay_anchor_date = '2026-06-26'
WHERE pay_anchor_date IS NULL;
