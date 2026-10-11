import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     expires_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
     ip       TEXT PRIMARY KEY,
     count    INTEGER NOT NULL,
     reset_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS properties (
     id           SERIAL PRIMARY KEY,
     name         TEXT NOT NULL,
     location     TEXT NOT NULL,
     type         TEXT NOT NULL,
     price        DOUBLE PRECISION NOT NULL,
     match_score  INTEGER NOT NULL,
     agent_number TEXT NOT NULL DEFAULT '',
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

async function connect() {
  let run;
  if (DATABASE_URL) {
    const sql = neon(DATABASE_URL);
    run = (text, params = []) => sql.query(text, params);
  } else if (process.env.VERCEL) {
    const err = new Error('No database connected yet. In Vercel, add a Neon Postgres database to this project, then redeploy.');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  } else {
    // Local development: an in-process Postgres saved to ./.pglite (no database server needed).
    // The module name is kept in a variable so Vercel doesn't bundle this dev-only package.
    const pkg = '@electric-sql/pglite';
    const { PGlite } = await import(pkg);
    const db = new PGlite(process.env.PGLITE_DIR || './.pglite');
    run = async (text, params = []) => (await db.query(text, params)).rows;
  }

  for (const statement of SCHEMA) {
    try {
      await run(statement);
    } catch (err) {
      // Two cold starts creating the same table at once can collide; the table exists either way.
      if (err.code !== '23505' && err.code !== '42P07') throw err;
    }
  }
  return run;
}

let ready;

/** Run a parameterised query ($1, $2, …) and return the result rows. */
export async function query(text, params) {
  ready ??= connect().catch((err) => {
    ready = undefined;
    throw err;
  });
  const run = await ready;
  return run(text, params);
}
