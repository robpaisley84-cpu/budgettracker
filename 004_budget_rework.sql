-- Migration 004 — Budget rework for single-income, full-time RV steady state
-- Run once in Supabase SQL Editor. Safe to re-run (guarded inserts).
-- Assumes ONE household. Updates line items by their seeded names —
-- if you've renamed any in the app, tweak the names below to match.

-- 1) Insurance — real full-timer quotes (RV $985/yr, truck $878/yr)
UPDATE budget_items SET budgeted_amount = 82 WHERE name = 'RV Insurance';
UPDATE budget_items SET budgeted_amount = 73 WHERE name = 'Truck Insurance';

-- 2) Split the rig payment into two ~$900 lines (new truck TBD → rename)
UPDATE budget_items SET budgeted_amount = 900 WHERE name = '5th Wheel Loan';
UPDATE budget_items SET budgeted_amount = 900, name = 'Truck Loan' WHERE name = 'Ram 3500 Mega Cab Loan';

-- 3) Dental & Vision now come pre-tax on payroll → drop from the budget
UPDATE budget_items SET is_active = false WHERE name IN ('Dental', 'Vision');

-- 4) New Rig Operating lines — daily fuel + tire/roof/repair sinking funds
INSERT INTO budget_items (household_id, category_id, name, budgeted_amount, is_fixed, sort_order, is_active)
SELECT c.household_id, c.id, v.name, v.amt, false, v.so, true
FROM budget_categories c
JOIN (VALUES
  ('Daily/Errand Fuel',    200, 20),
  ('RV Tire Fund',          40, 21),
  ('Truck Tire Fund',       40, 22),
  ('RV Roof/Sealant Fund',  30, 23),
  ('Major Repair Reserve', 100, 24)
) AS v(name, amt, so) ON c.name = 'Rig Operating'
WHERE NOT EXISTS (
  SELECT 1 FROM budget_items bi WHERE bi.name = v.name AND bi.household_id = c.household_id
);

-- 5) Metered electric under Campsite & Domicile (seasonal AC / monthly sites)
INSERT INTO budget_items (household_id, category_id, name, budgeted_amount, is_fixed, sort_order, is_active)
SELECT c.household_id, c.id, 'Metered Electric', 75, false, 20, true
FROM budget_categories c
WHERE c.name = 'Campsite & Domicile'
  AND NOT EXISTS (SELECT 1 FROM budget_items bi WHERE bi.name = 'Metered Electric' AND bi.household_id = c.household_id);

-- 6) New Pets category + lines (dog, cat, two rats)
INSERT INTO budget_categories (household_id, name, icon, color, sort_order)
SELECT DISTINCT household_id, 'Pets', '🐾', '#b0854a', 11
FROM budget_categories bc0
WHERE bc0.name = 'Rig Operating'
  AND NOT EXISTS (SELECT 1 FROM budget_categories bc WHERE bc.name = 'Pets' AND bc.household_id = bc0.household_id);

INSERT INTO budget_items (household_id, category_id, name, budgeted_amount, is_fixed, sort_order, is_active)
SELECT c.household_id, c.id, v.name, v.amt, false, v.so, true
FROM budget_categories c
JOIN (VALUES
  ('Pet Food & Supplies', 60, 1),
  ('Vet & Meds',          40, 2),
  ('Campground Pet Fees', 25, 3)
) AS v(name, amt, so) ON c.name = 'Pets'
WHERE NOT EXISTS (
  SELECT 1 FROM budget_items bi WHERE bi.name = v.name AND bi.household_id = c.household_id
);

-- 7) Flag discretionary savings goals as bonus-funded (not salary-funded)
UPDATE budget_categories SET name = 'Savings Goals (Bonus-Funded)' WHERE name = 'Savings Goals';
