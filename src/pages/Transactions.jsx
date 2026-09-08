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
  const [err, setErr]                   = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => { if (household) load() }, [household])

  useEffect(() => {
    if (!household) return
    // Reload rather than splicing in payload.new: edits and deletes have to be
    // reflected too, and the raw payload has none of the embedded join data.
    const sub = supabase.channel('txn-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions', filter: `household_id=eq.${household.id}` }, () => load())
      .subscribe()
    return () => sub.unsubscribe()
  }, [household])

  async function load() {
    // transactions has two FKs to accounts (account_id, to_account_id), so the
    // accounts embed must name the one we want or PostgREST rejects the request.
    const [txnRes, accRes, catRes] = await Promise.all([
      supabase.from('transactions').select('*, budget_item:budget_items(name,category:budget_categories(name)), account:accounts!account_id(name)').eq('household_id', household.id).order('date', { ascending: false }).order('created_at', { ascending: false }).limit(60),
      supabase.from('accounts').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order'),
      supabase.from('budget_categories').select('*, items:budget_items(id,name)').eq('household_id', household.id).order('sort_order'),
    ])

    const failed = [txnRes, accRes, catRes].find(r => r.error)
    setErr(failed ? `Couldn't load: ${failed.error.message}` : '')

    setTransactions(txnRes.data || [])
    setAccounts(accRes.data || [])
    setCategories(catRes.data || [])
    setLoading(false)
  }

  // Open the modal on an existing row to correct it
  function editTransaction(t) {
    setForm({
      id: t.id,
      type: t.type,
      amount: String(t.amount),
      description: t.description || '',
      date: t.date,
      account_id: t.account_id || '',
      budget_item_id: t.budget_item_id || '',
    })
    setConfirmDelete(false)
    setShowLog(true)
  }

  function newTransaction() {
    setForm({ type: 'expense', date: format(new Date(), 'yyyy-MM-dd') })
    setConfirmDelete(false)
    setShowLog(true)
  }

  // Account balances are derived from this history (migration 012), so saving
  // and deleting only touch the transaction row — balances follow on their own.
  async function logTransaction() {
    if (!form.amount || !form.type) return
    setSaving(true)

    const row = {
      household_id: household.id,
      account_id: form.account_id || null,
      // only expenses belong to a budget line — don't leave a stale one behind
      // if the type was switched during an edit
      budget_item_id: form.type === 'expense' ? (form.budget_item_id || null) : null,
      type: form.type,
      amount: +form.amount,
      description: form.description || '',
      date: form.date,
      budget_month: form.date?.slice(0, 7),
    }

    const { error } = form.id
      ? await supabase.from('transactions').update(row).eq('id', form.id)
      : await supabase.from('transactions').insert({ ...row, created_by: user.id })

    // Keep the modal open on failure so the entry isn't lost
    if (error) {
      setErr(`Couldn't save: ${error.message}`)
      setSaving(false)
      return
    }

    setSaving(false)
    closeModal()
    load()
  }

  async function deleteTransaction() {
    if (!form.id) return
    setSaving(true)
    const { error } = await supabase.from('transactions').delete().eq('id', form.id)
    if (error) {
      setErr(`Couldn't delete: ${error.message}`)
      setSaving(false)
      setConfirmDelete(false)
      return
    }
    setSaving(false)
    closeModal()
    load()
  }

  function closeModal() {
    setShowLog(false)
    setConfirmDelete(false)
    setForm({ type: 'expense', date: format(new Date(), 'yyyy-MM-dd') })
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
          <button onClick={newTransaction} style={{ background: 'var(--accent)', border: 'none', color: '#0d1a10', borderRadius: '7px', padding: '0.45rem 0.9rem', fontWeight: 700, fontSize: '0.82rem' }}>+ Log</button>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {['all', 'expense', 'income', 'transfer'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ background: filter === f ? 'var(--accent)' : 'transparent', color: filter === f ? '#0d1a10' : 'var(--muted)', border: `1px solid ${filter === f ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '5px', padding: '0.28rem 0.6rem', fontSize: '0.72rem', fontWeight: filter === f ? 700 : 400, textTransform: 'capitalize' }}>{f}</button>
          ))}
        </div>
      </div>

      {/* Error banner — never fail silently into an empty list */}
      {err && (
        <div style={{ margin: '0.6rem 0.85rem 0', background: 'rgba(220,80,80,0.12)', border: '1px solid var(--red)', borderRadius: '8px', padding: '0.6rem 0.75rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.85rem' }}>⚠️</span>
          <div style={{ flex: 1, fontSize: '0.72rem', color: 'var(--text)', lineHeight: 1.45 }}>{err}</div>
          <button onClick={() => setErr('')} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.9rem', lineHeight: 1, padding: 0 }}>×</button>
        </div>
      )}

      {/* Transaction list */}
      <div style={{ padding: '0.5rem 0.85rem' }}>
        {filtered.length === 0 && !err && (
          <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '3rem 1rem', fontSize: '0.85rem' }}>No transactions yet — tap + Log to add one</div>
        )}
        {filtered.length > 0 && (
          <div style={{ fontSize: '0.62rem', color: 'var(--muted)', padding: '0 0 0.5rem', textAlign: 'center' }}>Tap any entry to edit or delete it</div>
        )}
        {groupByDate(filtered).map(([date, txns]) => (
          <div key={date} style={{ marginBottom: '0.75rem' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em', padding: '0.35rem 0', marginBottom: '0.25rem' }}>
              {format(new Date(date + 'T12:00'), 'EEEE, MMM d')}
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              {txns.map((t, i) => (
                <div key={t.id} onClick={() => editTransaction(t)} role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editTransaction(t) } }}
                  style={{ display: 'flex', alignItems: 'center', padding: '0.65rem 0.9rem', borderBottom: i < txns.length-1 ? '1px solid var(--border)' : 'none', gap: '0.6rem', cursor: 'pointer' }}>
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
          onClick={e => { if (e.target === e.currentTarget) closeModal() }}>
          <div style={{ background: '#1a2a1c', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '1rem' }}>{form.id ? 'Edit Transaction' : 'Log Transaction'}</div>

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
              {saving ? 'Saving…' : form.id ? 'Save Changes' : 'Log Transaction'}
            </button>

            {/* Delete — only on an existing entry, behind a confirm step */}
            {form.id && (
              confirmDelete ? (
                <div style={{ marginTop: '0.85rem', border: '1px solid var(--red)', borderRadius: '8px', padding: '0.85rem', background: 'rgba(220,80,80,0.08)' }}>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text)', marginBottom: '0.7rem', lineHeight: 1.5 }}>
                    Delete this entry? Account balances and budget totals will recalculate without it.
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button onClick={deleteTransaction} disabled={saving}
                      style={{ flex: 1, background: 'var(--red)', border: 'none', borderRadius: '7px', padding: '0.6rem', color: '#fff', fontWeight: 700, fontSize: '0.82rem' }}>
                      {saving ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button onClick={() => setConfirmDelete(false)} disabled={saving}
                      style={{ flex: 1, background: 'transparent', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem', color: 'var(--muted)', fontSize: '0.82rem' }}>
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(true)} disabled={saving}
                  style={{ width: '100%', marginTop: '0.6rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.65rem', color: 'var(--red)', fontSize: '0.82rem' }}>
                  Delete entry
                </button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}
