// Local development server: serves public/ and routes /api/* to the same function Vercel runs.
// Uses DATABASE_URL if set, otherwise a local PGlite database in ./.pglite.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from './api/index.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Apply the same security headers vercel.json sets in production.
const vercelConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
const securityHeaders = vercelConfig.headers.flatMap((rule) => rule.headers);

async function handleApi(req, res, url) {
  const handler = api[req.method];
  if (!handler) {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed.' }));
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
  }
  headers.set('x-forwarded-for', req.socket.remoteAddress);

  const response = await handler(new Request(url, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
  }));

  const outHeaders = {};
  response.headers.forEach((value, key) => { if (key !== 'set-cookie') outHeaders[key] = value; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outHeaders['set-cookie'] = cookies;
  res.writeHead(response.status, outHeaders);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(res, pathname) {
  let file;
  try {
    file = path.resolve(PUBLIC_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''));
  } catch {
    file = null;
  }
  if (!file || !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

http.createServer(async (req, res) => {
  for (const { key, value } of securityHeaders) res.setHeader(key, value);
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
}).listen(PORT, () => {
  const db = process.env.DATABASE_URL || process.env.POSTGRES_URL ? 'DATABASE_URL' : 'local PGlite (.pglite/)';
  console.log(`Property Tracker dev server: http://localhost:${PORT}  (database: ${db})`);
});
