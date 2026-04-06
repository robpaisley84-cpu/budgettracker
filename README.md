# Road Budget — Full-Time RV Family Expense Tracker

A full-stack budgeting app built for your family's full-time RV lifestyle.
Real-time sync between Rob and Hayley, bi-weekly paycheck processing,
account tracking, and actuals vs. budget reporting.

---

## Features

- **Shared household** — Rob and Hayley both see changes in real-time
- **Budget tracking** — all line items pre-loaded, actuals vs. budget by month
- **Account management** — checking, savings, and fund accounts (Disney, Emergency, Exit, Kids)
- **Transfer funds** between accounts with one tap
- **Log transactions** — tag to budget category and account
- **Paycheck processing** — configure bi-weekly allocation rules once, process in seconds
- **History** — all months saved, compare any period

---

## Deploy in ~15 minutes

### Step 1 — Supabase (free)

1. Go to [supabase.com](https://supabase.com) → New Project
2. Name it `rv-budget`, choose a region close to you, set a database password
3. Wait ~2 minutes for it to spin up
4. Go to **SQL Editor** → paste the entire contents of `supabase/migrations/001_schema.sql` → Run
5. Go to **Project Settings → API** → copy:
   - **Project URL** (looks like `https://abcdef.supabase.co`)
   - **anon public** key (long string starting with `eyJ...`)

### Step 2 — GitHub

1. Create a new private repo at github.com
2. Push this project to it:
```bash
git init
git add .
git commit -m "Initial Road Budget"
git remote add origin https://github.com/YOURNAME/rv-budget.git
git push -u origin main
```

### Step 3 — Vercel (free)

1. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
2. Select your `rv-budget` repo
3. Under **Environment Variables**, add:
   - `VITE_SUPABASE_URL` = your Project URL from Step 1
   - `VITE_SUPABASE_ANON_KEY` = your anon key from Step 1
4. Click **Deploy**
5. Vercel gives you a URL like `rv-budget.vercel.app` — bookmark this

---

## First-time setup (in the app)

1. Open your Vercel URL → **Create Account** (Rob goes first)
   - Enter email, password, your name
   - This creates the household AND seeds all your budget data automatically
2. Go to **Settings** → copy the **Household ID**
3. Share the Household ID and the app URL with Hayley
4. Hayley opens the app → **Join Family** → paste the Household ID → create her account

---

## Setting up paycheck allocations

1. Go to the **Paycheck** tab
2. Tap **+ Add Rule** for each fund you want to auto-fill on payday:
   - "RV Emergency Fund" → Emergency Fund account → $150
   - "Disney Fund" → Disney Fund account → $112.50 (half of $225/mo)
   - "Exit Fund" → Exit Fund account → $175
   - "Child 1 Savings" → Child 1 account → $50
   - "Child 2 Savings" → Child 2 account → $50
   *(Split monthly amounts in half since paychecks are bi-weekly)*
3. On payday, tap **▶ Process Paycheck** → confirm the net amount → done
   - All accounts update instantly, both Rob and Hayley see it

---

## Making changes to the budget

Since you control the codebase, you can update anything:

**Change a budget amount:**
Open `supabase/migrations/001_schema.sql` → find the `seed_budget` function → update the amount.
For existing households, update directly in Supabase Table Editor: `budget_items` table.

**Add a new budget category:**
Supabase → Table Editor → `budget_categories` → Insert row
Then add items to `budget_items`.

**Change the app itself:**
Edit any file in `src/pages/` → push to GitHub → Vercel auto-deploys in ~30 seconds.

---

## Local development

```bash
cp .env.example .env
# Fill in your Supabase URL and key in .env

npm install
npm run dev
# Opens at http://localhost:5173
```

---

## Tech stack

- **React + Vite** — frontend
- **Supabase** — Postgres database, auth, real-time subscriptions
- **Vercel** — hosting (auto-deploys from GitHub on every push)
- **date-fns** — date handling

---

## Costs

| Service | Cost |
|---|---|
| Supabase (free tier) | $0/mo |
| Vercel (hobby tier) | $0/mo |
| Domain (optional) | ~$12/yr |
| **Total** | **$0/mo** |

The free tiers are generous — Supabase free handles up to 500MB database and 50,000 monthly active users.
You won't come close to hitting limits with a 2-person household.
