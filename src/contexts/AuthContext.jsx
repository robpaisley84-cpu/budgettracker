import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext({})

export function AuthProvider({ children }) {
  const [user, setUser]           = useState(null)
  const [household, setHousehold] = useState(null)
  const [member, setMember]       = useState(null)
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) loadHousehold(session.user.id)
      else setLoading(false)
    }).catch(() => setLoading(false))

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_, session) => {
      setUser(session?.user ?? null)
      if (session?.user) await loadHousehold(session.user.id)
      else { setHousehold(null); setMember(null); setLoading(false) }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadHousehold(userId) {
    try {
      const { data: mem } = await supabase
        .from('household_members')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      if (mem) {
        const { data: hh } = await supabase
          .from('households')
          .select('*')
          .eq('id', mem.household_id)
          .maybeSingle()

        if (hh) {
          setMember(mem)
          setHousehold(hh)
        }
      }
    } catch (_) {}
    setLoading(false)
  }

  async function signIn(email, password) {
    return supabase.auth.signInWithPassword({ email, password })
  }

  async function signInWithGoogle() {
    return supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
  }

  async function signUp(email, password, displayName) {
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error || !data.user) return { error }

    const { data: hh } = await supabase
      .from('households')
      .insert({ name: 'Road Budget' })
      .select()
      .single()

    if (hh) {
      await supabase.from('household_members').insert({
        household_id: hh.id,
        user_id: data.user.id,
        display_name: displayName,
        role: 'admin',
      })
      await supabase.rpc('seed_budget', { hh_id: hh.id })
    }

    return { data }
  }

  async function joinHousehold(inviteCode, displayName) {
    const { data: hh } = await supabase
      .from('households')
      .select()
      .eq('id', inviteCode)
      .single()

    if (!hh) return { error: 'Household not found' }

    const { error } = await supabase.from('household_members').insert({
      household_id: hh.id,
      user_id: user.id,
      display_name: displayName,
      role: 'member',
    })

    if (!error) { setHousehold(hh); await loadHousehold(user.id) }
    return { error }
  }

  async function updateHousehold(patch) {
    if (!household) return { error: 'No household' }
    const { data, error } = await supabase
      .from('households')
      .update(patch)
      .eq('id', household.id)
      .select()
      .maybeSingle()
    if (!error && data) setHousehold(data)
    return { data, error }
  }

  async function signOut() {
    await supabase.auth.signOut()
    setHousehold(null)
    setMember(null)
  }

  return (
    <AuthContext.Provider value={{ user, household, member, loading, signIn, signInWithGoogle, signUp, joinHousehold, updateHousehold, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
