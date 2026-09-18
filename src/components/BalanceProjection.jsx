import { useMemo, useState } from 'react'
import { format, addDays, startOfDay } from 'date-fns'
import { paydaysBetween, billsBetween, projectDaily, perCheckShare } from '../lib/projection'

const fmt = (n) => '$' + Math.abs(Math.round(n)).toLocaleString()
const signed = (n) => (n < 0 ? '-' : '') + fmt(n)

const RANGES = [
  { d: 30,  l: '30d' },
  { d: 60,  l: '60d' },
  { d: 90,  l: '90d' },
]

/**
 * Where checking is headed. One series — the projected balance — so there is no
 * legend: the heading names it. The shape is the point (when does it dip), and
 * the single number that matters is the low point, so that gets a stat tile
 * above the plot rather than a label on every dot.
 *
 * Everything is derived from the schedule already in the app. Nothing is written.
 */
export default function BalanceProjection({ household, checking, items, startBalance }) {
  const [days, setDays]   = useState(60)
  const [hover, setHover] = useState(null)
  const [showTable, setShowTable] = useState(false)

  const model = useMemo(() => {
    if (!checking) return null
    const from = startOfDay(new Date())
    const to   = addDays(from, days)

    const checkingId = checking.id
    const mine  = (items || []).filter(i => (i.account_id || i.account?.id) === checkingId)

    const paydays = paydaysBetween(household, from, to)
    const bills   = billsBetween(mine, from, to)

    // Money that leaves checking on payday. Every savings-backed line gets a
    // real transfer — and the Exit Fund takes the whole leftover, not a planned
    // share, so if it lives in its own account that leftover leaves too. Miss
    // that and the projection is optimistic by most of a paycheck.
    const inChecking = (i) => (i.account_id || i.account?.id) === checkingId
    const net        = +household?.paycheck_amount || 0
    const others     = (items || []).filter(i => !i.is_remainder_target)
    const plannedOut = others.filter(i => !inChecking(i))
      .reduce((s, i) => s + perCheckShare(+i.budgeted_amount || 0, household?.pay_frequency), 0)
    const allShares  = others.reduce((s, i) => s + perCheckShare(+i.budgeted_amount || 0, household?.pay_frequency), 0)
    const remainder  = (items || []).find(i => i.is_remainder_target)
    const leftover   = Math.max(0, Math.round((net - allShares) * 100) / 100)
    const toSavings  = plannedOut + (remainder && !inChecking(remainder) ? leftover : 0)

    // Everyday spending: checking lines with a monthly budget but no due date.
    const dated = new Set(bills.map(b => b.itemId))
    const everyday = mine
      .filter(i => !dated.has(i.id) && !i.due_day && !i.next_due_date)
      .reduce((s, i) => s + (+i.budgeted_amount || 0), 0)

    const run = projectDaily({
      startBalance, from, days,
      paydays, bills,
      monthlyEverydaySpend: everyday,
      perPaydayToSavings: toSavings,
    })
    return { ...run, paydays, bills, everyday, toSavings, from, to }
  }, [household, checking, items, startBalance, days])

  if (!checking) return null
  if (!model) return null

  const { points, low, paydays, bills, everyday } = model
  const noAnchor = (household?.pay_frequency === 'biweekly' || household?.pay_frequency === 'weekly') && !household?.pay_anchor_date

  // --- geometry ---------------------------------------------------------
  const W = 320, H = 110, PAD_L = 4, PAD_R = 4, PAD_T = 8, PAD_B = 14
  const vals = points.map(p => p.balance)
  const maxV = Math.max(...vals, 0)
  const minV = Math.min(...vals, 0)
  const span = (maxV - minV) || 1
  const x = (i) => PAD_L + (i / (points.length - 1)) * (W - PAD_L - PAD_R)
  const y = (v) => PAD_T + (1 - (v - minV) / span) * (H - PAD_T - PAD_B)

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ')
  const zeroY = y(0)
  const lowI  = points.indexOf(low)
  const dipsNegative = minV < 0

  const hovered = hover != null ? points[hover] : null

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.6rem' }}>
        <div>
          <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.16em' }}>Where {checking.name} is headed</div>
          <div style={{ fontSize: '0.62rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
            From {fmt(startBalance)} today, through the bills and paychecks you've scheduled.
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {RANGES.map(r => (
            <button key={r.d} onClick={() => { setDays(r.d); setHover(null) }}
              style={{ background: days === r.d ? 'var(--accent)' : 'transparent', border: `1px solid ${days === r.d ? 'var(--accent)' : 'var(--border)'}`, color: days === r.d ? 'var(--onAccent)' : 'var(--muted)', borderRadius: '6px', padding: '0.2rem 0.45rem', fontSize: '0.62rem' }}>
              {r.l}
            </button>
          ))}
        </div>
      </div>

      {noAnchor ? (
        <div style={{ fontSize: '0.7rem', color: 'var(--muted)', lineHeight: 1.5, padding: '0.5rem 0' }}>
          Set your last payday under <b style={{ color: 'var(--text)' }}>Settings → pay anchor</b> and this will fill in — without it there's no way to know which weeks the checks land.
        </div>
      ) : (
        <>
          {/* The one number that matters — a stat tile, not a label on every point */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1.35rem', color: dipsNegative ? 'var(--red)' : low.balance < 500 ? 'var(--amber)' : 'var(--green)' }}>
              {signed(low.balance)}
            </span>
            <span style={{ fontSize: '0.68rem', color: 'var(--muted)' }}>
              low point{lowI > 0 ? ` on ${format(low.date, 'EEE, MMM d')}` : ' — today'}
            </span>
          </div>

          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none"
            style={{ display: 'block', touchAction: 'pan-y' }}
            onMouseLeave={() => setHover(null)}
            onMouseMove={e => {
              const box = e.currentTarget.getBoundingClientRect()
              const rel = ((e.clientX - box.left) / box.width) * W
              const i = Math.round(((rel - PAD_L) / (W - PAD_L - PAD_R)) * (points.length - 1))
              setHover(Math.max(0, Math.min(points.length - 1, i)))
            }}>
            {/* Solid hairline zero rule — the line that actually matters */}
            <line x1={PAD_L} x2={W - PAD_R} y1={zeroY} y2={zeroY} stroke="var(--hairline)" strokeWidth="1" />

            {/* Below zero reads as trouble, so it wears the danger surface */}
            {dipsNegative && (
              <rect x={PAD_L} y={zeroY} width={W - PAD_L - PAD_R} height={Math.max(0, H - PAD_B - zeroY)} fill="var(--dangerBg)" opacity="0.5" />
            )}

            <path d={path} fill="none" stroke="var(--accentL)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

            {/* Direct-label the extreme only */}
            <circle cx={x(lowI)} cy={y(low.balance)} r="4" fill={dipsNegative ? 'var(--red)' : 'var(--accentL)'} stroke="var(--card)" strokeWidth="2" />

            {hovered && (
              <>
                <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B} stroke="var(--hairline)" strokeWidth="1" />
                <circle cx={x(hover)} cy={y(hovered.balance)} r="4" fill="var(--accentL)" stroke="var(--card)" strokeWidth="2" />
              </>
            )}
          </svg>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.58rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
            <span>{format(points[0].date, 'MMM d')}</span>
            {hovered
              ? <span style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{format(hovered.date, 'MMM d')} · {signed(hovered.balance)}</span>
              : <span>touch the line to read a day</span>}
            <span>{format(points[points.length - 1].date, 'MMM d')}</span>
          </div>

          <div style={{ fontSize: '0.6rem', color: 'var(--muted)', marginTop: '0.55rem', lineHeight: 1.5 }}>
            {paydays.length} paycheck{paydays.length === 1 ? '' : 's'} · {bills.length} dated bill{bills.length === 1 ? '' : 's'}
            {model.toSavings > 0 && <> · {fmt(model.toSavings)} per check out to savings</>}
            {everyday > 0 && <> · {fmt(everyday)}/mo everyday spending spread evenly</>}
          </div>

          <button onClick={() => setShowTable(t => !t)}
            style={{ marginTop: '0.5rem', background: 'transparent', border: 'none', padding: 0, color: 'var(--muted)', fontSize: '0.62rem', textDecoration: 'underline' }}>
            {showTable ? 'Hide' : 'Show'} what's coming
          </button>

          {/* A readable table of the same data — the chart is not the only way in */}
          {showTable && (
            <div style={{ marginTop: '0.5rem', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', maxHeight: '15rem', overflowY: 'auto' }}>
              {[...paydays.map(p => ({ date: p.date, label: 'Paycheck', amount: p.amount, In: true })),
                ...bills.map(b => ({ date: b.date, label: b.name, amount: -b.amount, In: false }))]
                .sort((a, b) => a.date - b.date)
                .map((e, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.4rem 0.6rem', borderBottom: '1px solid var(--hairline)', fontSize: '0.68rem' }}>
                    <span style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{format(e.date, 'MMM d')}</span>
                    <span style={{ flex: 1, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.label}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: e.In ? 'var(--green)' : 'var(--text)' }}>{e.In ? '+' : '-'}{fmt(e.amount)}</span>
                  </div>
                ))}
              {paydays.length + bills.length === 0 && (
                <div style={{ padding: '0.75rem', fontSize: '0.68rem', color: 'var(--muted)', textAlign: 'center' }}>Nothing scheduled in this window.</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
