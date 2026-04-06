import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Auth       from './pages/Auth'
import Dashboard  from './pages/Dashboard'
import Budget     from './pages/Budget'
import Accounts   from './pages/Accounts'
import Transactions from './pages/Transactions'
import Allocations  from './pages/Allocations'
import Settings     from './pages/Settings'
import Nav          from './components/Nav'

function RequireAuth({ children }) {
  const { user, household, loading } = useAuth()
  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0d1a10', color: '#c8a050', fontFamily: 'Georgia, serif', fontSize: '1rem' }}>
      Loading Road Budget…
    </div>
  )
  if (!user) return <Navigate to="/auth" replace />
  return children
}

function AppShell() {
  const { user, household, loading } = useAuth()
  if (loading) return (
    <div style={{ color: '#c8a050', padding: '2rem', fontFamily: 'monospace' }}>
      Loading... user: {user ? 'yes' : 'no'}, household: {household ? 'yes' : 'no'}
    </div>
  )
  if (!user) return <Routes><Route path="*" element={<Auth />} /></Routes>

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto', minHeight: '100vh', position: 'relative' }}>
      <Routes>
        <Route path="/"             element={<RequireAuth><Dashboard /></RequireAuth>} />
        <Route path="/budget"       element={<RequireAuth><Budget /></RequireAuth>} />
        <Route path="/accounts"     element={<RequireAuth><Accounts /></RequireAuth>} />
        <Route path="/transactions" element={<RequireAuth><Transactions /></RequireAuth>} />
        <Route path="/allocations"  element={<RequireAuth><Allocations /></RequireAuth>} />
        <Route path="/settings"     element={<RequireAuth><Settings /></RequireAuth>} />
        <Route path="/auth"         element={<Auth />} />
        <Route path="*"             element={<Navigate to="/" replace />} />
      </Routes>
      <Nav />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  )
}
