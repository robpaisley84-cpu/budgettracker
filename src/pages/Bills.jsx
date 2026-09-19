import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { computeAccrual, pendingSyncs, intervalLabel, dueFromLastPaid } from '../lib/accrual'
import { isScheduled, perCheckToMonthly, monthlyToPerCheck } from '../lib/funding'
import { format, parseISO, startOfMonth, endOfMonth, addDays, getDate, getDaysInMonth } from 'date-fns'

const fmt  = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()
const fmt2 = (n) => '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const ord  = (d) => { const s = ['th','st','nd','rd'], v = d % 100; return d + (s[(v-20)%10] || s[v] || s[0]) }
const todayISO = () => format(new Date(), 'yyyy-MM-dd')

// Actual payday day-numbers that fall in the given month
function paydayDays(freq, anchorISO, monthDate, day1 = 1, day2 = 15) {
  const start = startOfMonth(monthDate), end = endOfMonth(monthDate)
  if (freq === 'monthly') return [day1]
  if (freq === 'semimonthly') return [day1, day2].filter(d => d <= getDaysInMonth(monthDate))
  const step = freq === 'weekly' ? 7 : 14
  if (!anchorISO) return []
  let d = parseISO(anchorISO)
  while (d > start) d = addDays(d, -step)
  while (d < start) d = addDays(d, step)
  const out = []
  while (d <= end) { out.push(getDate(d)); d = addDays(d, step) }
  return out
}

const PRESETS = [
  { n: 1,  l: 'Monthly'    },
  { n: 3,  l: 'Quarterly'  },
  { n: 6,  l: 'Semiannual' },
  { n: 12, l: 'Annual'     },
]

