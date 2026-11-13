// Creates the database tables. Safe to run more than once.
// Usage: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run migrate
import { ensureSchema } from '../src/db.js';

await ensureSchema();
console.log('Database is ready.');
