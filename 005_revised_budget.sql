-- Migration 005 — Finalized budget after the full line-by-line review
-- Applies camping (premium TT + $600 non-TT), connectivity, moderate groceries,
-- gifts, HSA-covered medical, pooled contingency reserve, and Ohio domicile lines.
-- Run once in Supabase SQL Editor. Assumes one household; safe to re-run.
-- Builds on migration 004. Vehicle payments remain $900 placeholders.

-- ── Campsite & Domicile ──────────────────────────────────────────────
UPDATE budget_items SET budgeted_amount = 313, name = 'Thousand Trails (Adventure)'
  WHERE name = '1000 Trails Membership';
UPDATE budget_items SET budgeted_amount = 600
  WHERE name = 'Campsite Fees (non-TT)';
UPDATE budget_items SET name = 'Mail / Domicile (OH)'
  WHERE name = 'SD Mail Forwarding';
UPDATE budget_items SET budgeted_amount = 8, name = 'Truck Registration (OH)'
  WHERE name LIKE 'SD Vehicle Reg%Truck';
UPDATE budget_items SET budgeted_amount = 6, name = 'Trailer Registration (OH)'
  WHERE name LIKE 'SD Vehicle Reg%5th Wheel';

-- ── Rig Operating: pool the two fuel lines into one ───────────────────
UPDATE budget_items SET budgeted_amount = 400, name = 'Fuel (towing + daily)'
  WHERE name LIKE 'Fuel%Towing';
UPDATE budget_items SET is_active = false WHERE name = 'Daily/Errand Fuel';

-- ── Contingency & Repair Reserve (pools 3 unpredictable lines) ────────
-- Won't all fire at once; backed by the $10k emergency floor.
UPDATE budget_items SET is_active = false WHERE name = 'Major Repair Reserve';
UPDATE budget_items SET is_active = false WHERE name = 'RV Emergency Fund';
UPDATE budget_items SET is_active = false WHERE name = 'Emergency Buffer / Misc';
INSERT INTO budget_items (household_id, category_id, name, budgeted_amount, is_fixed, sort_order, is_active)
SELECT c.household_id, c.id, 'Contingency & Repair Reserve', 350, false, 30, true
FROM budget_categories c
WHERE c.name = 'Rig Operating'
  AND NOT EXISTS (SELECT 1 FROM budget_items bi
                  WHERE bi.name = 'Contingency & Repair Reserve' AND bi.household_id = c.household_id);

-- ── Connectivity ──────────────────────────────────────────────────────
UPDATE budget_items SET budgeted_amount = 115 WHERE name = 'Google Fi (4 lines)';  -- steady-state; add a temp device line if still financing the phone
UPDATE budget_items SET budgeted_amount = 175 WHERE name = 'Starlink Roam';

-- ── Healthcare: routine medical now paid pre-tax from the HSA ─────────
UPDATE budget_items SET is_active = false WHERE name = 'Out-of-Pocket / Copays';

-- ── Food & Daily Life ─────────────────────────────────────────────────
UPDATE budget_items SET budgeted_amount = 1350 WHERE name = 'Groceries';

-- ── Kids & Education ──────────────────────────────────────────────────
UPDATE budget_items SET budgeted_amount = 77 WHERE name = 'Miacademy (2 kids)';

-- ── Admin & Misc ──────────────────────────────────────────────────────
UPDATE budget_items SET is_active = false WHERE name = 'Banking Fees';   -- no-fee bank
UPDATE budget_items SET budgeted_amount = 150 WHERE name = 'Gifts & Holidays';

-- Life Insurance line left unchanged ($75) — verify actual coverage is adequate
-- (target ~$1.4-1.8M term for a single-income family) before relying on it.
