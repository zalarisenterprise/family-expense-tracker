import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { ensureSchema, one, all, run, db } from './db.js';
import { DEFAULT_CONFIG } from './defaults.js';

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL || !!process.env.RENDER;
const JWT_SECRET = process.env.JWT_SECRET || (IS_PROD ? null : 'dev-only-secret-change-me');
const COOKIE = 'fet_session';
const SESSION_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const HH = 'household';
const TYPES = ['expense', 'income', 'saving'];
// Used to keep login timing the same whether or not a username exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// ---------- basic security headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ---------- schema + config checks ----------
app.use('/api', async (req, res, next) => {
  if (!JWT_SECRET) return res.status(500).json({ error: 'Server is missing JWT_SECRET. Add it in your hosting environment variables.' });
  try { await ensureSchema(); next(); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not connect to the database. Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.' }); }
});

// Reject cross-site API writes. Browsers can't add this custom header from another site
// without a CORS preflight (which we never allow). Cookies are also SameSite=Lax.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('X-Requested-With') !== 'fetch') {
    return res.status(403).json({ error: 'Request blocked.' });
  }
  next();
});

// ---------- helpers ----------
const newId = () => crypto.randomBytes(9).toString('base64url');
const now = () => Date.now();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isYm = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const amountOk = (n) => typeof n === 'number' && isFinite(n) && n > 0 && n < 1e11;
const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const pad = (n) => String(n).padStart(2, '0');

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain at least one letter and one number.';
  return null;
}
function usernameProblem(u) {
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(u || '')) return 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.';
  return null;
}

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id, tv: Number(user.token_version) }, JWT_SECRET, { expiresIn: SESSION_DAYS + 'd' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 864e5,
    path: '/',
  });
}

function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, relationship: u.relationship || '', role: u.role, active: !!u.active, mustChangePassword: !!u.must_change_password, createdAt: u.created_at, lastLogin: u.last_login };
}

async function getConfig() {
  const row = await one(`SELECT value FROM settings WHERE key = 'config'`);
  return { ...DEFAULT_CONFIG, ...(row ? parseJSON(row.value, {}) : {}) };
}

// ---------- auth middleware ----------
const auth = wrap(async (req, res, next) => {
  const token = req.cookies[COOKIE];
  if (!token) return bad(res, 'Please log in.', 401);
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch { return bad(res, 'Your session has expired. Please log in again.', 401); }
  const user = await one(`SELECT * FROM users WHERE id = ?`, [payload.uid]);
  if (!user || !user.active || Number(user.token_version) !== payload.tv) {
    res.clearCookie(COOKIE, { path: '/' });
    return bad(res, 'Please log in again.', 401);
  }
  req.user = user;
  next();
});
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : bad(res, 'Only the admin can do this.', 403));
const writerOnly = (req, res, next) => (req.user.role !== 'viewer' ? next() : bad(res, 'You have view-only access.', 403));

// =====================================================================
// AUTH
// =====================================================================
app.get('/api/setup-status', wrap(async (req, res) => {
  const row = await one(`SELECT COUNT(*) AS n FROM users`);
  res.json({ needsSetup: Number(row.n) === 0 });
}));

