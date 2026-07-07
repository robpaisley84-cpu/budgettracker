import { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'

const fmt2 = (n) => '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const FREQ = {
  weekly:      { label: 'Weekly',       perYear: 52, typical: 4, high: 5 },
  biweekly:    { label: 'Bi-weekly',    perYear: 26, typical: 2, high: 3 },
  semimonthly: { label: 'Semi-monthly', perYear: 24, typical: 2, high: 2 },
  monthly:     { label: 'Monthly',      perYear: 12, typical: 1, high: 1 },
}
const dated = (f) => f === 'weekly' || f === 'biweekly'  // needs an anchor payday

export default function Settings() {
  const { member, household, updateHousehold, signOut } = useAuth()

  const [payAmt, setPayAmt]     = useState(household?.paycheck_amount ?? '')
  const [freq, setFreq]         = useState(household?.pay_frequency || 'biweekly')
  const [anchor, setAnchor]     = useState(household?.pay_anchor_date || '')
  const [saving, setSaving]     = useState(false)
  const [savedAt, setSavedAt]   = useState(false)

  // Sync inputs when the household loads/changes (initial useState runs before data may be ready)
  useEffect(() => {
    if (!household) return
    setPayAmt(household.paycheck_amount ?? '')
    setFreq(household.pay_frequency || 'biweekly')
    setAnchor(household.pay_anchor_date || '')
  }, [household?.id, household?.paycheck_amount, household?.pay_frequency, household?.pay_anchor_date])

  const perCheck = +payAmt || 0
  const cfg      = FREQ[freq] || FREQ.biweekly
  const typical  = perCheck * cfg.typical
  const high     = perCheck * cfg.high
  const annual   = perCheck * cfg.perYear

  const dirty =
    String(payAmt) !== String(household?.paycheck_amount ?? '') ||
    freq !== (household?.pay_frequency || 'biweekly') ||
    (anchor || '') !== (household?.pay_anchor_date || '')

  async function saveIncome() {
    if (!payAmt && payAmt !== 0) return
    setSaving(true)
    setSavedAt(false)
    const { error } = await updateHousehold({
      paycheck_amount: perCheck,
      pay_frequency: freq,
      pay_anchor_date: dated(freq) ? (anchor || null) : null,
      monthly_income: Math.round((annual / 12) * 100) / 100,  // annual average, for reference
    })
    setSaving(false)
    if (!error) { setSavedAt(true); setTimeout(() => setSavedAt(false), 2500) }
  }

  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)', marginBottom: '1.25rem' }}>Settings</div>

      {/* Income */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.75rem' }}>Take-Home Pay</div>

        <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Net pay per check</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.85rem' }}>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>$</span>
          <input
            type="number" inputMode="decimal" value={payAmt}
            onChange={e => setPayAmt(e.target.value)} placeholder="3801.71"
            style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.55rem 0.7rem', color: 'var(--text)', fontSize: '0.95rem', fontFamily: 'var(--font-mono)', outline: 'none' }}
          />
        </div>

        <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.35rem' }}>Pay frequency</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', marginBottom: '0.85rem' }}>
          {Object.entries(FREQ).map(([k, v]) => (
            <button key={k} onClick={() => setFreq(k)}
              style={{
                background: freq === k ? 'var(--accent)' : 'transparent',
                border: `1px solid ${freq === k ? 'var(--accent)' : 'var(--border)'}`,
                color: freq === k ? '#0d1a10' : 'var(--muted)',
                borderRadius: '7px', padding: '0.5rem', fontSize: '0.78rem', fontWeight: freq === k ? 700 : 400,
              }}>
              {v.label}
            </button>
          ))}
        </div>

        {dated(freq) && (
          <>
            <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>Most recent payday</label>
            <input
              type="date" value={anchor} onChange={e => setAnchor(e.target.value)}
              style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '0.55rem 0.7rem', color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'var(--font-mono)', outline: 'none', marginBottom: '0.35rem' }}
            />
            <div style={{ fontSize: '0.62rem', color: 'var(--muted)', marginBottom: '0.85rem' }}>Anchors the {cfg.label.toLowerCase()} cycle so each month counts its real paydays.</div>
          </>
        )}

        {/* Cash-flow preview */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.7rem', marginBottom: '0.85rem', display: 'grid', gap: '0.45rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>Most months ({cfg.typical} check{cfg.typical > 1 ? 's' : ''})</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', color: 'var(--green)' }}>{fmt2(typical)}</span>
          </div>
          {cfg.high !== cfg.typical && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{cfg.high}-check months</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', color: 'var(--accentL)' }}>{fmt2(high)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>Annual</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--muted)' }}>{fmt2(annual)}</span>
          </div>
        </div>

        <button onClick={saveIncome} disabled={saving || !dirty}
          style={{ width: '100%', background: dirty ? 'var(--green)' : 'var(--border)', border: 'none', borderRadius: '8px', padding: '0.75rem', color: dirty ? '#0d1a10' : 'var(--muted)', fontWeight: 700, fontSize: '0.88rem' }}>
          {saving ? 'Saving…' : savedAt ? '✓ Saved' : dirty ? 'Save Income' : 'Saved'}
        </button>
      </div>

      {/* Profile */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>Your Profile</div>
        <div style={{ fontSize: '0.88rem', color: 'var(--text)' }}>{member?.display_name || 'No name set'}</div>
        <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{member?.role}</div>
      </div>

      {/* Sign out */}
      <button onClick={signOut} style={{ width: '100%', background: 'transparent', border: '1px solid #c05a40', color: '#c05a40', borderRadius: 'var(--radius)', padding: '0.75rem', fontSize: '0.88rem', marginTop: '0.5rem' }}>
        Sign Out
      </button>
    </div>
  )
}
