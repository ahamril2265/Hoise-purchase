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

async function readJson(request, maxChars = MAX_BODY_CHARS) {
  // Requiring JSON also blocks cross-site form posts (CSRF), alongside the SameSite cookie.
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected a JSON request.');
  }
  const text = await request.text();
  if (text.length > maxChars) throw new HttpError(413, 'Request is too large.');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

// ---------- Validation helpers ----------

const isBlank = (value) => value === '' || value === null || value === undefined;

/** Trimmed, de-duplicated (case-insensitive) list of non-empty strings. */
function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, maxLength);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ---------- Properties ----------

function parseProperty(body) {
  const str = (value, max) => (typeof value === 'string' ? value.trim() : '').slice(0, max);

  const property = {
    name: str(body.name, 120),
    location: str(body.location, 200),
    type: str(body.type, 40),
    price: isBlank(body.price) ? NaN : Number(body.price),
    agent_number: str(body.agent_number, 40),
    features: stringList(body.features, 30, 60),
    score_override: isBlank(body.score_override) ? null : Number(body.score_override),
    description: str(body.description, 2000),
    latitude: isBlank(body.latitude) ? null : Number(body.latitude),
    longitude: isBlank(body.longitude) ? null : Number(body.longitude),
  };

  const errors = [];
  if (!property.name) errors.push('Property name is required.');
  if (!property.location) errors.push('Location is required.');
  if (!PROPERTY_TYPES.includes(property.type)) errors.push('Choose a property type.');
  if (!Number.isFinite(property.price) || property.price < 0) errors.push('Price must be a number of 0 or more.');
  if (property.score_override !== null
      && (!Number.isInteger(property.score_override) || property.score_override < 1 || property.score_override > 10)) {
    errors.push('Your own score must be a whole number from 1 to 10.');
  }
  if (property.agent_number && !/^[0-9+()\-.\s]{3,40}$/.test(property.agent_number)) {
    errors.push('Agent number can only contain digits, spaces and + ( ) - .');
  }
  const { latitude: lat, longitude: lng } = property;
  if ((lat === null) !== (lng === null)) {
    errors.push('Coordinates need both a latitude and a longitude.');
  } else if (lat !== null && !(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
    errors.push('Coordinates are out of range.');
  }
  if (errors.length) throw new HttpError(400, errors.join(' '));
  return property;
}

const propertyParams = (p) => [
  p.name, p.location, p.type, p.price, p.agent_number, JSON.stringify(p.features), p.score_override, p.description,
  p.latitude, p.longitude,
];

// Every property comes back with the ids of its photos, cover first.
const PROPERTY_SELECT = `
  SELECT p.*,
         COALESCE((SELECT json_agg(ph.id ORDER BY ph.position, ph.id) FROM photos ph WHERE ph.property_id = p.id),
                  '[]'::json) AS photo_ids
  FROM properties p`;

const getProperty = async (id) => (await query(`${PROPERTY_SELECT} WHERE p.id = $1`, [id]))[0];

// ---------- Photos ----------
// The browser resizes photos to JPEG before upload (a full-size image and a thumbnail), sent as base64.

const MAX_PHOTOS_PER_PROPERTY = 12;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_THUMB_BYTES = 400 * 1024;
const MAX_UPLOAD_CHARS = 4_200_000; // stays under Vercel's 4.5 MB request limit

function jpegBase64(value, maxBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new HttpError(400, 'Photo data is not valid.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) throw new HttpError(413, 'Photo is too large.');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new HttpError(400, 'Photos must be JPEG images.');
  return bytes.toString('base64');
}

// ---------- Preferences (drive the automatic match score, calculated in the browser) ----------

const IMPORTANCE_LEVELS = ['must', 'important', 'nice'];

const DEFAULT_PREFERENCES = {
  types: { items: [], importance: 'important' },
  locations: { items: [], importance: 'important' },
  budget: { min: null, max: null, importance: 'must' },
  features: [],
};

function parsePreferences(body) {
  const importance = (value) => (IMPORTANCE_LEVELS.includes(value) ? value : 'important');
  const money = (value) => {
    if (isBlank(value)) return null;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new HttpError(400, 'Budget amounts must be numbers of 0 or more.');
    return amount;
  };

  const budget = { min: money(body.budget?.min), max: money(body.budget?.max), importance: importance(body.budget?.importance) };
  if (budget.min !== null && budget.max !== null && budget.min > budget.max) {
    throw new HttpError(400, 'Budget minimum is higher than the maximum.');
  }

  const features = [];
  const seen = new Set();
  for (const feature of Array.isArray(body.features) ? body.features : []) {
    const name = typeof feature?.name === 'string' ? feature.name.trim().slice(0, 60) : '';
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    features.push({ name, importance: importance(feature.importance) });
    if (features.length >= 30) break;
  }

  return {
    types: {
      items: stringList(body.types?.items, PROPERTY_TYPES.length, 40).filter((t) => PROPERTY_TYPES.includes(t)),
      importance: importance(body.types?.importance),
    },
    locations: { items: stringList(body.locations?.items, 20, 80), importance: importance(body.locations?.importance) },
    budget,
    features,
  };
}

async function getPreferences() {
  const [row] = await query(`SELECT value FROM settings WHERE key = 'preferences'`);
  return row ? JSON.parse(row.value) : DEFAULT_PREFERENCES;
}

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
    return json(200, await query(`${PROPERTY_SELECT} ORDER BY p.id DESC`));
  }

  if (key === 'POST properties') {
    const p = parseProperty(await readJson(request));
    const [{ id }] = await query(
      `INSERT INTO properties
         (name, location, type, price, agent_number, features, score_override, description, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10) RETURNING id`,
      propertyParams(p),
    );
    return json(201, await getProperty(id));
  }

  if (key === 'GET preferences') {
    return json(200, await getPreferences());
  }

  if (key === 'PUT preferences') {
    const preferences = parsePreferences(await readJson(request));
    await query(
      `INSERT INTO settings (key, value) VALUES ('preferences', $1)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(preferences)],
    );
    return json(200, preferences);
  }

  const match = path.match(/^properties\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);

    if (method === 'PUT') {
      const p = parseProperty(await readJson(request));
      const rows = await query(
        `UPDATE properties
         SET name = $1, location = $2, type = $3, price = $4, agent_number = $5,
             features = $6::jsonb, score_override = $7, description = $8,
             latitude = $9, longitude = $10, updated_at = now()
         WHERE id = $11 RETURNING id`,
        [...propertyParams(p), id],
      );
      if (!rows.length) throw new HttpError(404, 'Property not found.');
      return json(200, await getProperty(id));
    }

    if (method === 'DELETE') {
      const rows = await query(`DELETE FROM properties WHERE id = $1 RETURNING id`, [id]);
      if (!rows.length) throw new HttpError(404, 'Property not found.');
      return json(200, { ok: true });
    }
  }

  const photosMatch = path.match(/^properties\/(\d+)\/photos$/);
  if (photosMatch) {
    const propertyId = Number(photosMatch[1]);
    const [owner] = await query(`SELECT id FROM properties WHERE id = $1`, [propertyId]);
    if (!owner) throw new HttpError(404, 'Property not found.');

    // Upload one photo: { data, thumb } as base64 JPEG.
    if (method === 'POST') {
      const body = await readJson(request, MAX_UPLOAD_CHARS);
      const data = jpegBase64(body.data, MAX_PHOTO_BYTES);
      const thumb = jpegBase64(body.thumb, MAX_THUMB_BYTES);
      const [{ count }] = await query(`SELECT count(*)::int AS count FROM photos WHERE property_id = $1`, [propertyId]);
      if (count >= MAX_PHOTOS_PER_PROPERTY) {
        throw new HttpError(400, `A property can have up to ${MAX_PHOTOS_PER_PROPERTY} photos.`);
      }
      const [photo] = await query(
        `INSERT INTO photos (property_id, data, thumb, position)
         VALUES ($1, decode($2, 'base64'), decode($3, 'base64'),
                 COALESCE((SELECT max(position) + 1 FROM photos WHERE property_id = $1), 0))
         RETURNING id`,
        [propertyId, data, thumb],
      );
      return json(201, photo);
    }

    // Reorder: { order: [photoId, …] }, cover first.
    if (method === 'PUT') {
      const { order } = await readJson(request);
      if (!Array.isArray(order) || !order.every(Number.isInteger)) throw new HttpError(400, 'Invalid photo order.');
      for (const [position, photoId] of order.entries()) {
        await query(`UPDATE photos SET position = $1 WHERE id = $2 AND property_id = $3`, [position, photoId, propertyId]);
      }
      return json(200, { ok: true });
    }
  }

  const photoMatch = path.match(/^photos\/(\d+)(\/thumb)?$/);
  if (photoMatch) {
    const photoId = Number(photoMatch[1]);

    if (method === 'GET') {
      const column = photoMatch[2] ? 'thumb' : 'data';
      const [photo] = await query(`SELECT encode(${column}, 'base64') AS image FROM photos WHERE id = $1`, [photoId]);
      if (!photo) throw new HttpError(404, 'Photo not found.');
      return new Response(Buffer.from(photo.image, 'base64'), {
        headers: {
          'Content-Type': 'image/jpeg',
          // Photo ids never change content, so the browser can keep them; "private" keeps them off shared caches.
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      });
    }

    if (method === 'DELETE') {
      const rows = await query(`DELETE FROM photos WHERE id = $1 RETURNING id`, [photoId]);
      if (!rows.length) throw new HttpError(404, 'Photo not found.');
      return json(200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found.');
}

async function handle(request) {
  try {
    const url = new URL(request.url);
    // The frontend calls /api?route=<path> (e.g. route=properties/3), which needs no rewrites on Vercel.
    const path = (url.searchParams.get('route') ?? '').replace(/^\/+|\/+$/g, '');
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
