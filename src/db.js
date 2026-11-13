import { createClient } from '@libsql/client';

// Turso in production: set TURSO_DATABASE_URL (libsql://...) and TURSO_AUTH_TOKEN.
// Locally, with neither set, a file database (local.db) is used.
//
// On Render / Vercel (or NODE_ENV=production) a missing TURSO_DATABASE_URL is treated as an ERROR,
// not as "use a local file": those hosts wipe local files on every restart/deploy, which would
// silently throw away everyone's entries while the app still looks like it works.
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL || !!process.env.RENDER;
const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();

export const dbProblem = IS_PROD && !TURSO_URL && process.env.ALLOW_LOCAL_DB !== '1'
  ? 'TURSO_DATABASE_URL is not set on this server, so entries cannot be saved safely. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your hosting environment variables (Render / Vercel), then redeploy.'
  : null;

const URL_IN_USE = dbProblem ? ':memory:' : (TURSO_URL || 'file:local.db');

export const db = createClient({ url: URL_IN_USE, authToken: TURSO_TOKEN || undefined });

// Safe description of where data is stored (never includes the token).
export function dbInfo() {
  const local = URL_IN_USE.startsWith('file:') || URL_IN_USE === ':memory:';
  let host = '';
  if (!local) { try { host = new URL(URL_IN_USE.replace(/^libsql:/, 'https:').replace(/^wss?:/, 'https:')).hostname; } catch { host = ''; } }
  return { kind: local ? 'local-file' : 'turso', host, hasToken: !!TURSO_TOKEN, production: IS_PROD };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    relationship TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    token_version INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,              -- a user id, or 'household'
    date TEXT NOT NULL,               -- YYYY-MM-DD
    amount REAL NOT NULL,
    type TEXT NOT NULL DEFAULT 'expense',  -- 'expense' | 'income' | 'saving'
    cat TEXT,
    sub TEXT,
    mode TEXT,
    note TEXT,
    tags TEXT NOT NULL DEFAULT '[]',  -- JSON array
    recurring_id TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    by_user TEXT,                     -- household entries: who spent / did it
    debit_from TEXT                   -- household entries: whose salary it comes from (a user id, or 'shared')
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_owner_date ON entries(owner, date)`,
  `CREATE TABLE IF NOT EXISTS recurring (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT 'me',  -- 'me' or 'household'
    type TEXT NOT NULL DEFAULT 'expense',
    amount REAL NOT NULL,
    day INTEGER NOT NULL,
    cat TEXT,
    sub TEXT,
    mode TEXT,
    note TEXT,
    start_ym TEXT NOT NULL,
    last_posted TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    installments INTEGER,             -- tenure in months (null = no end)
    maturity REAL,                    -- optional maturity / chit value
    created_at INTEGER NOT NULL,
    debit_from TEXT                   -- household rules: whose salary it comes from (a user id, or 'shared')
  )`,
  `CREATE TABLE IF NOT EXISTS budgets (
    owner TEXT PRIMARY KEY,           -- a user id, or 'household'
    data TEXT NOT NULL                -- JSON {budgets:{catId:amount}, total}
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

let ready = null;
export function ensureSchema() {
  if (!ready) {
    ready = db.batch(SCHEMA, 'write').then(migrate).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const colsOf = async (table) => (await db.execute(`SELECT name FROM pragma_table_info('${table}')`)).rows.map((r) => r.name);

// Upgrades databases created by earlier versions of the app.
async function migrate() {
  const t = await db.execute(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries'`);
  const sql = String(t.rows[0]?.sql || '');
  if (sql.includes("CHECK (type IN ('expense','income'))")) {
    // SQLite can't drop a CHECK constraint, so rebuild the table to allow the 'saving' type.
    await db.batch([
      `CREATE TABLE entries_new (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL,
        type TEXT NOT NULL DEFAULT 'expense', cat TEXT, sub TEXT, mode TEXT, note TEXT,
        tags TEXT NOT NULL DEFAULT '[]', recurring_id TEXT, created_by TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER)`,
      `INSERT INTO entries_new SELECT id, owner, date, amount, type, cat, sub, mode, note, tags, recurring_id, created_by, created_at, updated_at FROM entries`,
      `DROP TABLE entries`,
      `ALTER TABLE entries_new RENAME TO entries`,
      `CREATE INDEX IF NOT EXISTS idx_entries_owner_date ON entries(owner, date)`,
    ], 'write');
  }
  const cols = await colsOf('recurring');
  if (!cols.includes('installments')) await db.execute(`ALTER TABLE recurring ADD COLUMN installments INTEGER`);
  if (!cols.includes('maturity')) await db.execute(`ALTER TABLE recurring ADD COLUMN maturity REAL`);
  const ucols = await colsOf('users');
  if (!ucols.includes('relationship')) await db.execute(`ALTER TABLE users ADD COLUMN relationship TEXT NOT NULL DEFAULT ''`);

  // Household payer columns. Older household entries have no payer, so they are given to the
  // member who added them (that is who they were effectively recorded by before).
  const ecols = await colsOf('entries');
  if (!ecols.includes('by_user') || !ecols.includes('debit_from')) {
    if (!ecols.includes('by_user')) await db.execute(`ALTER TABLE entries ADD COLUMN by_user TEXT`);
    if (!ecols.includes('debit_from')) await db.execute(`ALTER TABLE entries ADD COLUMN debit_from TEXT`);
    await db.execute(`UPDATE entries
      SET by_user = CASE WHEN created_by IN (SELECT id FROM users) THEN created_by ELSE NULL END,
          debit_from = CASE WHEN created_by IN (SELECT id FROM users) THEN created_by ELSE 'shared' END
      WHERE owner = 'household'`);
  }
  const rcols = await colsOf('recurring');
  if (!rcols.includes('debit_from')) {
    await db.execute(`ALTER TABLE recurring ADD COLUMN debit_from TEXT`);
    await db.execute(`UPDATE recurring
      SET debit_from = CASE WHEN user_id IN (SELECT id FROM users) THEN user_id ELSE 'shared' END
      WHERE target = 'household'`);
  }
}

export async function one(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows[0] || null;
}
export async function all(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows;
}
export async function run(sql, args = []) {
  return db.execute({ sql, args });
}
