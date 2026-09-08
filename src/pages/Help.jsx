const card    = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.85rem 1rem', marginBottom: '0.6rem' }
const h2      = { fontSize: '0.72rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.12em', margin: '1.4rem 0 0.6rem' }
const taskTitle = { fontSize: '0.9rem', color: 'var(--text)', fontWeight: 600, marginBottom: '0.2rem' }
const taskBody  = { fontSize: '0.8rem', color: 'var(--muted)', lineHeight: 1.5 }

function Task({ icon, title, children }) {
  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
        <span style={{ fontSize: '1.1rem', lineHeight: 1.3 }}>{icon}</span>
        <div>
          <div style={taskTitle}>{title}</div>
          <div style={taskBody}>{children}</div>
        </div>
      </div>
    </div>
  )
}

export default function Help() {
  return (
    <div className="page" style={{ padding: '1rem 0.85rem 5.5rem' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, color: 'var(--accentL)', marginBottom: '0.25rem' }}>How it works</div>
      <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>Everything you need to run Road Budget day to day. Whatever you both change syncs instantly.</div>

      {/* Everyday tasks */}
      <h2 style={h2}>The things you'll do most</h2>

      <Task icon="ðŸ’¸" title="Log something you spent">
        Tap <b>Log</b> at the bottom â†’ enter the amount, pick which <b>budget category</b> and <b>account</b> it came from, add a note, save. That's it â€” the Dashboard and Budget update right away.
      </Task>

      <Task icon="ðŸ”§" title="Fix or remove something you logged">
        On <b>Transactions</b>, tap the entry. The same form opens with everything filled in â€” change the amount, category, account, note or date and hit <b>Save Changes</b>, or tap <b>Delete entry</b> to remove it. Account balances and budget totals recalculate on their own, and every edit and deletion is recorded in <b>Activity</b>.
      </Task>

      <Task icon="â†”ï¸" title="Move money between accounts">
        On <b>Log</b>, choose <b>Transfer</b>, pick the "from" and "to" accounts and the amount. Use this to shift money into a fund (like Disney or Emergency).
      </Task>

      <Task icon="ðŸ“…" title="On payday">
        Go to <b>Paycheck</b> â†’ <b>Process Paycheck</b> â†’ confirm the net amount. It splits the check into your funds automatically and drops the rest into checking. Do this each time a paycheck lands.
      </Task>

      <Task icon="ðŸ—“ï¸" title="When you pay an annual bill (insurance, registration)">
        Open <b>Bills</b>, tap that bill, and hit <b>"Mark paid."</b> That resets its little savings fund and starts the next year. The app quietly sets aside a bit each month so the money's there when it's due.
      </Task>

      <Task icon="âœï¸" title="Change what you budget for something">
        On <b>Budget</b>, tap the dollar amount under any line and type a new number. Tap the line's <b>name</b> to rename it, or the coloured chip to change its tier. To add or remove a line, use <b>+ Add line item</b> or the little âœ• â€” removing asks you to confirm first.
      </Task>

      <Task icon="ðŸŽ¯" title="Tell the app what a fund really holds">
        The home screen estimates each fund by adding up your monthly budget since you started, minus what you've spent. If a fund actually holds a different amount, tap its <b>name</b> under Funds Available and enter the real figure â€” everything from then on counts up from there. Same on <b>Accounts</b>: tap a card to set its true balance.
      </Task>

      {/* Home screen */}
      <h2 style={h2}>What the home screen shows you</h2>

      <Task icon="ðŸ“Š" title="Money this month">
        Top cards: what you'll earn this month, what you've spent, your budget, and what's left. Some months have <b>3 paychecks</b> â€” those are your cushion months.
      </Task>

      <Task icon="ðŸ”" title="Carry-over">
        Because paychecks are every two weeks, most months have 2 and a couple have 3. This card tells you if you need to <b>carry money in from last month</b> to cover this one â€” or if you're <b>building a reserve</b> to use later.
      </Task>

      <Task icon="ðŸŽ¯" title="Priorities">
        Everything is sorted into <b>Essentials</b> (must-haves), <b>Lifestyle</b> (the fun stuff that makes this worth doing), and <b>Savings goals</b>. A âœ“ means your paycheck covers it. Savings goals are meant to be filled by <b>bonuses and 3-paycheck months</b> â€” so don't worry if they're not "covered" every month.
      </Task>

      <Task icon="ðŸ””" title="Due soon">
        Upcoming yearly bills with how many days until they're due, so nothing sneaks up on us.
      </Task>

      {/* Good to know */}
      <h2 style={h2}>Good to know</h2>

      <Task icon="ðŸŸ¢" title="The tier chips (E / L / S)">
        On the Budget page each line has a small colored letter â€” <b>E</b>ssential, <b>L</b>ifestyle, or <b>S</b>avings. Tap it to move a line between them if we decide something belongs in a different bucket.
      </Task>

      <Task icon="ðŸ“œ" title="See who changed what">
        The <b>Activity</b> icon (top of the home screen) shows every change either of us made â€” handy if a number looks different than you remembered.
      </Task>

      <Task icon="âš™ï¸" title="Sign-in & settings">
        Sign in with <b>Google</b> â€” no password to remember. In <b>Settings</b> (gear icon, top right) you can update take-home pay or change your password.
      </Task>

      <div style={{ fontSize: '0.72rem', color: 'var(--muted)', textAlign: 'center', margin: '1.5rem 0 0.5rem', lineHeight: 1.5 }}>
        Rule of thumb: <b style={{ color: 'var(--accentL)' }}>salary covers Essentials + Lifestyle; bonuses fill the Savings goals.</b><br />If a month feels tight, it's usually a 2-paycheck month â€” the 3-paycheck months make up for it.
      </div>
    </div>
  )
}
