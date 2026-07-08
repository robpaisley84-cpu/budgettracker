import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDistanceToNow, parseISO } from 'date-fns'

const money = (v) => '$' + Math.abs(Math.round(+v || 0)).toLocaleString()

// Turn a raw audit row into a human-friendly { icon, text }
function describe(e) {
  const o = e.old_data || {}, n = e.new_data || {}
  const t = e.table_name, op = e.operation

  if (t === 'transactions') {
    const d = n.description || o.description || ''
    const amt = money(n.amount ?? o.amount)
    const kind = n.type || o.type || 'expense'
    const label = kind === 'transfer' ? 'transfer' : kind === 'income' ? 'income' : kind === 'allocation' ? 'allocation' : 'transaction'
    const suffix = d ? ` — ${d}` : ''
    if (op === 'INSERT') return { icon: kind === 'transfer' ? '🔄' : kind === 'income' ? '💵' : '💸', text: `added a ${amt} ${label}${suffix}` }
    if (op === 'DELETE') return { icon: '🗑️', text: `deleted a ${amt} ${label}${suffix}` }
    return { icon: '✏️', text: `edited a ${label}${suffix}` }
  }
  if (t === 'budget_items') {
    const name = n.name || o.name || 'item'
    if (op === 'INSERT') return { icon: '➕', text: `added budget line "${name}"` }
    if (op === 'DELETE') return { icon: '🗑️', text: `deleted budget line "${name}"` }
    if (o.is_active !== false && n.is_active === false) return { icon: '🗑️', text: `removed "${name}"` }
    if (+o.budgeted_amount !== +n.budgeted_amount) return { icon: '✏️', text: `changed "${name}" budget: ${money(o.budgeted_amount)} → ${money(n.budgeted_amount)}` }
    if (o.name !== n.name) return { icon: '✏️', text: `renamed "${o.name}" → "${n.name}"` }
    if (o.due_day != n.due_day || o.next_due_date != n.next_due_date || o.bill_frequency != n.bill_frequency) return { icon: '🗓️', text: `updated due date for "${name}"` }
    if (o.is_pinned != n.is_pinned) return { icon: '📌', text: `${n.is_pinned ? 'pinned' : 'unpinned'} "${name}"` }
    return { icon: '✏️', text: `updated "${name}"` }
  }
  if (t === 'accounts') {
    const name = n.name || o.name || 'account'
    if (op === 'INSERT') return { icon: '🏦', text: `added account "${name}"` }
    if (op === 'DELETE') return { icon: '🗑️', text: `deleted account "${name}"` }
    if (+o.balance !== +n.balance) return { icon: '🏦', text: `"${name}" balance: ${money(o.balance)} → ${money(n.balance)}` }
    return { icon: '🏦', text: `updated account "${name}"` }
  }
  if (t === 'paychecks') {
    if (op === 'INSERT') return { icon: '📅', text: `processed a paycheck (+${money(n.net_amount)})` }
    return { icon: '📅', text: `${op.toLowerCase()}d a paycheck` }
  }
  if (t === 'allocation_rules') {
    const name = n.name || o.name || 'rule'
    if (op === 'INSERT') return { icon: '📅', text: `added allocation rule "${name}"` }
    if (op === 'DELETE') return { icon: '🗑️', text: `deleted allocation rule "${name}"` }
    return { icon: '📅', text: `updated allocation rule "${name}"` }
  }
  if (t === 'budget_categories') {
    const name = n.name || o.name || 'category'
    if (op === 'INSERT') return { icon: '📂', text: `added category "${name}"` }
    if (op === 'DELETE') return { icon: '🗑️', text: `deleted category "${name}"` }
    if (o.name !== n.name) return { icon: '✏️', text: `renamed category "${o.name}" → "${n.name}"` }
    return { icon: '📂', text: `updated category "${name}"` }
  }
  if (t === 'households') {
    if (+o.paycheck_amount !== +n.paycheck_amount) return { icon: '⚙️', text: `changed take-home pay: ${money(o.paycheck_amount)} → ${money(n.paycheck_amount)}` }
    return { icon: '⚙️', text: `updated household settings` }
  }
  return { icon: '•', text: `${op.toLowerCase()} on ${t}` }
}

export default function Activity() {
  const { household } = useAuth()
  const [log, setLog]       = useState([])
  const [names, setNames]   = useState({})
  const [filter, setFilter] = useState('all')   // 'all' | user_id
  const [loading, setLoading] = useState(true)

  useEffect(() => { if (household) load() }, [household])

  async function load() {
    setLoading(true)
    const [{ data: rows }, { data: members }] = await Promise.all([
      supabase.from('audit_log').select('*').eq('household_id', household.id).order('changed_at', { ascending: false }).limit(150),
      supabase.from('household_members').select('user_id, display_name').eq('household_id', household.id),
    ])
    const map = {}
    members?.forEach(m => { map[m.user_id] = m.display_name || 'Member' })
    setNames(map)
    setLog(rows || [])
    setLoading(false)
  }

  const actor = (uid) => uid ? (names[uid] || 'Someone') : 'Admin'
  const filtered = filter === 'all' ? log : log.filter(e => (e.changed_by || 'admin') === filter)

  const people = [
    { k: 'all', l: 'Everyone' },
    ...Object.entries(names).map(([k, l]) => ({ k, l })),
  ]

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)', marginBottom: '0.25rem' }}>Activity</div>
      <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '1rem' }}>Every change to the budget, accounts, and transactions — who and when.</div>

      {/* Person filter */}
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        {people.map(p => (
          <button key={p.k} onClick={() => setFilter(p.k)}
            style={{ background: filter === p.k ? 'var(--accent)' : 'transparent', border: `1px solid ${filter === p.k ? 'var(--accent)' : 'var(--border)'}`, color: filter === p.k ? '#0d1a10' : 'var(--muted)', borderRadius: '999px', padding: '0.3rem 0.75rem', fontSize: '0.75rem', fontWeight: filter === p.k ? 700 : 400 }}>
            {p.l}
          </button>
        ))}
      </div>

      {filtered.length === 0 && <div style={{ fontSize: '0.85rem', color: 'var(--muted)', textAlign: 'center', padding: '2rem' }}>No activity yet — changes will show up here as you use the app.</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {filtered.map(e => {
          const { icon, text } = describe(e)
          return (
            <div key={e.id} style={{ display: 'flex', gap: '0.65rem', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.65rem 0.8rem' }}>
              <span style={{ fontSize: '1rem', lineHeight: 1.3 }}>{icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.85rem', color: 'var(--text)', lineHeight: 1.35 }}>
                  <span style={{ fontWeight: 600, color: 'var(--accentL)' }}>{actor(e.changed_by)}</span> {text}
                </div>
                <div style={{ fontSize: '0.66rem', color: 'var(--muted)', marginTop: '0.15rem' }}>{formatDistanceToNow(parseISO(e.changed_at), { addSuffix: true })}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
