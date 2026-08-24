// Shared session check for the admin API. Not a route itself — required by
// login.js (which issues the cookie) and save-rule.js (which requires it).
//
// The session is a single HMAC-signed, timestamped token in an HttpOnly
// cookie — deliberately simple: one admin, no user accounts, no database.
// The signing secret is SESSION_SECRET if set, else ADMIN_PASSWORD itself
// (fine here since both are server-only env vars the browser never sees).
'use strict';
const crypto = require('crypto');

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

function secret() {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!s) throw new Error('ADMIN_PASSWORD is not configured on the server');
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function makeSessionCookie() {
  const exp = String(Date.now() + SESSION_MAX_AGE_MS);
  const token = exp + '.' + sign(exp);
  const maxAgeSec = Math.floor(SESSION_MAX_AGE_MS / 1000);
  return `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

function checkSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return false;
  const token = decodeURIComponent(match[1]);
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected;
  try { expected = sign(exp); } catch (e) { return false; }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Date.now() < Number(exp);
}

module.exports = { makeSessionCookie, checkSession };
