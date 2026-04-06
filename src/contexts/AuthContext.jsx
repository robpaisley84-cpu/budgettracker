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
      console.log('getSession result:', session ? 'has session' : 'no session')
      setUser(session?.user ?? null)
      if (session?.user) loadHousehold(session.user.id)
      else setLoading(false)
    }).catch(e => {
      console.error('getSession failed:', e)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('auth state change:', event, session ? 'has session' : 'no session')
      setUser(session?.user ?? null)
      if (session?.user) await loadHousehold(session.user.id)
      else { setHousehold(null); setMember(null); setLoading(false) }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadHousehold(userId) {
    console.log('loadHousehold called with userId:', userId)
    try {
      // Test: can we query anything at all?
      console.log('Testing basic query...')
      const testRes = await supabase.from('households').select('id').limit(1)
      console.log('Basic test result:', JSON.stringify(testRes))

      // Step 1: get member row
      console.log('Querying household_members...')
      const { data: mem, error: memErr } = await supabase
        .from('household_members')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      console.log('member query result:', JSON.stringify({ mem, memErr }))

      if (memErr || !mem) {
        console.log('No member found, stopping')
        setLoading(false)
        return
      }

      // Step 2: get household
      const { data: hh, error: hhErr } = await supabase
        .from('households')
        .select('*')
        .eq('id', mem.household_id)
        .maybeSingle()

      console.log('household query result:', JSON.stringify({ hh, hhErr }))

      if (hh) {
        setMember(mem)
        setHousehold(hh)
      }
    } catch (e) { console.error('loadHousehold exception:', e) }
    setLoading(false)
  }

  async function signIn(email, password) {
    return supabase.auth.signInWithPassword({ email, password })
  }

  async function signUp(email, password, displayName) {
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error || !data.user) return { error }

    // Create household + member for first user
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
      // Seed the budget data
      await supabase.rpc('seed_budget', { hh_id: hh.id })
    }

    return { data }
  }

  async function joinHousehold(inviteCode, displayName) {
    // Simple join by household ID (share the UUID with Hayley)
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

  async function signOut() {
    await supabase.auth.signOut()
    setHousehold(null)
    setMember(null)
  }

  return (
    <AuthContext.Provider value={{ user, household, member, loading, signIn, signUp, joinHousehold, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
