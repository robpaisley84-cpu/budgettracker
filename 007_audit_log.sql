-- Migration 007 — audit log of all inputs & changes
-- Captures every INSERT/UPDATE/DELETE on the financial tables via triggers,
-- including who made the change (auth.uid) and the before/after row data.
-- Run once in Supabase SQL Editor; safe to re-run.

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  household_id UUID,
  table_name   TEXT NOT NULL,
  operation    TEXT NOT NULL,               -- INSERT | UPDATE | DELETE
  row_id       UUID,
  changed_by   UUID,                          -- auth.uid() (null for dashboard/service-role edits)
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_data     JSONB,
  new_data     JSONB
);

CREATE INDEX IF NOT EXISTS audit_log_household_idx ON audit_log (household_id, changed_at DESC);

-- Members can read their own household's log (writes happen via the trigger, which bypasses RLS)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit read" ON audit_log;
CREATE POLICY "audit read" ON audit_log FOR SELECT USING (household_id = get_user_household_id());

-- Generic trigger function — JSON-based so it works on every table regardless of columns
CREATE OR REPLACE FUNCTION audit_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  new_j JSONB := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END;
  old_j JSONB := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END;
BEGIN
  INSERT INTO audit_log (household_id, table_name, operation, row_id, changed_by, old_data, new_data)
  VALUES (
    COALESCE((new_j->>'household_id')::uuid, (old_j->>'household_id')::uuid,
             (new_j->>'id')::uuid,          (old_j->>'id')::uuid),   -- households uses id
    TG_TABLE_NAME,
    TG_OP,
    COALESCE((new_j->>'id')::uuid, (old_j->>'id')::uuid),
    auth.uid(),
    old_j,
    new_j
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Attach the trigger to every financial table
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['transactions','accounts','budget_items','budget_categories','allocation_rules','paychecks','households'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_%1$s ON %1$s;', t);
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$s FOR EACH ROW EXECUTE FUNCTION audit_trigger();', t);
  END LOOP;
END $$;
