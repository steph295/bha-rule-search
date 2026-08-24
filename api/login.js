// POST { password } -> sets a signed session cookie on success.
// Single shared admin password, checked with a constant-time compare.
'use strict';
const crypto = require('crypto');
const { makeSessionCookie } = require('./_auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) { res.status(500).json({ error: 'ADMIN_PASSWORD is not configured on the server' }); return; }

  const body = req.body || {};
  const given = typeof body.password === 'string' ? body.password : '';

  const a = Buffer.from(given);
  const b = Buffer.from(configured);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) { res.status(401).json({ error: 'incorrect password' }); return; }

  res.setHeader('Set-Cookie', makeSessionCookie());
  res.status(200).json({ ok: true });
};
