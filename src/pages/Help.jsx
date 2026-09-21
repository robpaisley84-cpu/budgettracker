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

      <Task icon="💸" title="Log something you spent">
        Tap <b>Log</b> at the bottom → enter the amount, pick which <b>budget category</b> and <b>account</b> it came from, add a note, save. That's it — the Dashboard and Budget update right away.
      </Task>

      <Task icon="🔧" title="Fix or remove something you logged">
        On <b>Transactions</b>, tap the entry. The same form opens with everything filled in — change the amount, category, account, note or date and hit <b>Save Changes</b>, or tap <b>Delete entry</b> to remove it. Account balances and budget totals recalculate on their own, and every edit and deletion is recorded in <b>Activity</b>.
      </Task>

      <Task icon="↔️" title="Move money between accounts">
        On <b>Log</b>, choose <b>Transfer</b>, pick the "from" and "to" accounts and the amount. Use this to shift money into a fund (like Disney or Emergency).
      </Task>

      <Task icon="📅" title="On payday">
        Go to <b>Paycheck</b> → <b>Process Paycheck</b> → confirm the net amount and the date it landed. Everything else happens on its own: the check is deposited into checking, split across every line at its plan with whatever's left going to your <b>Exit Fund</b>, and each line that lives in its own savings account (Lincoln's, Disney, Emergency) gets a real transfer. There's no form to fill in — you only open the split if <i>this</i> check needs to differ from plan.
      </Task>

      <Task icon="🏦" title="Which account a budget line lives in">
        Every line on <b>Budget</b> shows <b>in ▾</b> under it. Most lines live in <b>Checking</b> — that's a virtual envelope, nothing moves at the bank. Set a fund line to its own savings account and the line <i>becomes</i> that account: one number, and funding it transfers real money. The <b>⤵</b> button marks the one line that soaks up each paycheck's leftover.
      </Task>

      <Task icon="🗓️" title="When you pay an annual bill (insurance, registration)">
        Open <b>Bills</b>, tap that bill, and hit <b>"Mark paid."</b> That resets its little savings fund and starts the next year. The app quietly sets aside a bit each month so the money's there when it's due.
      </Task>

      <Task icon="✏️" title="Change what you budget for something">
        On <b>Budget</b>, tap the <b>spent</b> figure on any line to see the expenses behind it — tap one to open and fix it (a duplicate, a wrong line). Tap the dollar amount under a line and type a new number to change its allowance. Tap the line's <b>name</b> to rename it, or the coloured chip to change its tier. To add or remove a line, use <b>+ Add line item</b> or the little ✕ — removing asks you to confirm first.
      </Task>

      <Task icon="🔁" title="Re-split a paycheck you already processed">
        On <b>Paycheck</b>, under <b>Distribute to Budget</b>, tap the check. Change any line and the leftover line adjusts itself so the check stays exactly spoken for. <b>Each amount saves on its own, a moment after you type it</b> — there's no Save button to miss and nothing to lose if you put the phone down. The sheet only closes from <b>Done</b> or <b>✕</b>. Money you've moved between funds since is left alone.
      </Task>

      <Task icon="↔️" title="Move money between funds when something runs over">
        Tap the fund's name on the home screen. <b>Move to…</b> sends money out of it (including <b>Back to unassigned</b>, which just releases it to the pot); <b>Move from…</b> pulls money <i>in</i> from another fund, and the list only offers funds that actually have spare — never a bill. <b>Add from unassigned</b> tops it up from the pot. Every move is recorded in <b>Activity</b>, with a note if you leave one.
      </Task>

      <Task icon="⚖️" title="Balance the funds at month end">
        When the home screen says the funds are out of balance, tap <b>⚖ Balance the funds</b>. It lists every overspent allowance and every bill behind pace with the amount that would square it, pre-ticked, and lets you cover them from <b>unassigned</b> in one go. Bills are only ever topped up here, never raided. If unassigned can't cover everything, untick the ones to leave for the next check.
      </Task>

      <Task icon="🎯" title="Tell the app what a fund really holds">
        A fund's balance is what you've put into it, minus what you've spent from it. If a fund already held money before you started tracking, tap its <b>name</b> under Funds Available and enter the real figure — that becomes its opening balance, and everything counts up from there. Same on <b>Accounts</b>: tap a card to set its true balance.
      </Task>

      <Task icon="💳" title="Record which card paid for something">
        When you log an expense, <b>Paid with</b> takes a card name — Amex, Chase Visa, Debit, Cash. It offers the ones you've used before so the spelling stays the same. On the <b>Log</b> page, tap a card chip under the filters to see only that card's purchases and their total — that's how you check a statement against what's logged. It doesn't change where the money comes from: a card purchase still hits its budget line the day you buy.
      </Task>

      <Task icon="🧮" title="Split one account across several funds">
        A savings account holding just one budget line <i>is</i> that line — one number, and it can never drift. If you keep several sinking funds in <b>one</b> account, its card on <b>Accounts</b> shows how much of the balance the lines have claimed and how much is still <b>unassigned</b>. Tap <b>Assign balance</b> to divide it up; each figure saves as you type it and becomes that fund's balance as of today. Nothing moves at the bank — you're describing money that's already there.
      </Task>

      <Task icon="📈" title="See where checking is headed">
        At the top of <b>Accounts</b>, "Where checking is headed" walks today's balance forward through the paychecks and bills you've already scheduled, out to 90 days. The number above the line is the <b>low point</b> — the tightest it gets and when. Drag along the line to read any day, or tap <b>Show what's coming</b> for the same thing as a list. It's a projection, not a promise: it only knows about bills that have a due date, and it spreads flexible lines like groceries evenly across the month.
      </Task>

      {/* Home screen */}
      <h2 style={h2}>What the home screen shows you</h2>

      <Task icon="💚" title="The big number: Safe to spend">
        What's in checking that isn't spoken for by a bill — the allowance envelopes added up (overspent ones subtracted, because that money is already gone) plus anything still <b>unassigned</b>. It is the one number to trust before spending. It can be lower than a single green fund: if one fund is deep in the red, the cash under the green ones has already been used. Savings accounts aren't counted; they aren't checking.
      </Task>

      <Task icon="🎯" title="Reading a fund row">
        Sorted <b>Essentials</b>, then <b>Lifestyle</b>, then <b>Savings goals</b>, biggest first; tap a tier heading to fold it. An <b>allowance</b> shows what it has left to spend — green, amber near empty, red overspent. A <b>bill</b> shows what it's holding in grey with <b>reserved</b> (holding what the due date needs), <b>on pace</b> (the checks before the due date will finish it), or <b>behind $X</b> (what to add today). Bills are funded <i>lean</i>: a loan due the 15th only needs half held after the 18th's check, because the 2nd's check supplies the rest — unless the check and the due date are within a few days, when it's held in full. A bill you paid early this month is already saving for next month.
      </Task>

      <Task icon="🔔" title="Due soon">
        Upcoming bills with how many days until they're due and anything still to set aside, so nothing sneaks up on us.
      </Task>

      {/* Good to know */}
      <h2 style={h2}>Good to know</h2>

      <Task icon="🟢" title="The tier chips (E / L / S)">
        On the Budget page each line has a small colored letter — <b>E</b>ssential, <b>L</b>ifestyle, or <b>S</b>avings. Tap it to move a line between them if we decide something belongs in a different bucket.
      </Task>

      <Task icon="📜" title="See who changed what">
        The <b>Activity</b> icon (top of the home screen) shows every change either of us made — handy if a number looks different than you remembered.
      </Task>

      <Task icon="⚙️" title="Sign-in & settings">
        Sign in with <b>Google</b> — no password to remember. In <b>Settings</b> (gear icon, top right) you can update take-home pay or change your password.
      </Task>

      <div style={{ fontSize: '0.72rem', color: 'var(--muted)', textAlign: 'center', margin: '1.5rem 0 0.5rem', lineHeight: 1.5 }}>
        Rule of thumb: <b style={{ color: 'var(--accentL)' }}>salary covers Essentials + Lifestyle; bonuses fill the Savings goals.</b><br />If a month feels tight, it's usually a 2-paycheck month — the 3-paycheck months make up for it.
      </div>
    </div>
  )
}
