// One-off admin utility to reset a household member's password.
// Your SERVICE ROLE key is a full-access secret — never commit it or paste it anywhere.
//
// Run it (PowerShell):
//   $env:SUPABASE_SERVICE_ROLE_KEY="<paste service_role key>"; node reset-password.mjs hayley@email.com "NewPassw0rd"
//
// Run it (Git Bash / macOS / Linux):
//   SUPABASE_SERVICE_ROLE_KEY="<paste service_role key>" node reset-password.mjs hayley@email.com 'NewPassw0rd'
//
// Get the key at: Supabase → Project Settings → API → "service_role" (secret).

import { createClient } from '@supabase/supabase-js'

const URL = 'https://ctbquwslqoxppfcswpev.supabase.co'
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const [, , email, newPassword] = process.argv

if (!KEY) { console.error('❌ Set the SUPABASE_SERVICE_ROLE_KEY environment variable first.'); process.exit(1) }
if (!email || !newPassword) { console.error('❌ Usage: node reset-password.mjs <email> <newPassword>'); process.exit(1) }
if (newPassword.length < 6) { console.error('❌ Password must be at least 6 characters.'); process.exit(1) }

const admin = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

// Find the user by email (paginates in case there are many users)
let user = null
for (let page = 1; !user; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
  if (error) { console.error('❌', error.message); process.exit(1) }
  user = data.users.find(u => u.email?.toLowerCase() === email.toLowerCase())
  if (user || data.users.length < 200) break
}
if (!user) { console.error('❌ No user found with email:', email); process.exit(1) }

const { error } = await admin.auth.admin.updateUserById(user.id, { password: newPassword })
if (error) { console.error('❌ Failed:', error.message); process.exit(1) }
console.log('✅ Password updated for', email)
