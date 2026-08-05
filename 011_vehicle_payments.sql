-- Migration 011 — real vehicle payments (replaces the $900 placeholders)
-- Truck: $90k, $50k down, $40k financed → $700/mo
-- Camper: $120k out-the-door, $42k down, $78k financed → $800/mo
-- Run once in Supabase SQL Editor; safe to re-run.

UPDATE budget_items SET budgeted_amount = 700 WHERE name = 'Truck Loan';
UPDATE budget_items SET budgeted_amount = 800 WHERE name = '5th Wheel Loan';
