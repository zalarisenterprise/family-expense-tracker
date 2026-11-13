// Emergency password reset, e.g. if the admin forgets their password.
// Usage: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run reset-password -- <username> <new-password>
import bcrypt from 'bcryptjs';
import { ensureSchema, run } from '../src/db.js';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.log('Usage: npm run reset-password -- <username> <new-password (8+ chars)>');
  process.exit(1);
}
await ensureSchema();
const hash = await bcrypt.hash(password, 12);
const r = await run(
  `UPDATE users SET password_hash = ?, token_version = token_version + 1, failed_logins = 0, locked_until = 0, active = 1 WHERE username = ?`,
  [hash, username]
);
console.log(r.rowsAffected ? `Password reset for ${username}.` : `No user called ${username}.`);
