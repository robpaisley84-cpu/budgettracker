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
  const [err, setErr]           = useState('')

  useEffect(() => { if (household) load() }, [household])

  useEffect(() => {
    if (!household) return
    // Balances are derived from transactions now, so changes there move the
    // numbers on this page just as much as changes to accounts do.
    const sub = supabase.channel('accounts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts', filter: `household_id=eq.${household.id}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions', filter: `household_id=eq.${household.id}` }, () => load())
      .subscribe()
    return () => sub.unsubscribe()
  }, [household])

  async function load() {
    // accounts_with_balance derives `balance` from transaction history (012)
    const { data, error } = await supabase.from('accounts_with_balance').select('*').eq('household_id', household.id).eq('is_active', true).order('sort_order')
    if (error) setErr(`Couldn't load accounts: ${error.message}`)
    else setErr('')
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
      opening_balance: form.balance ? +form.balance : 0,
      sort_order: accounts.length + 1,
    })
    setSaving(false); setModal(null); setForm({})
  }

  // Balances are derived (opening_balance + history), so "true up" means
  // solving for the opening balance that makes today's derived figure match
  // what the user says is really there — the same plug migration 012 used.
  async function saveTrueUp() {
    const acc = modal === 'trueup' ? form.acc : null
    if (!acc) return
    setSaving(true)

    const patch = {}

    // An account's name is its own record — renaming the matching budget line
    // does not touch it, so it has to be editable here.
    const newName = (form.name ?? '').trim()
    if (newName && newName !== acc.name) patch.name = newName

    // Balance is derived (opening_balance + history), so "true up" means
    // solving for the opening balance that makes today's figure match what the
    // user says is really there — the plug technique from migration 012.
    if (form.actual !== '' && form.actual != null) {
      const txnEffect = +acc.balance - (+acc.opening_balance || 0)
      patch.opening_balance = Math.round((+form.actual - txnEffect) * 100) / 100
    }

    if (Object.keys(patch).length === 0) { setSaving(false); setModal(null); setForm({}); return }

    const { error } = await supabase.from('accounts').update(patch).eq('id', acc.id)
    if (error) {
      setErr(`Couldn't update ${acc.name}: ${error.message}`)
      setSaving(false)
      return
    }
    setSaving(false); setModal(null); setForm({}); load()
  }

  async function doTransfer() {
    if (!form.from || !form.to || !form.amount || form.from === form.to) return
    setSaving(true)
    const amt = +form.amount
    const today = format(new Date(), 'yyyy-MM-dd')
    const month = format(new Date(), 'yyyy-MM')
    const fromAcc = accounts.find(a => a.id === form.from)
    const toAcc   = accounts.find(a => a.id === form.to)

    // The transfer row is the whole record — both balances derive from it (012)
    const { error } = await supabase.from('transactions').insert({
      household_id: household.id,
      account_id: form.from,
      to_account_id: form.to,
      type: 'transfer',
      amount: amt,
      description: form.note || `Transfer: ${fromAcc?.name} → ${toAcc?.name}`,
      date: today, budget_month: month,
      created_by: user.id,
    })

    if (error) {
      setErr(`Transfer failed: ${error.message}`)
      setSaving(false)
      return
    }

    setSaving(false); setModal(null); setForm({}); load()
  }

  const totalBalance = accounts.reduce((s, a) => s + +a.balance, 0)

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--muted)' }}>Loading…</div>

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      {err && (
        <div style={{ background: 'var(--dangerBg)', border: '1px solid var(--red)', borderRadius: '8px', padding: '0.6rem 0.75rem', marginBottom: '0.85rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.85rem' }}>⚠️</span>
          <div style={{ flex: 1, fontSize: '0.72rem', color: 'var(--text)', lineHeight: 1.45 }}>{err}</div>
          <button onClick={() => setErr('')} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '0.9rem', lineHeight: 1, padding: 0 }}>×</button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--accent)', textTransform: 'uppercase' }}>Accounts</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)' }}>Total: {fmt(totalBalance)}</div>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={() => { setModal('transfer'); setForm({}) }} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '7px', padding: '0.45rem 0.75rem', fontSize: '0.78rem' }}>↔ Transfer</button>
          <button onClick={() => { setModal('add'); setForm({ type: 'checking', icon: '🏦' }) }} style={{ background: 'var(--accent)', border: 'none', color: 'var(--onAccent)', borderRadius: '7px', padding: '0.45rem 0.75rem', fontSize: '0.78rem', fontWeight: 700 }}>+ Add</button>
        </div>
      </div>

      {/* Account cards */}
      <div style={{ display: 'grid', gap: '0.6rem' }}>
        {accounts.map(a => {
          const pct = a.target_balance ? Math.min((+a.balance / +a.target_balance) * 100, 100) : null
          return (
            <div key={a.id} onClick={() => { setModal('trueup'); setForm({ acc: a, name: a.name, actual: String(Math.round(+a.balance * 100) / 100) }) }}
              role="button" title="Rename or set the real balance"
              style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem', cursor: 'pointer' }}>
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
        <div style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) { setModal(null); setForm({}) } }}>
          <div style={{ background: 'var(--sheet)', borderTop: '2px solid var(--accent)', borderRadius: '16px 16px 0 0', padding: '1.25rem 1.25rem 2rem', width: '100%', maxWidth: '600px', margin: '0 auto' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '0.25rem' }}>{modal === 'add' ? 'New Account' : modal === 'trueup' ? 'True up balance' : 'Transfer Funds'}</div>

            {modal === 'trueup' && form.acc && (
              <>
                <div style={{ fontSize: '1rem', color: 'var(--text)', marginBottom: '0.85rem' }}>{form.acc.icon} {form.acc.name}</div>

                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Account name</label>
                <input value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Lincoln's Savings"
                  style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.6rem 0.8rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none', marginBottom: '0.85rem' }} />

                <div style={{ fontSize: '0.72rem', color: 'var(--muted)', lineHeight: 1.5, marginBottom: '1rem' }}>
                  Showing <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{fmt(form.acc.balance)}</b> from an opening balance of {fmt(form.acc.opening_balance || 0)} plus everything logged since.
                  Enter what the account really holds and the opening balance is adjusted to match — your transaction history is left alone.
                </div>
                <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Actual balance today</label>
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: '8px', padding: '0 0.85rem', marginBottom: '1rem' }}>
                  <span style={{ color: 'var(--accentL)', fontSize: '1.1rem', marginRight: '0.3rem' }}>$</span>
                  <input type="number" step="0.01" value={form.actual ?? ''} autoFocus onChange={e => setForm(f => ({ ...f, actual: e.target.value }))} placeholder="0.00"
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--accentL)', fontSize: '1.3rem', fontFamily: 'var(--font-mono)', padding: '0.55rem 0' }} />
                </div>
                <button onClick={saveTrueUp} disabled={saving || form.actual === ''}
                  style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
                  {saving ? 'Saving…' : 'Save balance'}
                </button>
              </>
            )}

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
                <button onClick={addAccount} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
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
                <button onClick={doTransfer} disabled={saving} style={{ width: '100%', background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.8rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.9rem' }}>
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
