import { Component } from 'react'

// Without this, a render error unmounts the whole tree and the user sees a
// blank page (or a loading state that never resolves) with no way to tell us
// what went wrong. This shows the error where it can be read out or
// screenshotted, plus the two buttons that fix most things.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Road Budget crashed:', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    const e = this.state.error
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: '1.25rem 1rem', maxWidth: '600px', margin: '0 auto', color: 'var(--text)' }}>
        <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--red)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Something broke</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', color: 'var(--accentL)', marginBottom: '0.75rem' }}>Road Budget hit an error</div>
        <div style={{ fontSize: '0.8rem', color: 'var(--muted)', lineHeight: 1.5, marginBottom: '1rem' }}>
          Your data is fine — this is a display problem. Reloading usually clears it. If it keeps happening, send Rob a screenshot of the box below.
        </div>
        <pre style={{ background: 'var(--card)', border: '1px solid var(--red)', borderRadius: '8px', padding: '0.75rem', fontSize: '0.68rem', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)', marginBottom: '1rem', maxHeight: '40vh', overflow: 'auto' }}>
          {String(e?.message || e)}
          {e?.stack ? '\n\n' + String(e.stack).split('\n').slice(1, 6).join('\n') : ''}
        </pre>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => window.location.reload()}
            style={{ flex: 1, background: 'var(--accent)', border: 'none', borderRadius: '8px', padding: '0.75rem', color: 'var(--onAccent)', fontWeight: 700, fontSize: '0.88rem' }}>
            Reload
          </button>
          <button onClick={() => { try { localStorage.clear(); sessionStorage.clear() } catch {} window.location.href = '/' }}
            style={{ flex: 1, background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.75rem', color: 'var(--muted)', fontSize: '0.88rem' }}>
            Sign out &amp; reload
          </button>
        </div>
      </div>
    )
  }
}
