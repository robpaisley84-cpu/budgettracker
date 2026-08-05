-- Migration 010 — assign every budget line to a tier
-- essential  = salary must cover it
-- lifestyle  = the experiences that make this worth doing (fund from salary if it fits)
-- savings    = goals, ideally funded by bonuses/windfall
-- Each line is reassignable in the app; these are just sensible starting points.
-- Run once in Supabase SQL Editor; safe to re-run.

ALTER TABLE budget_items ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'essential';

UPDATE budget_items SET tier = 'lifestyle'
 WHERE (tier IS NULL OR tier = 'essential') AND is_active = TRUE AND (
   name LIKE 'Hayley %' OR
   name IN ('Dining Out', 'Attractions & Activities', 'Date Nights', 'Streaming Services',
            'Kids Entertainment & Toys', 'Activities & Enrichment', 'Gifts & Holidays',
            'America the Beautiful Pass'));

UPDATE budget_items SET tier = 'savings'
 WHERE (tier IS NULL OR tier = 'essential') AND is_active = TRUE AND
   name IN ('Disney World Fund', 'Exit Fund', 'Child 1 Savings', 'Child 2 Savings');
