// Apply a migration SQL file to the Supabase Postgres database.
//
// Migrations in this project are the numbered .sql files in the repo root and
// are applied in order. This runner replaces pasting them into the Supabase
// SQL Editor by hand.
//
// SETUP (once) — add your database connection string to .env, which is
// gitignored. Supabase → Project Settings → Database → Connection string →
// choose the "Session pooler" (or "Direct connection") URI, NOT the transaction
// pooler on port 6543, which does not reliably support DDL:
//
//   SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres
//
// RUN IT:
//   node run-migration.mjs 012_derived_balances.sql
//   node run-migration.mjs 012_derived_balances.sql --dry-run
//
// Each file runs inside a single transaction, so a failure part-way through
// rolls the whole thing back and leaves the database untouched.

import { readFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import pg from 'pg'

// Read SUPABASE_DB_URL from the environment or .env (env wins)
function connectionString() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL.trim()
  try {
    const line = readFileSync(resolve(import.meta.dirname, '.env'), 'utf8')
      .split(/\r?\n/)
      .find(l => l.startsWith('SUPABASE_DB_URL='))
    if (line) return line.slice('SUPABASE_DB_URL='.length).trim().replace(/^["']|["']$/g, '')
  } catch { /* no .env — fall through to the error below */ }
  return null
}

const args    = process.argv.slice(2)
const dryRun  = args.includes('--dry-run')
const file    = args.find(a => !a.startsWith('--'))

if (!file) {
  console.error('Usage: node run-migration.mjs <migration.sql> [--dry-run]')
  process.exit(1)
}

const conn = connectionString()
if (!conn) {
  console.error('❌ No SUPABASE_DB_URL found in the environment or .env')
  console.error('   Supabase → Project Settings → Database → Connection string (Session pooler)')
  process.exit(1)
}

let sql
try {
  sql = readFileSync(resolve(import.meta.dirname, file), 'utf8')
} catch {
  console.error(`❌ Could not read ${file}`)
  process.exit(1)
}

const name = basename(file)
console.log(`📄 ${name} — ${sql.split(/\r?\n/).length} lines`)

// Supabase requires TLS. Its pooler presents a cert that does not chain to a
// root in Node's default store, so verification is relaxed for this admin-only
// script; the connection is still encrypted.
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } })

try {
  await client.connect()
  const { rows: [info] } = await client.query('SELECT current_database() db, version() v')
  console.log(`🔗 ${info.db} — ${info.v.split(',')[0]}`)

  await client.query('BEGIN')
  await client.query(sql)

  if (dryRun) {
    await client.query('ROLLBACK')
    console.log(`✅ ${name} ran clean, then rolled back (--dry-run). Nothing was changed.`)
  } else {
    await client.query('COMMIT')
    console.log(`✅ ${name} applied.`)
  }
} catch (err) {
  try { await client.query('ROLLBACK') } catch { /* connection may already be gone */ }
  console.error(`❌ ${name} failed — rolled back, database unchanged.`)
  console.error(`   ${err.message}`)
  if (err.position) console.error(`   at character ${err.position}`)
  if (err.hint) console.error(`   hint: ${err.hint}`)
  process.exitCode = 1
} finally {
  await client.end()
}
