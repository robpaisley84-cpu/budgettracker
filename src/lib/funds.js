// Envelope balance arithmetic, shared by the pages that need it.
//
// It used to live inline in Dashboard's load(), tangled up with that page's
// month scoping. Accounts needs the same sums "as of today" rather than "as of
// the month you're looking at", so the arithmetic lives here and each page
// supplies its own data. Pure functions — no Supabase, no React.
//
// One rule for every line:
//
//   balance = stated balance (if one was recorded) + allocated since - spent since
//
// with one shortcut: a non-checking account that backs exactly ONE line IS that
// line's envelope (migration 014), so its balance is read straight off the
// account and the two can never drift apart. Point a second line at the same
// account and that shortcut stops being true for either of them, so both fall
// back to the arithmetic above and the account reports what is left unassigned.

// Active lines per account id.
export function linesPerAccount(items) {
  const n = {}
  for (const i of items || []) if (i.account_id) n[i.account_id] = (n[i.account_id] || 0) + 1
  return n
}

// Does funding this line move real money? True for any line not backed by
// checking — independent of how many lines share the account.
export function movesMoney(item, checkingId) {
  const accId = item.account_id || item.account?.id || null
  return !!(accId && checkingId && accId !== checkingId)
}

// Is this line the only occupant of its own (non-checking) account? Only then
// can its balance be read straight off the account.
export function isSoleOccupant(item, perAccount) {
  const acc = item.account || null
  if (!acc || acc.type === 'checking') return false
  return (perAccount[acc.id] || 0) === 1
}

// Each fund accrues from its own anchor: an explicit "actual balance as of"
// date if one was recorded, otherwise the month budgeting began.
export function anchorsFor(items, appStartMonth) {
  const itemAnchor = {}
  const savedAsOf  = {}
  for (const it of items || []) {
    itemAnchor[it.id] = it.saved_as_of ? it.saved_as_of.slice(0, 7) : appStartMonth
    if (it.saved_as_of) savedAsOf[it.id] = it.saved_as_of
  }
  return { itemAnchor, savedAsOf }
}

// Spend that postdates each fund's anchor. Where a real balance was stated on a
// date, compare against the date itself — spending earlier that month is
// already reflected in the figure the user gave.
export function spendSinceAnchor(expenseTxns, itemAnchor, savedAsOf) {
  const spent = {}
  expenseTxns?.forEach(t => {
    const id = t.budget_item_id
    if (!id || !itemAnchor[id]) return
    const after = savedAsOf[id] ? t.date > savedAsOf[id] : t.budget_month >= itemAnchor[id]
    if (after) spent[id] = (spent[id] || 0) + +t.amount
  })
  return spent
}

// Real dollars put into each line (013). Both sides of a move between funds are
// rows in here, so a line that lent money is already reduced by it. Same anchor
// rule as spend: a stated balance supersedes anything allocated before it.
export function allocatedSinceAnchor(allocs, savedAsOf) {
  const allocated = {}
  allocs?.forEach(a => {
    const id = a.budget_item_id
    if (!id) return
    if (savedAsOf[id] && a.date <= savedAsOf[id]) return
    allocated[id] = (allocated[id] || 0) + +a.amount
  })
  return allocated
}

const round2 = (n) => Math.round(n * 100) / 100

// The envelope arithmetic on its own, ignoring the sole-occupant shortcut.
export function envelopeBalance(item, allocated = 0, spent = 0) {
  const base = item.saved_as_of ? (+item.saved_so_far || 0) : 0
  return round2(base + allocated - spent)
}

// What a line actually holds.
export function fundBalance(item, { allocated = 0, spent = 0, accountBalance = {}, perAccount = {} }) {
  if (isSoleOccupant(item, perAccount)) return round2(+(accountBalance[item.account.id] ?? 0))
  return envelopeBalance(item, allocated, spent)
}

// What an account holds versus what its envelopes claim. `unassigned` is money
// sitting in the account that no budget line has spoken for — the figure the
// Assign balance sheet drives to zero. A sole-occupant account is always
// exactly assigned by definition, so it reports zero.
export function accountReconciliation(account, items, balances, perAccount) {
  const lines = (items || []).filter(i => (i.account_id || i.account?.id) === account.id)
  const sole  = lines.length === 1 && account.type !== 'checking'
  const assigned = sole
    ? round2(+account.balance || 0)
    : round2(lines.reduce((s, i) => s + (balances[i.id] || 0), 0))
  return {
    lines,
    real: round2(+account.balance || 0),
    assigned,
    unassigned: round2((+account.balance || 0) - assigned),
    sole,
  }
}
