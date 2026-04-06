import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format } from 'date-fns'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()

export default function Transactions() {
  const { household, user } = useAuth()
  const [transactions, setTransactions] = useState([])
  const [accounts, setAccounts]         = useState([])
  const [categories, setCategories]     = useState([])
  const [showLog, setShowLog]           = useState(false)
  const [form, setForm]                 = useState({ type: 'expense', date: format(new Date(), 'yyyy-MM-dd') })
  const [saving, setSaving]             = useState(false)
  const [loading, setLoading]           = useState(true)
  const [filter, setFilter]             = useState('all')

  useEffect(() => { if (household) load() }, [household])

  useEffect(() => {
    if (!household) return
    const sub = supabase.channel('txn-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions', filter: `household_id=eq.${household.id}` }, payload => {
        setTransactions(t => [payload.new, ...t])
      })
      .subscribe()
    return () => sub.unsubscribe()
  }, [household])

  async function load() {
    const [{ data: txns }, { data: accs }, { data: cats }] = await Promise.all([
      supabase.from('transactions').select('*, budget_item:budget_items(name,category:budget_categories(name)), account:accounts(name)').eq('household_id', household.id).order('date', { ascending: false }).order('created_at', { ascending: false }).limit(60),
      supabase.from('accounts').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('budget_categories').select('*, items:budget_items(id,name)').eq('household_id', household.id).order('sort_order'),
    ])
    setTransactions(txns || [])
    setAccounts(accs || [])
    setCategories(cats || [])
    setLoading(false)
  }

  async function logTransaction() {
    if (!form.amount || !form.type) return
    setSaving(true)
    const amt = +form.amount
    const month = form.date?.slice(0, 7)

    await supabase.from('transactions').insert({
      household_id: household.id,
      account_id: form.account_id || null,
      budget_item_id: form.budget_item_id || null,
      type: form.type,
      amount: amt,
      description: form.description || '',
      date: form.date,
      budget_month: month,
      created_by: user.id,
    })

    // Update account balance for expenses
    if (form.account_id && form.type === 'expense') {
      const acc = accounts.find(a => a.id === form.account_id)
      if (acc) await supabase.from('accounts').update({ balance: +acc.balance - amt }).eq('id', acc.id)
    }

    setSaving(false)
    setShowLog(false)
    setForm({ type: 'expense', date: format(new Date(), 'yyyy-MM-dd') })
    load()
  }

  const filtered = filter === 'all' ? transactions : transactions.filter(t => t.type === filter)

  const groupByDate = (txns) => {
    const groups = {}
    txns.forEach(t => {
      const d = t.date
      if (!groups[d]) groups[d] = []
      groups[d].push(t)
    })
    return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]))
  }

  const typeColors = { expense: 'var(--red)', income: 'var(--green)', transfer: 'var(--accent)', allocation: 'var(--muted)' }
  const typeIcons  = { expense: '💸', income: '💵', transfer: '↔️', allocation: '📅' }

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ paddingBottom: '5.5rem' }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg)', borderBottom: '1px solid var(--border)', padding: '0.85rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', color: 'var(--accentL)' }}>Transactions</div>
          <button onClick={() => setShowLog(true)} style={{ background: 'var(--accent)', border: 'none', color: '#0d1a10', borderRadius: '7px', padding: '0.45rem 0.9rem', fontWeight: 700, fontSize: '0.82rem' }}>+ Log</button>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {['all', 'expense', 'income', 'transfer'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ background: filter === f ? 'var(--accent)' : 'transparent', color: filter === f ? '#0d1a10' : 'var(--muted)', border: `1px solid ${filter === f ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '5px', padding: '0.28rem 0.6rem', fontSize: '0.72rem', fontWeight: filter === f ? 700 : 400, textTransform: 'capitalize' }}>{f}</button>
          ))}
        </div>
      </div>

      {/* Transaction list */}
      <div style={{ padding: '0.5rem 0.85rem' }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '3rem 1rem', fontSize: '0.85rem' }}>No transactions yet — tap + Log to add one</div>
        )}
        {groupByDate(filtered).map(([date, txns]) => (
          <div key={date} style={{ marginBottom: '0.75rem' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em', padding: '0.35rem 0', marginBottom: '0.25rem' }}>
              {format(new Date(date + 'T12:00'), 'EEEE, MMM d')}
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              {txns.map((t, i) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', padding: '0.65rem 0.9rem', borderBottom: i < txns.length-1 ? '1px solid var(--border)' : 'none', gap: '0.6rem' }}>
                  <span style={{ fontSize: '1rem' }}>{typeIcons[t.type]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.82rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description || t.budget_item?.name || '—'}</div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--muted)' }}>
                      {t.budget_item?.category?.name && <span>{t.budget_item.category.name} · </span>}
                      {t.account?.name || t.type}
                    </div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.88rem', color: typeColors[t.type], flexShrink: 0 }}>
                    {t.type === 'expense' ? '-' : '+'}{fmt(t.amount)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Log modal */}
      {showLog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setShowLog(false) }}>
          <div style={{ background: '#1a2a1c', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '1rem' }}>Log Transaction</div>

            {/* Type selector */}
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
              {['expense','income','transfer'].map(t => (
                <button key={t} onClick={() => setForm(f => ({ ...f, type: t }))} style={{ flex: 1, background: form.type === t ? 'var(--accent)' : 'transparent', color: form.type === t ? '#0d1a10' : 'var(--muted)', border: `1px solid ${form.type === t ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '6px', padding: '0.4rem', fontSize: '0.75rem', fontWeight: form.type === t ? 700 : 400, textTransform: 'capitalize' }}>{t}</button>
              ))}
            </div>

            {/* Amount */}
            <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Amount</label>
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: '8px', padding: '0 0.85rem', marginBottom: '0.85rem' }}>
              <span style={{ color: 'var(--accentL)', fontSize: '1.1rem', marginRight: '0.3rem' }}>$</span>
              <input type="number" value={form.amount || ''} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} autoFocus placeholder="0.00"
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '1.3rem', fontFamily: 'var(--font-mono)', padding: '0.55rem 0' }} />
            </div>

            {/* Category / Budget Item */}
            {form.type === 'expense' && (
              <>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Budget Category</label>
                <select value={form.budget_item_id || ''} onChange={e => setForm(f => ({ ...f, budget_item_id: e.target.value }))}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.85rem', outline: 'none', marginBottom: '0.85rem' }}>
                  <option value="">Select line item…</option>
                  {categories.map(cat => (
                    <optgroup key={cat.id} label={`${cat.icon} ${cat.name}`}>
                      {(cat.items || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              </>
            )}

            {/* Account */}
            <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Account</label>
            <select value={form.account_id || ''} onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))}
              style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.85rem', outline: 'none', marginBottom: '0.85rem' }}>
              <option value="">No account</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.icon} {a.name}</option>)}
            </select>

            {/* Description & Date */}
            {[
              { l: 'Description', k: 'description', p: 'What was this for?' },
              { l: 'Date', k: 'date', p: '', type: 'date' },
            ].map(f => (
              <div key={f.k}>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{f.l}</label>
                <input type={f.type || 'text'} value={form[f.k] || ''} onChange={e => setForm(x => ({ ...x, [f.k]: e.target.value }))} placeholder={f.p}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.88rem', outline: 'none', marginBottom: '0.85rem' }} />
              </div>
            ))}

            <button onClick={logTransaction} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.9rem' }}>
              {saving ? 'Saving…' : 'Log Transaction'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
