-- Migration 014 - budget lines backed by accounts; a paycheck lands in checking
--
-- MODEL
-- Accounts are physical: what the bank says. Budget lines are envelopes, and
-- every line is backed by exactly one account.
--
--   * Most lines (groceries, fuel, maintenance, dump fees) are backed by
--     CHECKING. Putting money in them is virtual - it earmarks checking money;
--     nothing moves at the bank.
--   * Fund lines (Lincoln's Savings, Disney, Emergency, Exit) are backed by
--     THEIR OWN savings account. Putting money in them moves it for real,
--     checking -> that account, and the envelope IS the account: one number,
--     so the two can never drift apart.
--
-- Each paycheck lands in checking as income and is then distributed across the
-- lines. Whatever is left after the plan goes to ONE designated line - the
-- Exit Fund - so every dollar has a job.
--
-- This retires allocation_rules. "Each check, $X goes to account Y" is now said
-- once, as a budget line's plan plus its backing account, instead of twice in
-- two places that could disagree.
--
-- SAFE TO RE-RUN - every statement is guarded.

ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS is_remainder_target BOOLEAN NOT NULL DEFAULT FALSE;

-- The transfers a paycheck generates carry its id, so redistributing that
-- paycheck can find and replace exactly them and nothing else.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paycheck_id UUID REFERENCES paychecks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS budget_items_account_idx   ON budget_items (account_id);
CREATE INDEX IF NOT EXISTS transactions_paycheck_idx  ON transactions (paycheck_id);

COMMENT ON COLUMN budget_items.account_id IS
  'The account this envelope lives in. Checking = virtual earmark. Any other account = the line IS that account, and funding it moves money there.';
COMMENT ON COLUMN budget_items.is_remainder_target IS
  'The one line per household that receives whatever is left of a paycheck after the plan.';

-- 1. Every line defaults to the household's checking account (a virtual envelope)
UPDATE budget_items b
   SET account_id = (SELECT a.id FROM accounts a
                      WHERE a.household_id = b.household_id
                        AND a.type = 'checking' AND a.is_active
                      ORDER BY a.sort_order, a.created_at
                      LIMIT 1)
 WHERE b.account_id IS NULL;

-- 2. A line named the same as a non-checking account is backed by that account
--    ("Disney Fund" line -> "Disney Fund" account)
UPDATE budget_items b
   SET account_id = a.id
  FROM accounts a
 WHERE a.household_id = b.household_id
   AND a.is_active AND a.type <> 'checking'
   AND lower(trim(a.name)) = lower(trim(b.name));

-- 3. An allocation rule whose name matches a line: that line is backed by the
--    rule's account. This is how the old rules carry over.
UPDATE budget_items b
   SET account_id = r.account_id
  FROM allocation_rules r
 WHERE r.household_id = b.household_id
   AND r.is_active
   AND lower(trim(r.name)) = lower(trim(b.name));

-- 4. Leftover target: the Exit Fund. Exactly one per household; change it on
--    the Budget page if the guess is wrong.
CREATE UNIQUE INDEX IF NOT EXISTS budget_items_one_remainder_target
  ON budget_items (household_id) WHERE is_remainder_target;

UPDATE budget_items b
   SET is_remainder_target = TRUE
 WHERE b.id = (SELECT x.id FROM budget_items x
                WHERE x.household_id = b.household_id
                  AND x.is_active AND lower(x.name) LIKE '%exit%'
                ORDER BY x.name LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM budget_items y
                    WHERE y.household_id = b.household_id AND y.is_remainder_target);

-- 5. Retire allocation rules. Rows are kept for history; the app stops reading them.
UPDATE allocation_rules SET is_active = FALSE WHERE is_active;
COMMENT ON TABLE allocation_rules IS
  'RETIRED by migration 014. Replaced by budget_items.account_id + budgeted_amount. Kept for history only.';

-- REPORT - shows in the results grid so you can check what got linked.
-- Fund lines should show their own account; everything else should show checking.
SELECT b.name                                   AS budget_line,
       COALESCE(a.name, '(none - fix on Budget)') AS backed_by,
       a.type                                   AS account_type,
       b.is_remainder_target                    AS receives_leftover
  FROM budget_items b
  LEFT JOIN accounts a ON a.id = b.account_id
 WHERE b.is_active
 ORDER BY (a.type = 'checking'), a.name, b.name;
