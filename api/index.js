import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query } from '../lib/db.js';

const SESSION_DAYS = 30;
const MAX_BODY_CHARS = 10 * 1024;
const MAX_LOGIN_FAILURES = 10;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

const PROPERTY_TYPES = ['House', 'Apartment', 'Condo', 'Townhouse', 'Villa', 'Land', 'Commercial', 'Other'];

const scrypt = promisify(crypto.scrypt);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Passwords ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH || !stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

async function getPasswordHash() {
  const [row] = await query(`SELECT value FROM settings WHERE key = 'password_hash'`);
  return row?.value;
}

// ---------- Sessions ----------

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(`DELETE FROM sessions WHERE expires_at <= now()`);
  await query(
    `INSERT INTO sessions (token_hash, expires_at) VALUES ($1, now() + make_interval(days => $2))`,
    [sha256(token), SESSION_DAYS],
  );
  return token;
}

function getCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function isAuthenticated(request) {
  const token = getCookie(request, 'sid');
  if (!token) return false;
  const rows = await query(`SELECT 1 FROM sessions WHERE token_hash = $1 AND expires_at > now()`, [sha256(token)]);
  return rows.length > 0;
}

function sessionCookie(request, token, maxAgeSeconds) {
  const https = new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${https ? '; Secure' : ''}`;
}

// ---------- Login rate limiting (stored in the database so it works across serverless instances) ----------

function clientIp(request) {
  return request.headers.get('x-real-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || 'unknown';
}

async function isLockedOut(ip) {
  const [row] = await query(`SELECT count FROM login_attempts WHERE ip = $1 AND reset_at > now()`, [ip]);
  return !!row && row.count >= MAX_LOGIN_FAILURES;
}

async function recordLoginFailure(ip) {
  await query(
    `INSERT INTO login_attempts (ip, count, reset_at) VALUES ($1, 1, now() + interval '15 minutes')
     ON CONFLICT (ip) DO UPDATE SET
       count    = CASE WHEN login_attempts.reset_at > now() THEN login_attempts.count + 1 ELSE 1 END,
       reset_at = CASE WHEN login_attempts.reset_at > now() THEN login_attempts.reset_at ELSE excluded.reset_at END`,
    [ip],
  );
}

// ---------- Request helpers ----------

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readJson(request) {
  // Requiring JSON also blocks cross-site form posts (CSRF), alongside the SameSite cookie.
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected a JSON request.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new HttpError(413, 'Request is too large.');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

// ---------- Properties ----------

function parseProperty(body) {
  const str = (value, max) => (typeof value === 'string' ? value.trim() : '').slice(0, max);
  const num = (value) => (value === '' || value === null || value === undefined ? NaN : Number(value));

  const property = {
    name: str(body.name, 120),
    location: str(body.location, 200),
    type: str(body.type, 40),
    price: num(body.price),
    match_score: num(body.match_score),
    agent_number: str(body.agent_number, 40),
  };

  const errors = [];
  if (!property.name) errors.push('Property name is required.');
  if (!property.location) errors.push('Location is required.');
  if (!PROPERTY_TYPES.includes(property.type)) errors.push('Choose a property type.');
  if (!Number.isFinite(property.price) || property.price < 0) errors.push('Price must be a number of 0 or more.');
  if (!Number.isInteger(property.match_score) || property.match_score < 1 || property.match_score > 10) {
    errors.push('Match score must be a whole number from 1 to 10.');
  }
  if (property.agent_number && !/^[0-9+()\-.\s]{3,40}$/.test(property.agent_number)) {
    errors.push('Agent number can only contain digits, spaces and + ( ) - .');
  }
  if (errors.length) throw new HttpError(400, errors.join(' '));
  return property;
}

const propertyParams = (p) => [p.name, p.location, p.type, p.price, p.match_score, p.agent_number];

// ---------- Routes ----------

async function route(request, method, path) {
  const key = `${method} ${path}`;

  if (key === 'GET session') {
    const [authenticated, hash] = await Promise.all([isAuthenticated(request), getPasswordHash()]);
    return json(200, { authenticated, registered: !!hash, propertyTypes: PROPERTY_TYPES });
  }

  // First-time setup: whoever registers first sets the password, then registration closes for good.
  if (key === 'POST register') {
    const { password } = await readJson(request);
    checkNewPassword(password);
    const rows = await query(
      `INSERT INTO settings (key, value) VALUES ('password_hash', $1) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [await hashPassword(password)],
    );
    if (!rows.length) throw new HttpError(409, 'A password has already been set. Please sign in.');
    return json(201, { ok: true }, { 'Set-Cookie': sessionCookie(request, await createSession(), SESSION_DAYS * 86_400) });
  }

  if (key === 'POST login') {
    const ip = clientIp(request);
    if (await isLockedOut(ip)) throw new HttpError(429, 'Too many attempts. Please wait 15 minutes and try again.');
    const { password } = await readJson(request);
    if (!(await verifyPassword(password, await getPasswordHash()))) {
      await recordLoginFailure(ip);
      throw new HttpError(401, 'Incorrect password.');
    }
    await query(`DELETE FROM login_attempts WHERE ip = $1`, [ip]);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, await createSession(), SESSION_DAYS * 86_400) });
  }

  if (key === 'POST logout') {
    const token = getCookie(request, 'sid');
    if (token) await query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, '', 0) });
  }

  // Everything below requires a signed-in session.
  if (!(await isAuthenticated(request))) throw new HttpError(401, 'Please sign in.');

  if (key === 'POST password') {
    const { current, next } = await readJson(request);
    if (!(await verifyPassword(current, await getPasswordHash()))) throw new HttpError(400, 'Current password is incorrect.');
    checkNewPassword(next);
    await query(`UPDATE settings SET value = $1 WHERE key = 'password_hash'`, [await hashPassword(next)]);
    // Keep this device signed in; sign out everywhere else.
    await query(`DELETE FROM sessions WHERE token_hash <> $1`, [sha256(getCookie(request, 'sid'))]);
    return json(200, { ok: true });
  }

  if (key === 'GET properties') {
    return json(200, await query(`SELECT * FROM properties ORDER BY id DESC`));
  }

  if (key === 'POST properties') {
    const p = parseProperty(await readJson(request));
    const [created] = await query(
      `INSERT INTO properties (name, location, type, price, match_score, agent_number)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      propertyParams(p),
    );
    return json(201, created);
  }

  const match = path.match(/^properties\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);

    if (method === 'PUT') {
      const p = parseProperty(await readJson(request));
      const [updated] = await query(
        `UPDATE properties
         SET name = $1, location = $2, type = $3, price = $4, match_score = $5, agent_number = $6, updated_at = now()
         WHERE id = $7 RETURNING *`,
        [...propertyParams(p), id],
      );
      if (!updated) throw new HttpError(404, 'Property not found.');
      return json(200, updated);
    }

    if (method === 'DELETE') {
      const rows = await query(`DELETE FROM properties WHERE id = $1 RETURNING id`, [id]);
      if (!rows.length) throw new HttpError(404, 'Property not found.');
      return json(200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found.');
}

async function handle(request) {
  try {
    const url = new URL(request.url);
    // vercel.json rewrites /api/<path> to /api?__route=<path>; fall back to the pathname otherwise.
    const path = (url.searchParams.get('__route') ?? url.pathname.replace(/^\/api\/?/, '')).replace(/\/+$/, '');
    return await route(request, request.method, path);
  } catch (err) {
    if (err.code === 'DB_NOT_CONFIGURED') return json(503, { error: err.message });
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    return json(status, { error: status === 500 ? 'Something went wrong.' : err.message });
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
