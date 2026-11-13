import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, one, all } from './db.js';
import { DEFAULT_CONFIG, upgradeConfig, cleanConfig } from './defaults.js';

// Loads a backup file (from Settings → Download full backup) into this database.
//
// It only ADDS what is missing and never overwrites or deletes anything, so it is safe to run twice
// and safe to run on a database that already has some data:
//  - members are matched by username (ignoring capitals); anyone not found is created with a temporary
//    password (passwords are never stored in a backup) and must choose their own at first login
//  - entries, commitments and budgets keep their original ids, so an item already present is skipped
//  - every id inside the file (owner, spent by, debit from, added by) is re-pointed at the matching member

const HH = 'household';
const SHARED = 'shared';
const TYPES = ['expense', 'income', 'saving'];
const LIMITS = { users: 60, entries: 60000, recurring: 2000 };
const CHUNK = 150;

const newId = () => crypto.randomBytes(9).toString('base64url');
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isYm = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const goodId = (s) => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(s);
const num = (v) => (typeof v === 'number' ? v : Number(v));
const posAmount = (n) => typeof n === 'number' && isFinite(n) && n > 0 && n < 1e11;
const timeOr = (v, fallback) => { const n = num(v); return n > 1e11 && n < 4e12 ? Math.round(n) : fallback; };

function tempPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', digits = '23456789';
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(letters).toUpperCase(), ...Array.from({ length: 5 }, () => pick(letters)), pick(digits), pick(digits), pick(digits), pick(digits)];
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

// Adds categories / modes the file uses that this database does not have yet.
function mergeConfig(base, extra) {
  const out = { ...base, categories: base.categories.map((c) => ({ ...c })) };
  const ids = new Set(out.categories.map((c) => c.id));
  for (const c of extra.categories) if (!ids.has(c.id)) { out.categories.push({ ...c }); ids.add(c.id); }
  const union = (a, b) => { const seen = new Set(a.map((x) => x.toLowerCase())); const r = [...a]; for (const x of b) if (!seen.has(x.toLowerCase())) { r.push(x); seen.add(x.toLowerCase()); } return r; };
  out.incomeCategories = union(base.incomeCategories, extra.incomeCategories);
  out.savingCategories = union(base.savingCategories, extra.savingCategories);
  out.modes = union(base.modes, extra.modes);
  return out;
}

