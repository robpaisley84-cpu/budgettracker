-- Migration 015 - the pay period becomes the planning unit
--
-- PROBLEM
-- Plans were entered per MONTH and income arrives every 14 days. Every conversion
-- between the two was lossy: a monthly plan divided by 2 over-asked by 8% on every
-- check, a "three-paycheck month" looked like relief and wasn't, and a bill due on
-- the 2nd was funded by the check that landed on the 2nd. None of that is a bug in
-- any one line of code - the month is simply the wrong unit for bi-weekly money.
--
-- MODEL
-- Two kinds of budget line, chosen explicitly per line in funding_mode:
--
--   scheduled  a bill with an amount and a due date (loans, insurance, Starlink).
--              The app works out each check's share from the schedule:
--                share = (bill_amount - what the envelope holds) / checks before it's due
--              so a bill due on the 15th is funded half by the check on the 18th and
--              half by the one on the 2nd. Its "safe to spend" is zero - it's reserved.
--
--   flexible   an allowance per check (groceries, fuel, dining). per_check_amount is
--              what Rob enters; the monthly figure is derived for reference. Its
--              "safe to spend" is its envelope balance.
--
-- budgeted_amount (the monthly plan) is KEPT and kept in sync by the app on every
-- write, so year-to-date views and anything else still reading it keep working
-- through the transition. Retire it in a later migration once nothing reads it.
--
-- checking_floor is the balance Rob does not want checking to dip below; the
-- projection flags any day it would.
--
-- SAFE TO RE-RUN - every statement is guarded, and the backfill only touches rows
-- whose funding_mode is still NULL, so a deliberate choice made in the app is
-- never overwritten by running this twice.

ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS funding_mode     TEXT;
ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS per_check_amount DECIMAL(10,2);
ALTER TABLE households   ADD COLUMN IF NOT EXISTS checking_floor   DECIMAL(10,2) DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_items_funding_mode_check') THEN
    ALTER TABLE budget_items ADD CONSTRAINT budget_items_funding_mode_check
      CHECK (funding_mode IS NULL OR funding_mode IN ('scheduled', 'flexible'));
  END IF;
END $$;

-- 1. Anything that already has a date is a scheduled bill.
UPDATE budget_items
   SET funding_mode = 'scheduled'
 WHERE funding_mode IS NULL
   AND (due_day IS NOT NULL OR next_due_date IS NOT NULL);

-- Monthly bills used budgeted_amount as the charge; say so explicitly, and pin the
-- interval so the engine never has to guess.
UPDATE budget_items
   SET bill_amount     = COALESCE(bill_amount, budgeted_amount),
       interval_months = COALESCE(interval_months, 1)
 WHERE funding_mode = 'scheduled' AND due_day IS NOT NULL;

-- 2. Everything else is a flexible allowance. Convert the monthly plan to a
--    per-check figure using the household's real pay frequency - 26 checks a
--    year for bi-weekly, not 24.
UPDATE budget_items b
   SET funding_mode     = 'flexible',
       per_check_amount = ROUND(b.budgeted_amount * 12 / CASE h.pay_frequency
                            WHEN 'weekly'      THEN 52
                            WHEN 'semimonthly' THEN 24
                            WHEN 'monthly'     THEN 12
                            ELSE 26 END, 2)
  FROM households h
 WHERE h.id = b.household_id
   AND b.funding_mode IS NULL;

COMMENT ON COLUMN budget_items.funding_mode IS
  'scheduled = a bill with an amount and due date, funded to arrive in time and reserved (safe to spend 0). flexible = an allowance per check, safe to spend = envelope balance.';
COMMENT ON COLUMN budget_items.per_check_amount IS
  'Flexible lines only: the allowance each paycheck puts in. budgeted_amount is the derived monthly equivalent.';
COMMENT ON COLUMN households.checking_floor IS
  'The balance checking should never drop below. The projection flags any day it would.';

-- REPORT - shows in the results grid so the split can be sanity-checked.
SELECT funding_mode,
       count(*)                          AS lines,
       round(sum(budgeted_amount), 2)    AS monthly_plan,
       round(sum(per_check_amount), 2)   AS per_check_allowances,
       round(sum(bill_amount), 2)        AS bill_amounts
  FROM budget_items
 WHERE is_active
 GROUP BY funding_mode
 ORDER BY funding_mode;
