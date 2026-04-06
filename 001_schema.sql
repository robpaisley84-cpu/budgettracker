-- Road Budget Schema
-- Run this in your Supabase SQL Editor

-- Households (shared family unit)
CREATE TABLE households (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'The Family Budget',
  monthly_income DECIMAL(10,2) DEFAULT 8424,
  paycheck_amount DECIMAL(10,2) DEFAULT 4212,
  paycheck_day_1 INT DEFAULT 1,
  paycheck_day_2 INT DEFAULT 15,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Household members (Rob + Hayley)
CREATE TABLE household_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID REFERENCES households(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  role TEXT DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(household_id, user_id)
);

-- Budget categories
CREATE TABLE budget_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '📋',
  color TEXT DEFAULT '#4a9a5a',
  sort_order INT DEFAULT 0
);

-- Budget line items
CREATE TABLE budget_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID REFERENCES households(id) ON DELETE CASCADE,
  category_id UUID REFERENCES budget_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  budgeted_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_fixed BOOLEAN DEFAULT FALSE,
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE
);

-- Accounts (checking, savings, funds)
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'checking',
  balance DECIMAL(10,2) DEFAULT 0,
  target_balance DECIMAL(10,2),
  color TEXT DEFAULT '#4a9a5a',
  icon TEXT DEFAULT '🏦',
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transactions (expenses, transfers, income)
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID REFERENCES households(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  to_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  budget_item_id UUID REFERENCES budget_items(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('expense','income','transfer','allocation')),
  amount DECIMAL(10,2) NOT NULL,
  description TEXT,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  budget_month TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Allocation rules (how to split each paycheck)
CREATE TABLE allocation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID REFERENCES households(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  is_percentage BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INT DEFAULT 0
);

-- Paycheck log
CREATE TABLE paychecks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID REFERENCES households(id) ON DELETE CASCADE,
  net_amount DECIMAL(10,2) NOT NULL,
  date DATE NOT NULL,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE paychecks ENABLE ROW LEVEL SECURITY;

-- Helper: get current user's household
CREATE OR REPLACE FUNCTION get_user_household_id()
RETURNS UUID LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT household_id FROM household_members WHERE user_id = auth.uid() LIMIT 1;
$$;

-- Policies
CREATE POLICY "household access" ON households FOR ALL
  USING (id = get_user_household_id());

CREATE POLICY "member access" ON household_members FOR ALL
  USING (household_id = get_user_household_id());

CREATE POLICY "category access" ON budget_categories FOR ALL
  USING (household_id = get_user_household_id());

CREATE POLICY "item access" ON budget_items FOR ALL
  USING (household_id = get_user_household_id());

CREATE POLICY "account access" ON accounts FOR ALL
  USING (household_id = get_user_household_id());

CREATE POLICY "transaction access" ON transactions FOR ALL
  USING (household_id = get_user_household_id());

CREATE POLICY "allocation rule access" ON allocation_rules FOR ALL
  USING (household_id = get_user_household_id());

CREATE POLICY "paycheck access" ON paychecks FOR ALL
  USING (household_id = get_user_household_id());

-- ── SEED DATA FUNCTION ───────────────────────────────────────────────────────
-- Call after creating your household: SELECT seed_budget(your_household_id);

CREATE OR REPLACE FUNCTION seed_budget(hh_id UUID)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  cat_id UUID;
BEGIN
  -- Loan Payments
  INSERT INTO budget_categories (household_id,name,icon,color,sort_order) VALUES (hh_id,'Loan Payments','💳','#c8954a',1) RETURNING id INTO cat_id;
  INSERT INTO budget_items (household_id,category_id,name,budgeted_amount,is_fixed) VALUES
    (hh_id,cat_id,'5th Wheel Loan',901,true),
    (hh_id,cat_id,'Ram 3500 Mega Cab Loan',757,true);

  -- Campsite & Domicile
  INSERT INTO budget_categories (household_id,name,icon,color,sort_order) VALUES (hh_id,'Campsite & Domicile','🏕️','#5a9a6a',2) RETURNING id INTO cat_id;
  INSERT INTO budget_items (household_id,category_id,name,budgeted_amount) VALUES
    (hh_id,cat_id,'Campsite Fees (non-TT)',300),
    (hh_id,cat_id,'1000 Trails Membership',150),
    (hh_id,cat_id,'SD Mail Forwarding',15),
    (hh_id,cat_id,'SD Vehicle Reg — Truck',9),
    (hh_id,cat_id,'SD Vehicle Reg — 5th Wheel',8);

  -- Rig Operating
  INSERT INTO budget_categories (household_id,name,icon,color,sort_order) VALUES (hh_id,'Rig Operating','🚛','#c8842a',3) RETURNING id INTO cat_id;
  INSERT INTO budget_items (household_id,category_id,name,budgeted_amount) VALUES
    (hh_id,cat_id,'RV Insurance',150),
    (hh_id,cat_id,'Truck Insurance',200),
    (hh_id,cat_id,'Fuel — Towing',250),
    (hh_id,cat_id,'Propane',100),
    (hh_id,cat_id,'RV Maintenance',150),
    (hh_id,cat_id,'Truck Maintenance',125),
    (hh_id,cat_id,'Truck Washes',30),
    (hh_id,cat_id,'Dump Station Fees',20);

  -- Connectivity
  INSERT INTO budget_categories (household_id,name,icon,color,sort_order) VALUES (hh_id,'Connectivity','📶','#4a80b0',4) RETURNING id INTO cat_id;
  INSERT INTO budget_items (household_id,category_id,name,budgeted_amount,is_fixed) VALUES
    (hh_id,cat_id,'Google Fi (4 lines)',160,true),
    (hh_id,cat_id,'Starlink Roam',150,true),
    (hh_id,cat_id,'Streaming Services',120,false);

  -- Healthcare
  INSERT INTO budget_categories (household_id,name,icon,color,sort_order) VALUES (hh_id,'Healthcare','🏥','#b05a4a',5) RETURNING id INTO cat_id;
  INSERT INTO budget_items (household_id,category_id,name,budgeted_amount) VALUES
    (hh_id,cat_id,'Out-of-Pocket / Copays',100),
    (hh_id,cat_id,'Dental',50),
    (hh_id,cat_id,'Vision',20);

  -- Food & Daily Life
  INSERT INTO budget_categories (household_id,name,icon,color,sort_order) VALUES (hh_id,'Food & Daily Life','🛒','#8a5ab0',6) RETURNING id INTO cat_id;
  INSERT INTO budget_items (household_id,category_id,name,budgeted_amount) VALUES
    (hh_id,cat_id,'Groceries',900),
    (hh_id,cat_id,'Dining Out',150),
    (hh_id,cat_id,'Household Supplies',60),
    (hh_id,cat_id,'Laundry',40),
    (hh_id,cat_id,'Hayley — Hair',175),
    (hh_id,cat_id,'Hayley — Nails',140),
    (hh_id,cat_id,'Hayley — Makeup',100),
    (hh_id,cat_id,'Personal Care — Family',100),
    (hh_id,cat_id,'Clothing',100);

  -- Kids & Education
  INSERT INTO budget_categories (household_id,name,icon,color,sort_order) VALUES (hh_id,'Kids & Education','👨‍👩‍👧‍👦','#3a9a8a',7) RETURNING id INTO cat_id;
  INSERT INTO budget_items (household_id,category_id,name,budgeted_amount) VALUES
    (hh_id,cat_id,'Miacademy (2 kids)',84),
    (hh_id,cat_id,'School Supplies',25),
    (hh_id,cat_id,'Activities & Enrichment',150),
    (hh_id,cat_id,'Kids Entertainment & Toys',50);

  -- Experiences
  INSERT INTO budget_categories (household_id,name,icon,color,sort_order) VALUES (hh_id,'Experiences','🏔️','#7a5ab0',8) RETURNING id INTO cat_id;
  INSERT INTO budget_items (household_id,category_id,name,budgeted_amount) VALUES
    (hh_id,cat_id,'America the Beautiful Pass',7),
    (hh_id,cat_id,'Attractions & Activities',125),
    (hh_id,cat_id,'Date Nights',75);

  -- Admin & Misc
  INSERT INTO budget_categories (household_id,name,icon,color,sort_order) VALUES (hh_id,'Admin & Misc','📋','#7a8a6a',9) RETURNING id INTO cat_id;
  INSERT INTO budget_items (household_id,category_id,name,budgeted_amount) VALUES
    (hh_id,cat_id,'Package Forwarding',30),
    (hh_id,cat_id,'Tolls',40),
    (hh_id,cat_id,'Banking Fees',15),
    (hh_id,cat_id,'Life Insurance',75),
    (hh_id,cat_id,'Gifts & Holidays',100),
    (hh_id,cat_id,'Emergency Buffer / Misc',100);

  -- Savings Goals
  INSERT INTO budget_categories (household_id,name,icon,color,sort_order) VALUES (hh_id,'Savings Goals','💰','#4a9a7a',10) RETURNING id INTO cat_id;
  INSERT INTO budget_items (household_id,category_id,name,budgeted_amount) VALUES
    (hh_id,cat_id,'Disney World Fund',225),
    (hh_id,cat_id,'RV Emergency Fund',300),
    (hh_id,cat_id,'Exit Fund',350),
    (hh_id,cat_id,'Child 1 Savings',100),
    (hh_id,cat_id,'Child 2 Savings',100);

  -- Default accounts
  INSERT INTO accounts (household_id,name,type,icon,color,sort_order) VALUES
    (hh_id,'Checking','checking','💳','#4a80b0',1),
    (hh_id,'Emergency Fund','fund','🔧','#c8842a',2),
    (hh_id,'Disney Fund','fund','🏰','#8a5ab0',3),
    (hh_id,'Exit Fund','fund','🏠','#3a9a8a',4),
    (hh_id,'Child 1 Savings','fund','👧','#5a9a6a',5),
    (hh_id,'Child 2 Savings','fund','👦','#5a9a6a',6);

END;
$$;
