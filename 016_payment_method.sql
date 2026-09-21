-- Migration 016 - record what each expense was paid with
--
-- A purchase hits its budget line on the day it happens, whichever card it
-- went on - that does not change. What was missing was any record of WHICH
-- card, so a card statement could not be checked against the ledger. This adds
-- a free-text tag ("Amex", "Chase Visa", "Debit", "Cash"); the Log page offers
-- the values already used so spelling stays consistent.
--
-- Deliberately not a foreign key to a cards table: one household, a handful of
-- cards, and the tag is for matching statements, not for balances. If cards
-- ever need balances of their own they become accounts (type 'credit') and
-- this column is the bridge for backfilling.
--
-- SAFE TO RE-RUN.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT;

CREATE INDEX IF NOT EXISTS transactions_payment_method_idx
  ON transactions (household_id, payment_method) WHERE payment_method IS NOT NULL;

COMMENT ON COLUMN transactions.payment_method IS
  'What the expense was paid with - a card name, Debit, Cash. Free text; the app suggests values already in use.';
