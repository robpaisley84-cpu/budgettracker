-- Migration 012 — make account balances derived instead of a stored running total
--
-- PROBLEM
-- accounts.balance was a stored number nudged at write time (expense in
-- Transactions, transfer in Accounts, allocation in Allocations). Nothing ever
-- recomputed it from history, so:
--   * deleting or correcting a transaction left the balance permanently wrong
--   * a failed balance update (silently swallowed) drifted it forever
--   * 'income' transactions never touched it at all — logging income was a no-op
--
-- FIX
-- Store only an opening balance and derive the current balance from the
-- transaction history. Read balances through accounts_with_balance.
--
-- SAFE TO RE-RUN. The backfill only fills NULLs, so running this twice will not
-- double-adjust. The legacy accounts.balance column is deliberately LEFT IN
-- PLACE and simply stops being read, so reverting the app code restores the old
-- behaviour without any data loss.

-- ── 1. Opening balance ────────────────────────────────────────────────────────
-- Nullable on purpose: NULL means "not yet backfilled", which is what makes
-- step 2 idempotent.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS opening_balance DECIMAL(10,2);

COMMENT ON COLUMN accounts.opening_balance IS
  'Balance before any logged transaction. Current balance is derived — see accounts_with_balance.';
COMMENT ON COLUMN accounts.balance IS
  'LEGACY as of migration 012. No longer read or written; kept for rollback. Use accounts_with_balance.balance.';

-- ── 2. Backfill so today''s displayed balances do not move ────────────────────
-- opening_balance = the balance we currently show, minus everything the history
-- would contribute. Any drift the old running total accumulated (including the
-- income that was never applied) is absorbed here as an as-of reconciliation
-- plug, so the numbers on screen are identical the moment this lands.
UPDATE accounts a
SET opening_balance = COALESCE(a.balance, 0)
  - COALESCE((SELECT SUM(t.amount) FROM transactions t
               WHERE t.account_id = a.id AND t.type IN ('income', 'allocation')), 0)
  - COALESCE((SELECT SUM(t.amount) FROM transactions t
               WHERE t.to_account_id = a.id AND t.type = 'transfer'), 0)
  + COALESCE((SELECT SUM(t.amount) FROM transactions t
               WHERE t.account_id = a.id AND t.type IN ('expense', 'transfer')), 0)
WHERE a.opening_balance IS NULL;

-- ── 3. Derived-balance view ───────────────────────────────────────────────────
-- Exposes every accounts column except the legacy stored balance, plus a
-- computed `balance`, so app code keeps reading a.balance unchanged.
--
-- security_invoker = true makes the view run as the querying user, so the
-- existing "account access" RLS policy on accounts still applies. Without it a
-- view would run as its owner and bypass RLS.
DROP VIEW IF EXISTS accounts_with_balance;

CREATE VIEW accounts_with_balance WITH (security_invoker = true) AS
SELECT
  a.id,
  a.household_id,
  a.name,
  a.type,
  a.opening_balance,
  a.target_balance,
  a.color,
  a.icon,
  a.is_active,
  a.sort_order,
  a.created_at,
  COALESCE(a.opening_balance, 0)
    -- money in
    + COALESCE((SELECT SUM(t.amount) FROM transactions t
                 WHERE t.account_id = a.id AND t.type IN ('income', 'allocation')), 0)
    + COALESCE((SELECT SUM(t.amount) FROM transactions t
                 WHERE t.to_account_id = a.id AND t.type = 'transfer'), 0)
    -- money out
    - COALESCE((SELECT SUM(t.amount) FROM transactions t
                 WHERE t.account_id = a.id AND t.type IN ('expense', 'transfer')), 0)
  AS balance
FROM accounts a;

-- Indexes to keep the per-account sums cheap as history grows
CREATE INDEX IF NOT EXISTS transactions_account_type_idx    ON transactions (account_id, type);
CREATE INDEX IF NOT EXISTS transactions_to_account_type_idx ON transactions (to_account_id, type);