export async function restoreBackup(b, admin) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || b.app !== 'family-expense-tracker') {
    return { error: 'This is not a backup file from the Family Expense Tracker. Use the file you got from Settings → Download full backup.' };
  }
  if (!Array.isArray(b.users) || !Array.isArray(b.entries)) return { error: 'This backup file is incomplete: it has no members or entries list.' };
  const rules = Array.isArray(b.recurring) ? b.recurring : [];
  if (b.users.length > LIMITS.users || b.entries.length > LIMITS.entries || rules.length > LIMITS.recurring) return { error: 'This backup file is larger than this app can restore in one go.' };

  const sum = { usersAdded: 0, usersMatched: 0, usersSkipped: 0, entriesAdded: 0, entriesAlreadyThere: 0, entriesSkipped: 0, rulesAdded: 0, rulesAlreadyThere: 0, rulesSkipped: 0, budgetsAdded: 0, settings: 'unchanged' };
  const newUsers = [];

  // ---------- members ----------
  const existing = await all(`SELECT id, username FROM users`);
  const byName = new Map(existing.map((u) => [String(u.username).toLowerCase(), u.id]));
  const takenIds = new Set(existing.map((u) => u.id));
  const map = new Map();                       // id in the file -> id in this database
  const userStmts = [];
  for (const u of b.users) {
    const username = str(u && u.username, 32), fileId = u && typeof u.id === 'string' ? u.id : '';
    if (!fileId || !/^[a-zA-Z0-9._-]{3,32}$/.test(username) || !str(u.name, 60)) { sum.usersSkipped++; continue; }
    const hit = byName.get(username.toLowerCase());
    if (hit) { map.set(fileId, hit); sum.usersMatched++; continue; }
    const id = goodId(fileId) && !takenIds.has(fileId) ? fileId : newId();
    const password = tempPassword();
    const role = ['admin', 'member', 'viewer'].includes(u.role) ? u.role : 'member';
    userStmts.push({
      sql: `INSERT INTO users (id, username, name, relationship, password_hash, role, active, must_change_password, created_at) VALUES (?,?,?,?,?,?,?,1,?)`,
      args: [id, username, str(u.name, 60), str(u.relationship, 40), await bcrypt.hash(password, 10), role, u.active === false ? 0 : 1, timeOr(u.createdAt, Date.now())],
    });
    byName.set(username.toLowerCase(), id); takenIds.add(id); map.set(fileId, id);
    newUsers.push({ name: str(u.name, 60), username, role, password });
    sum.usersAdded++;
  }
  if (userStmts.length) await db.batch(userStmts, 'write');

  const person = (v) => (typeof v === 'string' ? map.get(v) || null : null);

  // ---------- entries, commitments, budgets ----------
  const work = [];                              // { kind, stmt }
  for (const e of b.entries) {
    if (!e || typeof e !== 'object') { sum.entriesSkipped++; continue; }
    const hh = e.owner === HH;
    const owner = hh ? HH : person(e.owner);
    const amount = num(e.amount);
    if (!goodId(e.id) || !owner || !isDate(e.date) || !posAmount(amount)) { sum.entriesSkipped++; continue; }
    const addedBy = person(e.by) || admin.id;
    const tags = Array.isArray(e.tags) ? e.tags.map((t) => str(String(t), 40).replace(/^#/, '')).filter(Boolean).slice(0, 20) : [];
    let spentBy = null, debitFrom = null;
    if (hh) {
      // Files from before the payer feature have no payer: it was the member who added the entry.
      spentBy = e.spentBy ? person(e.spentBy) : person(e.by);
      debitFrom = e.debitFrom === SHARED ? SHARED : (e.debitFrom ? (person(e.debitFrom) || SHARED) : (person(e.by) || SHARED));
    }
    work.push({ kind: 'entry', stmt: {
      sql: `INSERT OR IGNORE INTO entries (id, owner, date, amount, type, cat, sub, mode, note, tags, recurring_id, created_by, created_at, updated_at, by_user, debit_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [e.id, owner, e.date, Math.round(amount * 100) / 100, TYPES.includes(e.type) ? e.type : 'expense', str(e.cat, 60), str(e.sub, 60), str(e.mode, 60), str(e.note, 300), JSON.stringify(tags),
        goodId(e.recurring) ? e.recurring : null, addedBy, timeOr(e.created, Date.now()), e.edited ? timeOr(e.edited, null) : null, spentBy, debitFrom],
    } });
  }
  for (const r of rules) {
    if (!r || typeof r !== 'object') { sum.rulesSkipped++; continue; }
    const owner = person(r.owner), amount = num(r.amount), day = parseInt(r.day, 10);
    if (!goodId(r.id) || !owner || !posAmount(amount) || !(day >= 1 && day <= 31) || !isYm(r.startYm)) { sum.rulesSkipped++; continue; }
    const hh = r.target === HH || r.target === 'household';
    const inst = parseInt(r.installments, 10), mat = num(r.maturity);
    work.push({ kind: 'rule', stmt: {
      sql: `INSERT OR IGNORE INTO recurring (id, user_id, target, type, amount, day, cat, sub, mode, note, start_ym, last_posted, paused, installments, maturity, created_at, debit_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [r.id, owner, hh ? 'household' : 'me', TYPES.includes(r.type) ? r.type : 'expense', Math.round(amount * 100) / 100, day, str(r.cat, 60), str(r.sub, 60), str(r.mode, 60), str(r.note, 300), r.startYm,
        isYm(r.lastPosted) ? r.lastPosted : '', r.paused ? 1 : 0, inst >= 1 && inst <= 600 ? inst : null, mat > 0 && mat < 1e11 ? mat : null, Date.now(),
        hh ? (r.debitFrom === SHARED ? SHARED : (person(r.debitFrom) || owner)) : null],
    } });
  }
  const bud = b.budgets && typeof b.budgets === 'object' && !Array.isArray(b.budgets) ? b.budgets : {};
  for (const key of Object.keys(bud).slice(0, 80)) {
    const target = key === HH ? HH : person(key);
    if (!target || !bud[key] || typeof bud[key] !== 'object') continue;
    const cats = {};
    for (const k of Object.keys(bud[key].budgets || {}).slice(0, 80)) { const v = Number(bud[key].budgets[k]); if (v > 0 && v < 1e11) cats[str(k, 40)] = v; }
    const total = Number(bud[key].total) > 0 ? Number(bud[key].total) : 0;
    work.push({ kind: 'budget', stmt: { sql: `INSERT INTO budgets (owner, data) VALUES (?, ?) ON CONFLICT(owner) DO NOTHING`, args: [target, JSON.stringify({ budgets: cats, total })] } });
  }
  // Chunks are saved one after another; if something fails halfway, running the restore again continues safely.
  for (let i = 0; i < work.length; i += CHUNK) {
    const part = work.slice(i, i + CHUNK);
    const res = await db.batch(part.map((w) => w.stmt), 'write');
    part.forEach((w, k) => {
      const added = Number(res[k].rowsAffected) > 0;
      if (w.kind === 'entry') added ? sum.entriesAdded++ : sum.entriesAlreadyThere++;
      else if (w.kind === 'rule') added ? sum.rulesAdded++ : sum.rulesAlreadyThere++;
      else if (added) sum.budgetsAdded++;
    });
  }

  // ---------- settings (categories, payment modes, currency) ----------
  const incoming = cleanConfig(b.config, newId);
  if (incoming) {
    const row = await one(`SELECT value FROM settings WHERE key = 'config'`);
    let current = null;
    try { current = row ? JSON.parse(row.value) : null; } catch { current = null; }
    let next, how;
    const untouched = !current || JSON.stringify(upgradeConfig({ ...DEFAULT_CONFIG, ...current })) === JSON.stringify(DEFAULT_CONFIG);
    if (untouched) { next = upgradeConfig(incoming); how = 'restored'; }
    else {
      const cur = cleanConfig(current, newId);
      next = cur ? upgradeConfig(mergeConfig(cur, incoming)) : upgradeConfig(incoming);
      how = 'merged';
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      await db.execute({ sql: `INSERT INTO settings (key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify(next)] });
      sum.settings = how;
    }
  }

  return { ok: true, summary: sum, newUsers };
}
