import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { format } from 'date-fns'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()

export default function Accounts() {
  const { household, user } = useAuth()
  const [accounts, setAccounts] = useState([])
  const [modal, setModal]       = useState(null)  // 'add' | 'transfer' | 'edit'
  const [form, setForm]         = useState({})
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)

  useEffect(() => { if (household) load() }, [household])

  useEffect(() => {
    if (!household) return
    const sub = supabase.channel('accounts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts', filter: `household_id=eq.${household.id}` }, () => load())
      .subscribe()
    return () => sub.unsubscribe()
  }, [household])

  async function load() {
    const { data } = await supabase.from('accounts').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order')
    setAccounts(data || [])
    setLoading(false)
  }

  async function addAccount() {
    if (!form.name || !household) return
    setSaving(true)
    await supabase.from('accounts').insert({
      household_id: household.id,
      name: form.name,
      type: form.type || 'checking',
      icon: form.icon || '🏦',
      color: form.color || '#4a9a7a',
      target_balance: form.target ? +form.target : null,
      balance: form.balance ? +form.balance : 0,
      sort_order: accounts.length + 1,
    })
    setSaving(false); setModal(null); setForm({})
  }

  async function doTransfer() {
    if (!form.from || !form.to || !form.amount || form.from === form.to) return
    setSaving(true)
    const amt = +form.amount
    const today = format(new Date(), 'yyyy-MM-dd')
    const month = format(new Date(), 'yyyy-MM')
    const fromAcc = accounts.find(a => a.id === form.from)
    const toAcc   = accounts.find(a => a.id === form.to)

    await supabase.from('transactions').insert({
      household_id: household.id,
      account_id: form.from,
      to_account_id: form.to,
      type: 'transfer',
      amount: amt,
      description: form.note || `Transfer: ${fromAcc?.name} → ${toAcc?.name}`,
      date: today, budget_month: month,
      created_by: user.id,
    })
    await supabase.from('accounts').update({ balance: (fromAcc?.balance || 0) - amt }).eq('id', form.from)
    await supabase.from('accounts').update({ balance: (toAcc?.balance || 0) + amt }).eq('id', form.to)

    setSaving(false); setModal(null); setForm({}); load()
  }

  const totalBalance = accounts.reduce((s, a) => s + +a.balance, 0)

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--accent)', textTransform: 'uppercase' }}>Accounts</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)' }}>Total: {fmt(totalBalance)}</div>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={() => { setModal('transfer'); setForm({}) }} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '7px', padding: '0.45rem 0.75rem', fontSize: '0.78rem' }}>↔ Transfer</button>
          <button onClick={() => { setModal('add'); setForm({ type: 'checking', icon: '🏦' }) }} style={{ background: 'var(--accent)', border: 'none', color: '#0d1a10', borderRadius: '7px', padding: '0.45rem 0.75rem', fontSize: '0.78rem', fontWeight: 700 }}>+ Add</button>
        </div>
      </div>

      {/* Account cards */}
      <div style={{ display: 'grid', gap: '0.6rem' }}>
        {accounts.map(a => {
          const pct = a.target_balance ? Math.min((+a.balance / +a.target_balance) * 100, 100) : null
          return (
            <div key={a.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: pct !== null ? '0.6rem' : 0 }}>
                <span style={{ fontSize: '1.3rem' }}>{a.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>{a.name}</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{a.type}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', fontWeight: 500, color: a.color || 'var(--accentL)' }}>{fmt(a.balance)}</div>
                  {a.target_balance && <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>of {fmt(a.target_balance)}</div>}
                </div>
              </div>
              {pct !== null && (
                <div>
                  <div style={{ background: 'var(--border)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: a.color || 'var(--green)', borderRadius: '4px', transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--muted)', marginTop: '0.25rem' }}>{Math.round(pct)}% of goal</div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Modal */}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) { setModal(null); setForm({}) } }}>
          <div style={{ background: '#1a2a1c', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.25rem' }}>{modal === 'add' ? 'New Account' : 'Transfer Funds'}</div>

            {modal === 'add' && (
              <>
                {[
                  { l: 'Account Name', k: 'name', p: 'e.g. Emergency Fund' },
                  { l: 'Starting Balance', k: 'balance', p: '0', type: 'number' },
                  { l: 'Goal / Target (optional)', k: 'target', p: '10000', type: 'number' },
                  { l: 'Icon (emoji)', k: 'icon', p: '🏦' },
                  { l: 'Color (hex)', k: 'color', p: '#4a9a7a' },
                ].map(f => (
                  <div key={f.k} style={{ marginBottom: '0.75rem' }}>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{f.l}</label>
                    <input type={f.type || 'text'} value={form[f.k] || ''} onChange={e => setForm(x => ({ ...x, [f.k]: e.target.value }))} placeholder={f.p}
                      style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }} />
                  </div>
                ))}
                <div style={{ marginBottom: '0.75rem' }}>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Account Type</label>
                  <select value={form.type || 'checking'} onChange={e => setForm(x => ({ ...x, type: e.target.value }))}
                    style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }}>
                    <option value="checking">Checking</option>
                    <option value="savings">Savings</option>
                    <option value="fund">Fund / Goal</option>
                  </select>
                </div>
                <button onClick={addAccount} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.9rem' }}>
                  {saving ? 'Saving…' : 'Add Account'}
                </button>
              </>
            )}

            {modal === 'transfer' && (
              <>
                {[
                  { l: 'From Account', k: 'from', type: 'select' },
                  { l: 'To Account', k: 'to', type: 'select' },
                  { l: 'Amount', k: 'amount', p: '0', type: 'number' },
                  { l: 'Note (optional)', k: 'note', p: 'e.g. Monthly savings allocation' },
                ].map(f => (
                  <div key={f.k} style={{ marginBottom: '0.75rem' }}>
                    <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{f.l}</label>
                    {f.type === 'select' ? (
                      <select value={form[f.k] || ''} onChange={e => setForm(x => ({ ...x, [f.k]: e.target.value }))}
                        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }}>
                        <option value="">Select account…</option>
                        {accounts.map(a => <option key={a.id} value={a.id}>{a.icon} {a.name} ({fmt(a.balance)})</option>)}
                      </select>
                    ) : (
                      <input type={f.type || 'text'} value={form[f.k] || ''} onChange={e => setForm(x => ({ ...x, [f.k]: e.target.value }))} placeholder={f.p}
                        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }} />
                    )}
                  </div>
                ))}
                <button onClick={doTransfer} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: '#0d1a10', fontWeight: 700, fontSize: '0.9rem' }}>
                  {saving ? 'Processing…' : 'Transfer Funds'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
