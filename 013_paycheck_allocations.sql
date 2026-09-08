-- Migration 013 - real dollars in envelopes, allocated per paycheck
--
-- PROBLEM
-- budget_items.budgeted_amount was one flat monthly figure and envelope
-- balances were INFERRED from it: budget x months since the anchor. That
-- assumes every line was funded evenly every month, and it means there are no
-- actual dollars in the model - so nothing can be moved between lines when
-- something runs over.
--
-- MODEL
-- Each paycheck distributes real amounts to budget lines. A line's balance is
-- what was put in, minus what was spent from it:
--
--   balance = opening balance
--           + SUM(allocations after the anchor)
--           - SUM(expenses after the anchor)
--
-- budgeted_amount stays as the PLAN (what you intend to put in, and what the
-- app suggests each payday). Allocations are the ACTUAL.
--
-- Moving money between lines is two rows that cancel out, sharing a
-- transfer_group: negative on the source, positive on the destination. So a
-- line that lends dollars simply goes negative, and transfer_group gives you
-- the ledger of where each dollar went. No separate deficit bookkeeping.
--
-- Opening balances come from budget_items.saved_so_far / saved_as_of, the
-- true-up already in the app. There is deliberately no backfill: envelope
-- numbers now reflect only real dollars, so true up any fund that already
-- holds money and allocate from the next paycheck forward.
--
-- SAFE TO RE-RUN - every statement is guarded.

CREATE TABLE IF NOT EXISTS paycheck_allocations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id   UUID REFERENCES households(id)    ON DELETE CASCADE,
  -- NULL for a transfer between lines or a manual adjustment
  paycheck_id    UUID REFERENCES paychecks(id)     ON DELETE CASCADE,
  budget_item_id UUID REFERENCES budget_items(id)  ON DELETE CASCADE,
  amount         DECIMAL(10,2) NOT NULL,           -- negative on the source of a move
  transfer_group UUID,                             -- both sides of a move share this
  note           TEXT,
  date           DATE NOT NULL DEFAULT CURRENT_DATE,
  budget_month   TEXT,                             -- 'YYYY-MM', for period reporting
  created_by     UUID REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pa_item_idx     ON paycheck_allocations (budget_item_id, date);
CREATE INDEX IF NOT EXISTS pa_household_idx ON paycheck_allocations (household_id, budget_month);
CREATE INDEX IF NOT EXISTS pa_paycheck_idx ON paycheck_allocations (paycheck_id);
CREATE INDEX IF NOT EXISTS pa_transfer_idx ON paycheck_allocations (transfer_group);

ALTER TABLE paycheck_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allocation access" ON paycheck_allocations;
CREATE POLICY "allocation access" ON paycheck_allocations FOR ALL
  USING (household_id = get_user_household_id());

-- Same audit trail as the other financial tables (migration 007)
DROP TRIGGER IF EXISTS audit_paycheck_allocations ON paycheck_allocations;
CREATE TRIGGER audit_paycheck_allocations
  AFTER INSERT OR UPDATE OR DELETE ON paycheck_allocations
  FOR EACH ROW EXECUTE FUNCTION audit_trigger();

COMMENT ON TABLE paycheck_allocations IS
  'Real dollars put into a budget line. Envelope balance = opening + SUM(amount) - spend. A move between lines is two rows sharing transfer_group and summing to zero.';