const label   = { display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }
const input   = { width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'var(--font-mono)', outline: 'none' }
const section = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: '1.5rem' }
const h2      = { fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.5rem' }
const empty   = { fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center', padding: '1.25rem' }

export default function Bills() {
  const { household } = useAuth()
  const [items, setItems]     = useState([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit]       = useState(null)
  const [form, setForm]       = useState({})
  const [saving, setSaving]   = useState(false)

  const today = new Date()

  useEffect(() => { if (household) load() }, [household])

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('budget_items')
      .select('id, name, budgeted_amount, funding_mode, per_check_amount, due_day, bill_frequency, next_due_date, bill_amount, interval_months, last_paid_date, auto_accrue, saved_so_far, saved_as_of, category:budget_categories(icon, color)')
      .eq('household_id', household.id)
      .eq('is_active', true)

    let rows = data || []

    // Roll any elapsed cycles forward and push the recomputed accrual back into
    // budgeted_amount, so the Budget and Dashboard read the current number.
    const syncs = pendingSyncs(rows)
    if (syncs.length) {
      await Promise.all(syncs.map(s => supabase.from('budget_items').update(s.patch).eq('id', s.id)))
      const byId = Object.fromEntries(syncs.map(s => [s.id, s.patch]))
      rows = rows.map(r => byId[r.id] ? { ...r, ...byId[r.id] } : r)
    }

    setItems(rows)
    setLoading(false)
  }

  function openEdit(item) {
    setEdit(item)
    const interval = item.interval_months ?? (item.bill_frequency === 'quarterly' ? 3 : item.bill_frequency === 'annual' ? 12 : item.bill_frequency === 'monthly' ? 1 : '')
    const c = computeAccrual(item, today)  // pre-fill "set aside" with the current projected balance
    const freq = household?.pay_frequency
    setForm({
      // Which kind of line this is (015). Unset counts as flexible.
      mode:     isScheduled(item) ? 'scheduled' : 'flexible',
      // Flexible: the allowance, in both units - editing either derives the other
      perCheck: item.per_check_amount ?? (item.budgeted_amount ? String(monthlyToPerCheck(item.budgeted_amount, freq)) : ''),
      perMonth: item.per_check_amount != null ? String(perCheckToMonthly(item.per_check_amount, freq)) : (item.budgeted_amount ?? ''),
      // Scheduled: the schedule. A monthly bill's charge used to hide in
      // budgeted_amount; now it's bill_amount like every other bill.
      interval: interval === '' ? 1 : interval,
      custom:   interval !== '' && !PRESETS.some(p => p.n === +interval),
      amount:   item.bill_amount ?? (+interval === 1 ? item.budgeted_amount : '') ?? '',
      dueDay:   item.due_day || '',
      lastPaid: item.last_paid_date || '',
      nextDue:  item.next_due_date || '',
      saved:    item.saved_so_far != null ? String(item.saved_so_far) : (c ? String(c.accrued) : ''),
    })
  }

  // Keep the two allowance units in step
  function setPerCheck(v)  { setForm(f => ({ ...f, perCheck: v, perMonth: v === '' ? '' : String(perCheckToMonthly(+v, household?.pay_frequency)) })) }
  function setPerMonth(v)  { setForm(f => ({ ...f, perMonth: v, perCheck: v === '' ? '' : String(monthlyToPerCheck(+v, household?.pay_frequency)) })) }

  // Keep next-due in step with last-paid + interval unless it's been set by hand
  function setInterval(n) {
    setForm(f => ({
      ...f,
      interval: n,
      custom: n !== '' && !PRESETS.some(p => p.n === +n),
      nextDue: f.lastPaid && n > 1 ? dueFromLastPaid(f.lastPaid, n) : f.nextDue,
    }))
  }
  function setLastPaid(v) {
    setForm(f => ({ ...f, lastPaid: v, nextDue: v && f.interval > 1 ? dueFromLastPaid(v, f.interval) : f.nextDue }))
  }

  async function save(markPaidToday = false) {
    if (!edit) return
    setSaving(true)

    // A flexible allowance has no schedule. Switching a bill to flexible clears
    // its dates on purpose - the toggle is the deliberate act, and a stale due
    // day left behind would make it show up as a bill anyway.
    if (form.mode === 'flexible') {
      const perCheck = +form.perCheck || 0
      await supabase.from('budget_items').update({
        funding_mode:     'flexible',
        per_check_amount: perCheck,
        budgeted_amount:  perCheckToMonthly(perCheck, household?.pay_frequency),  // kept in sync (015)
        interval_months:  null, bill_frequency: null, due_day: null,
        bill_amount:      null, last_paid_date: null, next_due_date: null,
        auto_accrue:      false,
      }).eq('id', edit.id)
      setSaving(false); setEdit(null); setForm({}); load()
      return
    }

    const n = +form.interval || 1
    const periodic = n > 1
    const lastPaid = markPaidToday ? todayISO() : (form.lastPaid || null)
    const nextDue  = periodic
      ? (markPaidToday ? dueFromLastPaid(lastPaid, n) : (form.nextDue || (lastPaid ? dueFromLastPaid(lastPaid, n) : null)))
      : null

    const savedSoFar = periodic && form.saved !== '' && form.saved != null ? +form.saved : null
    const amount = +form.amount || null

    const patch = {
      funding_mode:     'scheduled',
      per_check_amount: null,                     // the engine derives it from the schedule
      interval_months:  n,
      bill_frequency:   n === 1 ? 'monthly' : n === 3 ? 'quarterly' : n === 12 ? 'annual' : 'periodic',
      due_day:          n === 1 ? (+form.dueDay || null) : null,
      bill_amount:      amount,                   // the real charge, monthly bills included
      last_paid_date:   periodic ? lastPaid : null,
      next_due_date:    nextDue,
      auto_accrue:      !!(periodic && amount > 0),
      // Paying resets the fund to 0 as of today; otherwise anchor the entered
      // balance to today so the catch-up prorates from now.
      saved_so_far:     markPaidToday ? 0 : savedSoFar,
      saved_as_of:      markPaidToday ? lastPaid : (savedSoFar != null ? todayISO() : null),
    }

    // budgeted_amount stays the monthly equivalent (015): the charge itself for a
    // monthly bill, the computed accrual for a longer cycle.
    const calc = computeAccrual({ ...edit, ...patch })
    patch.budgeted_amount = calc ? calc.accrual : (amount || 0)

    await supabase.from('budget_items').update(patch).eq('id', edit.id)
    setSaving(false); setEdit(null); setForm({}); load()
  }

  const paydays = paydayDays(household?.pay_frequency || 'biweekly', household?.pay_anchor_date, today, household?.paycheck_day_1, household?.paycheck_day_2)

  const scheduled = items.filter(isScheduled)
  const monthly   = scheduled.filter(i => (+i.interval_months || 1) === 1 && i.due_day)

  const periodic = scheduled
    .map(i => ({ item: i, calc: computeAccrual(i, today) }))
    .filter(x => x.calc)
    .sort((a, b) => a.calc.daysUntil - b.calc.daysUntil)

  // Scheduled, but the engine can't act on it yet: no due day, or no amount.
  const needsSetup = scheduled.filter(i => {
    const n = +i.interval_months || 1
    if (!(+i.bill_amount > 0)) return true
    if (n === 1) return !i.due_day
    return !computeAccrual(i, today)
  })

  // Flexible allowances - a deliberate choice, but worth a glance: anything here
  // that is really a bill with a date should be switched over.
  const flexible = items.filter(i => !isScheduled(i)).sort((a, b) => (+b.per_check_amount || 0) - (+a.per_check_amount || 0))
  const flexibleTotal = flexible.reduce((s, i) => s + (+i.per_check_amount || 0), 0)

  // Merge monthly bills + paydays into one day-ordered timeline
  const timeline = [
    ...paydays.map(d => ({ day: d, pay: true })),
    ...monthly.map(b => ({ day: b.due_day, bill: b })),
  ].sort((a, b) => a.day - b.day || (a.pay ? -1 : 1))

  const monthlyTotal  = monthly.reduce((s, b) => s + +b.budgeted_amount, 0)
  const accrualTotal  = periodic.reduce((s, p) => s + p.calc.accrual, 0)

  // Live preview inside the editor
  const previewCalc = edit && +form.interval > 1 && +form.amount > 0
    ? computeAccrual({
        auto_accrue: true, bill_amount: +form.amount, interval_months: +form.interval,
        last_paid_date: form.lastPaid || null,
        next_due_date: form.nextDue || (form.lastPaid ? dueFromLastPaid(form.lastPaid, form.interval) : null),
        saved_so_far: form.saved !== '' && form.saved != null ? +form.saved : null,
        saved_as_of:  form.saved !== '' && form.saved != null ? todayISO() : null,
      }, today)
    : null

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)', marginBottom: '0.25rem' }}>Bills &amp; Reminders</div>
      <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '1.1rem' }}>Tap any item to set its timing. Paydays 💵 are shown so you can space bills after them.</div>

      {/* This month timeline */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h2 style={{ ...h2, margin: 0 }}>{format(today, 'MMMM')} — monthly bills</h2>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--accentL)' }}>{fmt(monthlyTotal)}/mo</span>
      </div>
      <div style={section}>
        {timeline.length === 0 && <div style={empty}>No monthly due dates set yet — tap a bill below to add one.</div>}
        {timeline.map((row, idx) => row.pay ? (
          <div key={'p'+idx} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.9rem', background: 'rgba(74,154,90,0.08)', borderBottom: idx < timeline.length-1 ? '1px solid var(--hairline)' : 'none' }}>
            <span style={{ width: '2.1rem', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--green)' }}>{ord(row.day)}</span>
            <span style={{ fontSize: '0.9rem' }}>💵</span>
            <span style={{ flex: 1, fontSize: '0.82rem', color: 'var(--green)', fontWeight: 600 }}>Payday</span>
          </div>
        ) : (
          <div key={row.bill.id} onClick={() => openEdit(row.bill)} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.55rem 0.9rem', cursor: 'pointer', borderBottom: idx < timeline.length-1 ? '1px solid var(--hairline)' : 'none' }}>
            <span style={{ width: '2.1rem', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '5px', padding: '0.1rem 0' }}>{row.day}</span>
            <span style={{ fontSize: '0.9rem' }}>{row.bill.category?.icon || '📄'}</span>
            <span style={{ flex: 1, fontSize: '0.85rem', color: 'var(--text)' }}>{row.bill.name}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--accentL)' }}>{fmt(row.bill.budgeted_amount)}</span>
          </div>
        ))}
      </div>

      {/* Accruing bills */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h2 style={{ ...h2, margin: 0 }}>Accruing — set aside monthly</h2>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--accentL)' }}>{fmt(accrualTotal)}/mo</span>
      </div>
      <div style={section}>
        {periodic.length === 0 && <div style={empty}>Nothing accruing yet — tap a bill below and set its amount, how often, and when you last paid it.</div>}
        {periodic.map(({ item, calc }, idx) => {
          const pct  = Math.min(100, (calc.accrued / calc.target) * 100)
          const c    = calc.daysUntil < 0 ? 'var(--red)' : calc.daysUntil <= 30 ? 'var(--amber)' : 'var(--muted)'
          return (
            <div key={item.id} onClick={() => openEdit(item)} style={{ padding: '0.6rem 0.9rem', cursor: 'pointer', borderBottom: idx < periodic.length-1 ? '1px solid var(--hairline)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <span style={{ fontSize: '0.9rem' }}>{item.category?.icon || '📄'}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text)' }}>
                    {item.name}{' '}
                    <span style={{ fontSize: '0.62rem', color: 'var(--muted)', textTransform: 'uppercase' }}>· {intervalLabel(item.interval_months)}</span>
                  </div>
                  <div style={{ fontSize: '0.68rem', color: c }}>
                    {fmt(calc.target)} due {format(calc.nextDue, 'MMM d, yyyy')} · {calc.daysUntil === 0 ? 'today' : `in ${calc.daysUntil} days`}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--accentL)' }}>
                    {fmt2(calc.accrual)}<span style={{ fontSize: '0.6rem', color: 'var(--muted)' }}>/mo</span>
                  </div>
                  {calc.needsCatchUp && <div style={{ fontSize: '0.58rem', color: 'var(--amber)' }}>catching up</div>}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.35rem' }}>
                <div style={{ flex: 1, height: '3px', background: 'var(--border)', borderRadius: '2px' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: item.category?.color || 'var(--accent)', borderRadius: '2px' }} />
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--muted)' }}>{fmt(calc.accrued)} of {fmt(calc.target)}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Scheduled, but missing something the engine needs */}
      {needsSetup.length > 0 && (
        <>
          <h2 style={h2}>Bills that need a date or an amount</h2>
          <div style={section}>
            {needsSetup.map((item, idx) => (
              <div key={item.id} onClick={() => openEdit(item)} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.9rem', cursor: 'pointer', borderBottom: idx < needsSetup.length-1 ? '1px solid var(--hairline)' : 'none' }}>
                <span style={{ fontSize: '0.9rem' }}>{item.category?.icon || '📄'}</span>
                <span style={{ flex: 1, fontSize: '0.84rem', color: 'var(--text)' }}>{item.name}</span>
                <span style={{ fontSize: '0.68rem', color: 'var(--amber)' }}>{!(+item.bill_amount > 0) ? 'no amount' : 'no due date'} →</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Flexible allowances. Each is a deliberate "no due date" - but anything
          in here that is really a bill should be switched to Scheduled. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h2 style={{ ...h2, margin: 0 }}>Flexible allowances — per check</h2>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--accentL)' }}>{fmt(flexibleTotal)}/check</span>
      </div>
      <div style={{ ...section, marginBottom: 0 }}>
        {flexible.length === 0 && <div style={empty}>Every line has a schedule.</div>}
        {flexible.map((item, idx) => (
          <div key={item.id} onClick={() => openEdit(item)} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.9rem', cursor: 'pointer', borderBottom: idx < flexible.length-1 ? '1px solid var(--hairline)' : 'none' }}>
            <span style={{ fontSize: '0.9rem' }}>{item.category?.icon || '📄'}</span>
            <span style={{ flex: 1, fontSize: '0.84rem', color: 'var(--text)' }}>{item.name}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--accentL)' }}>{fmt(item.per_check_amount)}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.62rem', color: 'var(--muted)', minWidth: '4.2rem', textAlign: 'right' }}>{fmt(item.budgeted_amount)}/mo</span>
          </div>
        ))}
      </div>

      {/* Edit sheet */}
      {edit && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50, overflowY: 'auto' }}
          onClick={e => { if (e.target === e.currentTarget) setEdit(null) }}>
          <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.5rem' }}>How this line is funded</div>
            <div style={{ fontSize: '1rem', color: 'var(--text)', marginBottom: '0.85rem' }}>{edit.name}</div>

            {/* The one choice that decides everything else (015) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', marginBottom: '0.5rem' }}>
              {[
                { k: 'flexible',  l: 'Flexible allowance', hint: 'a set amount each check · spend it freely' },
                { k: 'scheduled', l: 'Scheduled bill',     hint: 'an amount and a due date · reserved' },
              ].map(o => {
                const on = form.mode === o.k
                return (
                  <button key={o.k} onClick={() => setForm(f => ({ ...f, mode: o.k }))}
                    style={{ background: on ? 'var(--accent)' : 'transparent', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, color: on ? 'var(--onAccent)' : 'var(--muted)', borderRadius: '7px', padding: '0.5rem 0.55rem', textAlign: 'left' }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: on ? 700 : 400 }}>{o.l}</div>
                    <div style={{ fontSize: '0.56rem', opacity: 0.85, marginTop: '0.1rem', lineHeight: 1.3 }}>{o.hint}</div>
                  </button>
                )
              })}
            </div>
            <div style={{ fontSize: '0.62rem', color: 'var(--muted)', marginBottom: '1rem', lineHeight: 1.45 }}>
              {form.mode === 'flexible'
                ? 'Safe to spend is whatever the envelope holds. Switching a bill to this clears its due date.'
                : 'Each check puts in what’s still needed by the due date, split across the checks before it. Safe to spend is $0 until it’s paid.'}
            </div>

            {form.mode === 'flexible' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
                <div>
                  <label style={label}>Per check</label>
                  <input type="number" step="0.01" value={form.perCheck} onChange={e => setPerCheck(e.target.value)} placeholder="0.00" style={input} autoFocus />
                </div>
                <div>
                  <label style={label}>Per month (derived)</label>
                  <input type="number" step="0.01" value={form.perMonth} onChange={e => setPerMonth(e.target.value)} placeholder="0.00" style={input} />
                </div>
                <div style={{ gridColumn: '1 / -1', fontSize: '0.6rem', color: 'var(--muted)', lineHeight: 1.45 }}>
                  Type in either box — the other follows. Bi-weekly pay is 26 checks a year, so a month is 2.17 checks, not 2.
                </div>
              </div>
            )}

            {form.mode === 'scheduled' && (<>
            <label style={label}>How often</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', marginBottom: '0.5rem' }}>
              {PRESETS.map(p => {
                const on = !form.custom && +form.interval === p.n
                return (
                  <button key={p.n} onClick={() => setInterval(p.n)}
                    style={{ background: on ? 'var(--accent)' : 'transparent', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, color: on ? 'var(--onAccent)' : 'var(--muted)', borderRadius: '7px', padding: '0.5rem', fontSize: '0.78rem', fontWeight: on ? 700 : 400 }}>
                    {p.l}
                  </button>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
              <button onClick={() => setForm(f => ({ ...f, custom: true }))}
                style={{ flex: 1, background: form.custom ? 'var(--accent)' : 'transparent', border: `1px solid ${form.custom ? 'var(--accent)' : 'var(--border)'}`, color: form.custom ? 'var(--onAccent)' : 'var(--muted)', borderRadius: '7px', padding: '0.5rem', fontSize: '0.78rem', fontWeight: form.custom ? 700 : 400 }}>
                Every N months
              </button>
              {form.custom && (
                <input type="number" min="1" value={form.interval} onChange={e => setForm(f => ({ ...f, interval: e.target.value, nextDue: f.lastPaid && +e.target.value > 1 ? dueFromLastPaid(f.lastPaid, e.target.value) : f.nextDue }))}
                  placeholder="18" style={{ ...input, width: '5.5rem', padding: '0.5rem' }} />
              )}
            </div>

            {+form.interval === 1 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
                <div>
                  <label style={label}>Amount each month</label>
                  <input type="number" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="835.77" style={input} />
                </div>
                <div>
                  <label style={label}>Due day (1–31)</label>
                  <input type="number" min="1" max="31" value={form.dueDay} onChange={e => setForm(f => ({ ...f, dueDay: e.target.value }))} placeholder="15" style={input} />
                </div>
              </div>
            )}

            {+form.interval > 1 && (
              <>
                <div style={{ marginBottom: '0.75rem' }}>
                  <label style={label}>Bill amount (the full charge)</label>
                  <input type="number" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="985.00" style={input} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  <div>
                    <label style={label}>Last paid</label>
                    <input type="date" value={form.lastPaid} onChange={e => setLastPaid(e.target.value)} style={input} />
                  </div>
                  <div>
                    <label style={label}>Next due</label>
                    <input type="date" value={form.nextDue} onChange={e => setForm(f => ({ ...f, nextDue: e.target.value }))} style={input} />
                  </div>
                </div>

                <div style={{ marginBottom: '0.75rem' }}>
                  <label style={label}>Set aside so far</label>
                  <input type="number" step="0.01" value={form.saved} onChange={e => setForm(f => ({ ...f, saved: e.target.value }))} placeholder="0.00" style={input} />
                  <div style={{ fontSize: '0.63rem', color: 'var(--muted)', marginTop: '0.25rem' }}>
                    What you've actually banked for this bill. Lower it if you're behind — the catch-up prorates over the months left.
                  </div>
                </div>

                {previewCalc ? (
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.7rem 0.8rem', marginBottom: '1rem' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.05rem', color: 'var(--accentL)' }}>{fmt2(previewCalc.accrual)}<span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}> /month</span></div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                      {fmt(previewCalc.accrued)} set aside of {fmt(previewCalc.target)} · {previewCalc.monthsRemaining} month{previewCalc.monthsRemaining === 1 ? '' : 's'} to go
                    </div>
                    {previewCalc.needsCatchUp && (
                      <div style={{ fontSize: '0.65rem', color: 'var(--amber)', marginTop: '0.3rem' }}>
                        ▲ Catching up — {fmt2(previewCalc.perMonth)}/mo would be the steady rate on a full cycle.
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.68rem', color: 'var(--muted)', marginBottom: '1rem' }}>Enter the amount and when you last paid it to see the monthly accrual.</div>
                )}

                <button onClick={() => save(true)} disabled={saving}
                  style={{ width: '100%', background: 'transparent', border: '1px solid var(--accent)', borderRadius: '8px', padding: '0.6rem', color: 'var(--accent)', fontSize: '0.78rem', marginBottom: '0.5rem' }}>
                  ✓ Mark paid today — reset the fund and start the next cycle
                </button>
              </>
            )}
            </>)}

            <button onClick={() => save(false)} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
