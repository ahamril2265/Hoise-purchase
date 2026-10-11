'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;
const MAX_BODY_BYTES = 10 * 1024;
const MAX_LOGIN_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

const PROPERTY_TYPES = ['House', 'Apartment', 'Condo', 'Townhouse', 'Villa', 'Land', 'Commercial', 'Other'];

// ---------- Database ----------

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS properties (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    location     TEXT    NOT NULL,
    type         TEXT    NOT NULL,
    price        REAL    NOT NULL,
    match_score  INTEGER NOT NULL,
    agent_number TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);

// ---------- Passwords ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// CLI: node server.js set-password <password>
if (process.argv[2] === 'set-password') {
  const password = process.argv[3];
  if (!password || password.length < 8) {
    console.error('Usage: npm run set-password -- "your-password"   (at least 8 characters)');
    process.exit(1);
  }
  setSetting('password_hash', hashPassword(password));
  db.exec('DELETE FROM sessions');
  console.log('Password saved. Any existing sign-ins have been signed out.');
  process.exit(0);
}

if (!getSetting('password_hash')) {
  if (process.env.APP_PASSWORD && process.env.APP_PASSWORD.length >= 8) {
    setSetting('password_hash', hashPassword(process.env.APP_PASSWORD));
    console.log('Password initialised from APP_PASSWORD.');
  } else {
    console.error('No password set yet. Run:  npm run set-password -- "your-password"');
    process.exit(1);
  }
}

// ---------- Sessions ----------

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)')
    .run(sha256(token), Date.now() + SESSION_DAYS * 86_400_000);
  return token;
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function isAuthenticated(req) {
  const token = getCookie(req, 'sid');
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha256(token));
  return !!row && row.expires_at > Date.now();
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

const purgeExpiredSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 3_600_000).unref();

// ---------- Login rate limiting ----------

const loginFailures = new Map();

function isLockedOut(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) {
    loginFailures.delete(ip);
    return false;
  }
  return entry.count >= MAX_LOGIN_FAILURES;
}

function recordLoginFailure(ip) {
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt < Date.now()) {
    loginFailures.set(ip, { count: 1, resetAt: Date.now() + LOCKOUT_MS });
  } else {
    entry.count += 1;
  }
}

// ---------- HTTP helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      return reject(new HttpError(415, 'Expected a JSON request.'));
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Request is too large.'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
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

const getProperty = (id) => db.prepare('SELECT * FROM properties WHERE id = ?').get(id);

// ---------- Routes ----------

async function handleApi(req, res, pathname) {
  const route = `${req.method} ${pathname}`;

  if (route === 'GET /api/session') {
    return sendJson(res, 200, { authenticated: isAuthenticated(req), propertyTypes: PROPERTY_TYPES });
  }

  if (route === 'POST /api/login') {
    const ip = req.socket.remoteAddress;
    if (isLockedOut(ip)) throw new HttpError(429, 'Too many attempts. Please wait 15 minutes and try again.');
    const { password } = await readJson(req);
    if (!verifyPassword(password, getSetting('password_hash'))) {
      recordLoginFailure(ip);
      throw new HttpError(401, 'Incorrect password.');
    }
    loginFailures.delete(ip);
    res.setHeader('Set-Cookie', sessionCookie(req, createSession(), SESSION_DAYS * 86_400));
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/logout') {
    const token = getCookie(req, 'sid');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return sendJson(res, 200, { ok: true });
  }

  // Everything below requires a signed-in session.
  if (!isAuthenticated(req)) throw new HttpError(401, 'Please sign in.');

  if (route === 'POST /api/password') {
    const { current, next } = await readJson(req);
    if (!verifyPassword(current, getSetting('password_hash'))) throw new HttpError(400, 'Current password is incorrect.');
    if (typeof next !== 'string' || next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
    setSetting('password_hash', hashPassword(next));
    // Keep this device signed in; sign out everywhere else.
    db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(sha256(getCookie(req, 'sid')));
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'GET /api/properties') {
    return sendJson(res, 200, db.prepare('SELECT * FROM properties ORDER BY id DESC').all());
  }

  if (route === 'POST /api/properties') {
    const p = parseProperty(await readJson(req));
    const { lastInsertRowid } = db
      .prepare('INSERT INTO properties (name, location, type, price, match_score, agent_number) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.name, p.location, p.type, p.price, p.match_score, p.agent_number);
    return sendJson(res, 201, getProperty(lastInsertRowid));
  }

  const match = pathname.match(/^\/api\/properties\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);

    if (req.method === 'PUT') {
      const p = parseProperty(await readJson(req));
      const { changes } = db
        .prepare(`UPDATE properties
                  SET name = ?, location = ?, type = ?, price = ?, match_score = ?, agent_number = ?, updated_at = datetime('now')
                  WHERE id = ?`)
        .run(p.name, p.location, p.type, p.price, p.match_score, p.agent_number, id);
      if (!changes) throw new HttpError(404, 'Property not found.');
      return sendJson(res, 200, getProperty(id));
    }

    if (req.method === 'DELETE') {
      const { changes } = db.prepare('DELETE FROM properties WHERE id = ?').run(id);
      if (!changes) throw new HttpError(404, 'Property not found.');
      return sendJson(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found.');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, pathname) {
  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    throw new HttpError(400, 'Bad request.');
  }
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found.');

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(res, pathname);
    else throw new HttpError(405, 'Method not allowed.');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong.' : err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Property Tracker running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
