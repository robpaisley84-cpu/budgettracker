-- Migration 006 — bill timing & annual reminders
-- Adds due-date tracking to budget items. Run once in Supabase SQL Editor; safe to re-run.

ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS due_day INT;          -- day of month (1-31) for monthly bills
ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS bill_frequency TEXT;  -- 'monthly' | 'quarterly' | 'annual'
ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS next_due_date DATE;   -- next occurrence for quarterly/annual items

-- Convenience: pre-tag the obvious fixed monthly bills (set the actual due_day in the app)
UPDATE budget_items SET bill_frequency = 'monthly'
  WHERE bill_frequency IS NULL AND name IN (
    'Truck Loan', '5th Wheel Loan', 'RV Insurance', 'Truck Insurance',
    'Thousand Trails (Adventure)', 'Google Fi (4 lines)', 'Starlink Roam', 'Life Insurance'
  );

-- Pre-tag the annual lump items (set the real next_due_date in the app)
UPDATE budget_items SET bill_frequency = 'annual'
  WHERE bill_frequency IS NULL AND name IN (
    'America the Beautiful Pass', 'Truck Registration (OH)', 'Trailer Registration (OH)'
  );
