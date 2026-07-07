import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format, parseISO, differenceInCalendarDays, startOfMonth, endOfMonth, addDays, getDate, getDaysInMonth } from 'date-fns'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()
const ord = (d) => { const s = ['th','st','nd','rd'], v = d % 100; return d + (s[(v-20)%10] || s[v] || s[0]) }

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

const FREQ = [
  { k: 'monthly',   l: 'Monthly'   },
  { k: 'quarterly', l: 'Quarterly' },
  { k: 'annual',    l: 'Annual'    },
  { k: '',          l: 'Variable / none' },
]

export default function Bills() {
  const { household } = useAuth()
  const [items, setItems]   = useState([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit]     = useState(null)
  const [form, setForm]     = useState({})
  const [saving, setSaving] = useState(false)

  const today = new Date()

  useEffect(() => { if (household) load() }, [household])

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('budget_items')
      .select('id, name, budgeted_amount, due_day, bill_frequency, next_due_date, category:budget_categories(icon, color)')
      .eq('household_id', household.id)
      .eq('is_active', true)
    setItems(data || [])
    setLoading(false)
  }

  function openEdit(item) {
    setEdit(item)
    setForm({ freq: item.bill_frequency ?? '', dueDay: item.due_day || '', nextDue: item.next_due_date || '' })
  }

  async function save() {
    if (!edit) return
    setSaving(true)
    const patch = {
      bill_frequency: form.freq || null,
      due_day: form.freq === 'monthly' ? (+form.dueDay || null) : null,
      next_due_date: (form.freq === 'annual' || form.freq === 'quarterly') ? (form.nextDue || null) : null,
    }
    await supabase.from('budget_items').update(patch).eq('id', edit.id)
    setSaving(false); setEdit(null); setForm({}); load()
  }

  const paydays = paydayDays(household?.pay_frequency || 'biweekly', household?.pay_anchor_date, today, household?.paycheck_day_1, household?.paycheck_day_2)

  const monthly  = items.filter(i => i.bill_frequency === 'monthly' && i.due_day)
  const periodic = items
    .filter(i => (i.bill_frequency === 'annual' || i.bill_frequency === 'quarterly') && i.next_due_date)
    .map(i => ({ ...i, daysUntil: differenceInCalendarDays(parseISO(i.next_due_date), today) }))
    .sort((a, b) => a.daysUntil - b.daysUntil)
  const unscheduled = items.filter(i =>
    !i.bill_frequency ||
    (i.bill_frequency === 'monthly' && !i.due_day) ||
    ((i.bill_frequency === 'annual' || i.bill_frequency === 'quarterly') && !i.next_due_date)
  )

  // Merge monthly bills + paydays into one day-ordered timeline
  const timeline = [
    ...paydays.map(d => ({ day: d, pay: true })),
    ...monthly.map(b => ({ day: b.due_day, bill: b })),
  ].sort((a, b) => a.day - b.day || (a.pay ? -1 : 1))

  const monthlyTotal = monthly.reduce((s, b) => s + +b.budgeted_amount, 0)

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)', marginBottom: '0.25rem' }}>Bills & Reminders</div>
      <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '1.1rem' }}>Tap any item to set its due date. Paydays 💵 are shown so you can space bills after them.</div>

      {/* This month timeline */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em', margin: 0 }}>{format(today, 'MMMM')} — monthly bills</h2>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--accentL)' }}>{fmt(monthlyTotal)}/mo</span>
      </div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: '1.5rem' }}>
        {timeline.length === 0 && <div style={{ fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center', padding: '1.25rem' }}>No monthly due dates set yet — tap a bill below to add one.</div>}
        {timeline.map((row, idx) => row.pay ? (
          <div key={'p'+idx} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.9rem', background: 'rgba(74,154,90,0.08)', borderBottom: idx < timeline.length-1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
            <span style={{ width: '2.1rem', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--green)' }}>{ord(row.day)}</span>
            <span style={{ fontSize: '0.9rem' }}>💵</span>
            <span style={{ flex: 1, fontSize: '0.82rem', color: 'var(--green)', fontWeight: 600 }}>Payday</span>
          </div>
        ) : (
          <div key={row.bill.id} onClick={() => openEdit(row.bill)} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.55rem 0.9rem', cursor: 'pointer', borderBottom: idx < timeline.length-1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
            <span style={{ width: '2.1rem', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '5px', padding: '0.1rem 0' }}>{row.day}</span>
            <span style={{ fontSize: '0.9rem' }}>{row.bill.category?.icon || '📄'}</span>
            <span style={{ flex: 1, fontSize: '0.85rem', color: 'var(--text)' }}>{row.bill.name}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--accentL)' }}>{fmt(row.bill.budgeted_amount)}</span>
          </div>
        ))}
      </div>

      {/* Annual & periodic — due soon */}
      <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.5rem' }}>Annual &amp; periodic — due soon</h2>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: '1.5rem' }}>
        {periodic.length === 0 && <div style={{ fontSize: '0.8rem', color: 'var(--muted)', textAlign: 'center', padding: '1.25rem' }}>No annual/quarterly due dates set yet.</div>}
        {periodic.map((item, idx) => {
          const soon = item.daysUntil <= 30, past = item.daysUntil < 0
          const c = past ? 'var(--red)' : soon ? 'var(--amber)' : 'var(--muted)'
          return (
            <div key={item.id} onClick={() => openEdit(item)} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.9rem', cursor: 'pointer', borderBottom: idx < periodic.length-1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
              <span style={{ fontSize: '0.9rem' }}>{item.category?.icon || '📄'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.85rem', color: 'var(--text)' }}>{item.name} <span style={{ fontSize: '0.62rem', color: 'var(--muted)', textTransform: 'uppercase' }}>· {item.bill_frequency}</span></div>
                <div style={{ fontSize: '0.68rem', color: c }}>
                  {format(parseISO(item.next_due_date), 'MMM d, yyyy')} · {past ? `${Math.abs(item.daysUntil)}d overdue` : item.daysUntil === 0 ? 'due today' : `in ${item.daysUntil} days`}
                </div>
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--accentL)' }}>{fmt(item.budgeted_amount)}<span style={{ fontSize: '0.6rem', color: 'var(--muted)' }}>/mo</span></span>
            </div>
          )
        })}
      </div>

      {/* Unscheduled */}
      {unscheduled.length > 0 && (
        <>
          <h2 style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.5rem' }}>Not scheduled yet</h2>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            {unscheduled.map((item, idx) => (
              <div key={item.id} onClick={() => openEdit(item)} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.9rem', cursor: 'pointer', borderBottom: idx < unscheduled.length-1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                <span style={{ fontSize: '0.9rem' }}>{item.category?.icon || '📄'}</span>
                <span style={{ flex: 1, fontSize: '0.84rem', color: 'var(--muted)' }}>{item.name}</span>
                <span style={{ fontSize: '0.68rem', color: 'var(--accent)' }}>set date →</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Edit sheet */}
      {edit && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setEdit(null) }}>
          <div style={{ background: '#1a2a1c', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.5rem' }}>Bill timing</div>
            <div style={{ fontSize: '1rem', color: 'var(--text)', marginBottom: '1rem' }}>{edit.name}</div>

            <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Frequency</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', marginBottom: '1rem' }}>
              {FREQ.map(f => (
                <button key={f.l} onClick={() => setForm(x => ({ ...x, freq: f.k }))}
                  style={{ background: form.freq === f.k ? 'var(--accent)' : 'transparent', border: `1px solid ${form.freq === f.k ? 'var(--accent)' : 'var(--border)'}`, color: form.freq === f.k ? '#0d1a10' : 'var(--muted)', borderRadius: '7px', padding: '0.5rem', fontSize: '0.78rem', fontWeight: form.freq === f.k ? 700 : 400 }}>
                  {f.l}
                </button>
              ))}
            </div>

            {form.freq === 'monthly' && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Due day of month (1–31)</label>
                <input type="number" min="1" max="31" value={form.dueDay} onChange={e => setForm(x => ({ ...x, dueDay: e.target.value }))} placeholder="e.g. 15"
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'var(--font-mono)', outline: 'none' }} />
              </div>
            )}
            {(form.freq === 'annual' || form.freq === 'quarterly') && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Next due date</label>
                <input type="date" value={form.nextDue} onChange={e => setForm(x => ({ ...x, nextDue: e.target.value }))}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'var(--font-mono)', outline: 'none' }} />
              </div>
            )}

            <button onClick={save} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.9rem' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