// First run only: create the admin account.
app.post('/api/setup', wrap(async (req, res) => {
  const { username, name, password } = req.body || {};
  const uname = str(username, 32);
  const problem = usernameProblem(uname) || passwordProblem(password);
  if (problem) return bad(res, problem);
  if (!str(name, 60)) return bad(res, 'Enter your name.');
  const hash = await bcrypt.hash(password, 12);
  const id = newId();
  // Only succeeds while there are no users at all.
  const r = await run(
    `INSERT INTO users (id, username, name, relationship, password_hash, role, created_at, last_login)
     SELECT ?, ?, ?, 'Self', ?, 'admin', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
    [id, uname, str(name, 60), hash, now(), now()]
  );
  if (!r.rowsAffected) return bad(res, 'Setup is already done. Please log in.', 409);
  await run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('config', ?)`, [JSON.stringify(DEFAULT_CONFIG)]);
  const user = await one(`SELECT * FROM users WHERE id = ?`, [id]);
  setSession(res, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const uname = str(req.body?.username, 64);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const generic = 'Wrong username or password.';
  if (!uname || !password) return bad(res, 'Enter your username and password.');
  const user = await one(`SELECT * FROM users WHERE username = ?`, [uname]);
  if (!user) { await bcrypt.compare(password, DUMMY_HASH); return bad(res, generic, 401); }
  if (Number(user.locked_until) > now()) {
    const mins = Math.ceil((Number(user.locked_until) - now()) / 60000);
    return bad(res, `Too many wrong attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`, 429);
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const fails = Number(user.failed_logins) + 1;
    const lock = fails >= MAX_FAILED ? now() + LOCK_MINUTES * 60000 : 0;
    await run(`UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?`, [lock ? 0 : fails, lock, user.id]);
    return bad(res, lock ? `Too many wrong attempts. Account locked for ${LOCK_MINUTES} minutes.` : generic, 401);
  }
  if (!user.active) return bad(res, 'This account has been disabled. Contact the admin.', 403);
  await run(`UPDATE users SET failed_logins = 0, locked_until = 0, last_login = ? WHERE id = ?`, [now(), user.id]);
  setSession(res, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!(await bcrypt.compare(String(currentPassword || ''), req.user.password_hash))) return bad(res, 'Current password is wrong.');
  const problem = passwordProblem(newPassword);
  if (problem) return bad(res, problem);
  const hash = await bcrypt.hash(newPassword, 12);
  // Bump token_version: logs out every other device.
  await run(`UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?`, [hash, req.user.id]);
  const user = await one(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
  setSession(res, user);
  res.json({ ok: true });
}));

app.put('/api/me', auth, wrap(async (req, res) => {
  const name = str(req.body?.name, 60);
  if (!name) return bad(res, 'Enter a name.');
  await run(`UPDATE users SET name = ? WHERE id = ?`, [name, req.user.id]);
  res.json({ ok: true });
}));

// =====================================================================
// USERS (admin)
// =====================================================================
app.get('/api/users', auth, adminOnly, wrap(async (req, res) => {
  const rows = await all(`SELECT * FROM users ORDER BY created_at`);
  res.json({ users: rows.map(publicUser) });
}));

app.post('/api/users', auth, adminOnly, wrap(async (req, res) => {
  const { username, name, password, role, relationship } = req.body || {};
  const uname = str(username, 32);
  const problem = usernameProblem(uname) || passwordProblem(password);
  if (problem) return bad(res, problem);
  if (!str(name, 60)) return bad(res, 'Enter a name.');
  if (!str(relationship, 40)) return bad(res, 'Enter the relationship (for example Wife, Son, Mother).');
  if (!['admin', 'member', 'viewer'].includes(role)) return bad(res, 'Pick a role.');
  if (await one(`SELECT 1 FROM users WHERE username = ?`, [uname])) return bad(res, 'That username is already taken.', 409);
  const id = newId();
  await run(
    `INSERT INTO users (id, username, name, relationship, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [id, uname, str(name, 60), str(relationship, 40), await bcrypt.hash(password, 12), role, now()]
  );
  res.json({ user: publicUser(await one(`SELECT * FROM users WHERE id = ?`, [id])) });
}));

async function adminCount(excludeId) {
  const r = await one(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`, [excludeId]);
  return Number(r.n);
}

app.put('/api/users/:id', auth, adminOnly, wrap(async (req, res) => {
  const target = await one(`SELECT * FROM users WHERE id = ?`, [req.params.id]);
  if (!target) return bad(res, 'User not found.', 404);
  const { name, role, active, password, relationship } = req.body || {};
  const sets = [], args = [];
  if (relationship !== undefined) { sets.push('relationship = ?'); args.push(str(relationship, 40)); }
  if (name !== undefined) { if (!str(name, 60)) return bad(res, 'Enter a name.'); sets.push('name = ?'); args.push(str(name, 60)); }
  if (role !== undefined) {
    if (!['admin', 'member', 'viewer'].includes(role)) return bad(res, 'Pick a role.');
    if (target.role === 'admin' && role !== 'admin' && (await adminCount(target.id)) === 0) return bad(res, 'Keep at least one admin.');
    sets.push('role = ?'); args.push(role);
  }
  if (active !== undefined) {
    if (!active && target.role === 'admin' && (await adminCount(target.id)) === 0) return bad(res, 'Keep at least one active admin.');
    sets.push('active = ?', 'token_version = token_version + 1'); args.push(active ? 1 : 0);
  }
  if (password !== undefined) {
    const problem = passwordProblem(password);
    if (problem) return bad(res, problem);
    sets.push('password_hash = ?', 'must_change_password = ?', 'token_version = token_version + 1', 'failed_logins = 0', 'locked_until = 0');
    args.push(await bcrypt.hash(password, 12), target.id === req.user.id ? 0 : 1);
  }
  if (!sets.length) return res.json({ ok: true });
  args.push(target.id);
  await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args);
  const updated = await one(`SELECT * FROM users WHERE id = ?`, [target.id]);
  if (target.id === req.user.id) setSession(res, updated);
  res.json({ user: publicUser(updated) });
}));

app.delete('/api/users/:id', auth, adminOnly, wrap(async (req, res) => {
  const target = await one(`SELECT * FROM users WHERE id = ?`, [req.params.id]);
  if (!target) return bad(res, 'User not found.', 404);
  if (target.id === req.user.id) return bad(res, "You can't delete your own account.");
  // Their entries are deleted too; household entries they added stay.
  await db.batch([
    { sql: `DELETE FROM entries WHERE owner = ?`, args: [target.id] },
    { sql: `DELETE FROM recurring WHERE user_id = ?`, args: [target.id] },
    { sql: `DELETE FROM budgets WHERE owner = ?`, args: [target.id] },
    { sql: `DELETE FROM users WHERE id = ?`, args: [target.id] },
  ], 'write');
  res.json({ ok: true });
}));

// =====================================================================
// SETTINGS
// =====================================================================
app.put('/api/settings', auth, adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const cats = Array.isArray(b.categories) ? b.categories.slice(0, 60).map((c) => ({
    id: str(c.id, 40) || newId(),
    name: str(c.name, 60) || 'Category',
    color: /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#9a9992',
    subs: Array.isArray(c.subs) ? c.subs.map((s) => str(s, 60)).filter(Boolean).slice(0, 40) : [],
  })) : null;
  if (!cats || !cats.length) return bad(res, 'Keep at least one category.');
  const list = (a) => (Array.isArray(a) ? a.map((s) => str(s, 60)).filter(Boolean).slice(0, 40) : []);
  const cfg = {
    currency: str(b.currency, 5) || '₹',
    monthStartDay: Math.min(28, Math.max(1, parseInt(b.monthStartDay, 10) || 1)),
    categories: cats,
    incomeCategories: list(b.incomeCategories).length ? list(b.incomeCategories) : DEFAULT_CONFIG.incomeCategories,
    savingCategories: list(b.savingCategories).length ? list(b.savingCategories) : DEFAULT_CONFIG.savingCategories,
    modes: list(b.modes).length ? list(b.modes) : DEFAULT_CONFIG.modes,
  };
  await run(`INSERT INTO settings (key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(cfg)]);
  res.json({ config: cfg });
}));

// =====================================================================
// BUDGETS
// =====================================================================
app.put('/api/budgets/:owner', auth, writerOnly, wrap(async (req, res) => {
  const owner = req.params.owner === 'me' ? req.user.id : req.params.owner;
  if (owner === HH && req.user.role !== 'admin') return bad(res, 'Only the admin can set the household budget.', 403);
  if (owner !== HH && owner !== req.user.id && req.user.role !== 'admin') return bad(res, 'Not allowed.', 403);
  const budgets = {};
  const src = req.body?.budgets || {};
  for (const k of Object.keys(src).slice(0, 80)) { const v = Number(src[k]); if (v > 0 && v < 1e11) budgets[str(k, 40)] = v; }
  const total = Number(req.body?.total) > 0 ? Number(req.body.total) : 0;
  await run(`INSERT INTO budgets (owner, data) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET data = excluded.data`, [owner, JSON.stringify({ budgets, total })]);
  res.json({ ok: true });
}));

// =====================================================================
// ENTRIES
// =====================================================================
function rowToEntry(r) {
  return {
    id: r.id, owner: r.owner, date: r.date, amount: Number(r.amount), type: r.type, cat: r.cat, sub: r.sub || '',
    mode: r.mode || '', note: r.note || '', tags: parseJSON(r.tags, []), recurring: r.recurring_id || null,
    by: r.created_by, created: Number(r.created_at), edited: r.updated_at ? Number(r.updated_at) : null,
  };
}
function cleanEntry(b) {
  if (!isDate(b.date)) return { error: 'Pick a valid date.' };
  const amount = Number(b.amount);
  if (!amountOk(amount)) return { error: 'Enter an amount greater than zero.' };
  const type = TYPES.includes(b.type) ? b.type : 'expense';
  const tags = Array.isArray(b.tags) ? b.tags.map((t) => str(String(t), 40).replace(/^#/, '')).filter(Boolean).slice(0, 20) : [];
  return { date: b.date, amount: Math.round(amount * 100) / 100, type, cat: str(b.cat, 60), sub: str(b.sub, 60), mode: str(b.mode, 60), note: str(b.note, 300), tags: JSON.stringify(tags) };
}
function canTouch(user, owner) {
  if (user.role === 'viewer') return false;
  if (user.role === 'admin') return true;
  return owner === user.id || owner === HH;
}

app.post('/api/entries', auth, writerOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const owner = b.owner === HH ? HH : req.user.id;
  const e = cleanEntry(b);
  if (e.error) return bad(res, e.error);
  const id = newId();
  await run(
    `INSERT INTO entries (id, owner, date, amount, type, cat, sub, mode, note, tags, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, owner, e.date, e.amount, e.type, e.cat, e.sub, e.mode, e.note, e.tags, req.user.id, now()]
  );
  res.json({ entry: rowToEntry(await one(`SELECT * FROM entries WHERE id = ?`, [id])) });
}));

app.put('/api/entries/:id', auth, writerOnly, wrap(async (req, res) => {
  const row = await one(`SELECT * FROM entries WHERE id = ?`, [req.params.id]);
  if (!row || !canTouch(req.user, row.owner)) return bad(res, 'Entry not found.', 404);
  const e = cleanEntry(req.body || {});
  if (e.error) return bad(res, e.error);
  await run(
    `UPDATE entries SET date=?, amount=?, type=?, cat=?, sub=?, mode=?, note=?, tags=?, updated_at=? WHERE id=?`,
    [e.date, e.amount, e.type, e.cat, e.sub, e.mode, e.note, e.tags, now(), row.id]
  );
  res.json({ entry: rowToEntry(await one(`SELECT * FROM entries WHERE id = ?`, [row.id])) });
}));

app.delete('/api/entries/:id', auth, writerOnly, wrap(async (req, res) => {
  const row = await one(`SELECT * FROM entries WHERE id = ?`, [req.params.id]);
  if (!row || !canTouch(req.user, row.owner)) return bad(res, 'Entry not found.', 404);
  await run(`DELETE FROM entries WHERE id = ?`, [row.id]);
  res.json({ ok: true });
}));

// =====================================================================
// RECURRING
// =====================================================================
function rowToRule(r) {
  return { id: r.id, owner: r.user_id, target: r.target === 'household' ? HH : 'me', type: r.type, amount: Number(r.amount), day: Number(r.day), cat: r.cat, sub: r.sub || '', mode: r.mode || '', note: r.note || '', startYm: r.start_ym, lastPosted: r.last_posted || '', paused: !!r.paused, installments: r.installments ? Number(r.installments) : null, maturity: r.maturity ? Number(r.maturity) : null };
}
function cleanRule(b) {
  const amount = Number(b.amount), day = parseInt(b.day, 10);
  if (!amountOk(amount)) return { error: 'Enter an amount greater than zero.' };
  if (!(day >= 1 && day <= 31)) return { error: 'Day must be 1–31.' };
  const inst = parseInt(b.installments, 10);
  const installments = inst >= 1 && inst <= 600 ? inst : null;
  const mat = Number(b.maturity);
  const maturity = mat > 0 && mat < 1e11 ? mat : null;
  return { amount, day, installments, maturity, type: TYPES.includes(b.type) ? b.type : 'expense', target: b.target === HH ? 'household' : 'me', cat: str(b.cat, 60), sub: str(b.sub, 60), mode: str(b.mode, 60), note: str(b.note, 300) };
}

app.post('/api/recurring', auth, writerOnly, wrap(async (req, res) => {
  const r = cleanRule(req.body || {});
  if (r.error) return bad(res, r.error);
  const startYm = isYm(req.body.startYm) ? req.body.startYm : new Date().toISOString().slice(0, 7);
  const id = newId();
  await run(
    `INSERT INTO recurring (id, user_id, target, type, amount, day, cat, sub, mode, note, start_ym, installments, maturity, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.user.id, r.target, r.type, r.amount, r.day, r.cat, r.sub, r.mode, r.note, startYm, r.installments, r.maturity, now()]
  );
  await postRecurring();
  res.json({ ok: true });
}));

app.put('/api/recurring/:id', auth, writerOnly, wrap(async (req, res) => {
  const row = await one(`SELECT * FROM recurring WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  if (!row) return bad(res, 'Not found.', 404);
  if (req.body && Object.keys(req.body).length === 1 && 'paused' in req.body) {
    await run(`UPDATE recurring SET paused = ? WHERE id = ?`, [req.body.paused ? 1 : 0, row.id]);
  } else {
    const r = cleanRule(req.body || {});
    if (r.error) return bad(res, r.error);
    await run(`UPDATE recurring SET target=?, type=?, amount=?, day=?, cat=?, sub=?, mode=?, note=?, installments=?, maturity=? WHERE id=?`, [r.target, r.type, r.amount, r.day, r.cat, r.sub, r.mode, r.note, r.installments, r.maturity, row.id]);
  }
  await postRecurring();
  res.json({ ok: true });
}));

app.delete('/api/recurring/:id', auth, writerOnly, wrap(async (req, res) => {
  await run(`DELETE FROM recurring WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// Adds any due monthly entries. Entry ids are fixed per rule+month, so running twice never duplicates.
// Posts due entries for EVERY active member's rules, so the admin always sees up-to-date family figures.
async function postRecurring() {
  const rules = await all(`SELECT r.* FROM recurring r JOIN users u ON u.id = r.user_id WHERE r.paused = 0 AND u.active = 1 AND u.role != 'viewer'`);
  if (!rules.length) return;
  const today = new Date();
  // Use IST for "today" so entries post on the right local day.
  const ist = new Date(today.getTime() + (330 + today.getTimezoneOffset()) * 60000);
  const curYm = ist.getFullYear() + '-' + pad(ist.getMonth() + 1);
  const nextYm = (ym) => { let [y, m] = ym.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return y + '-' + pad(m); };
  const monthIndex = (from, to) => { const [y1, m1] = from.split('-').map(Number); const [y2, m2] = to.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };
  for (const r of rules) {
    let ym = r.last_posted ? nextYm(r.last_posted) : r.start_ym;
    let last = r.last_posted || '';
    const stmts = [];
    for (let guard = 0; ym <= curYm && guard < 24; guard++) {
      const [y, m] = ym.split('-').map(Number);
      const day = Math.min(Number(r.day), new Date(y, m, 0).getDate());
      if (ym === curYm && day > ist.getDate()) break;
      if (r.installments && monthIndex(r.start_ym, ym) >= Number(r.installments)) break; // tenure finished
      stmts.push({
        sql: `INSERT OR IGNORE INTO entries (id, owner, date, amount, type, cat, sub, mode, note, tags, recurring_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,'[]',?,?,?)`,
        args: ['rec_' + r.id + '_' + ym, r.target === 'household' ? HH : r.user_id, ym + '-' + pad(day), r.amount, r.type, r.cat, r.sub, r.mode, r.note, r.id, r.user_id, now()],
      });
      last = ym; ym = nextYm(ym);
    }
    if (stmts.length) {
      stmts.push({ sql: `UPDATE recurring SET last_posted = ? WHERE id = ?`, args: [last, r.id] });
      await db.batch(stmts, 'write');
    }
  }
}

// =====================================================================
// BOOTSTRAP — everything the app needs, filtered by role
// =====================================================================
app.get('/api/bootstrap', auth, wrap(async (req, res) => {
  const u = req.user;
  await postRecurring();
  const config = await getConfig();
  let entries, users, budgetRows;
  if (u.role === 'admin') {
    entries = await all(`SELECT * FROM entries ORDER BY date DESC, created_at DESC`);
    users = await all(`SELECT * FROM users ORDER BY created_at`);
    budgetRows = await all(`SELECT * FROM budgets`);
  } else if (u.role === 'member') {
    entries = await all(`SELECT * FROM entries WHERE owner IN (?, ?) ORDER BY date DESC, created_at DESC`, [u.id, HH]);
    users = await all(`SELECT * FROM users WHERE active = 1 ORDER BY created_at`);
    budgetRows = await all(`SELECT * FROM budgets WHERE owner IN (?, ?)`, [u.id, HH]);
  } else {
    entries = await all(`SELECT * FROM entries WHERE owner = ? ORDER BY date DESC, created_at DESC`, [HH]);
    users = await all(`SELECT * FROM users WHERE active = 1 ORDER BY created_at`);
    budgetRows = await all(`SELECT * FROM budgets WHERE owner = ?`, [HH]);
  }
  const budgets = {};
  budgetRows.forEach((b) => { budgets[b.owner] = parseJSON(b.data, { budgets: {}, total: 0 }); });
  // Admin sees every member's rules; others see their own plus the household's shared rules.
  const recRows = u.role === 'admin'
    ? await all(`SELECT * FROM recurring ORDER BY created_at`)
    : await all(`SELECT * FROM recurring WHERE user_id = ? OR target = 'household' ORDER BY created_at`, [u.id]);
  const recurring = recRows.map(rowToRule);
  res.json({
    me: publicUser(u),
    config,
    // Non-admins only see names (for "who added this" on household entries).
    users: users.map((x) => (u.role === 'admin' ? publicUser(x) : { id: x.id, name: x.name, relationship: x.relationship || '' })),
    entries: entries.map(rowToEntry),
    budgets,
    recurring,
  });
}));

// =====================================================================
// BACKUP (admin) — a full copy of the data you can keep anywhere
// =====================================================================
app.get('/api/backup', auth, adminOnly, wrap(async (req, res) => {
  const users = (await all(`SELECT * FROM users ORDER BY created_at`)).map(publicUser);
  const entries = (await all(`SELECT * FROM entries ORDER BY date, created_at`)).map(rowToEntry);
  const recurring = (await all(`SELECT * FROM recurring ORDER BY created_at`)).map(rowToRule);
  const budgetRows = await all(`SELECT * FROM budgets`);
  const budgets = {};
  budgetRows.forEach((b) => { budgets[b.owner] = parseJSON(b.data, { budgets: {}, total: 0 }); });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="expense-tracker-backup-${stamp}.json"`);
  res.json({ app: 'family-expense-tracker', exportedAt: new Date().toISOString(), config: await getConfig(), users, entries, recurring, budgets });
}));

// ---------- errors ----------
app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

export default app;
