// GET -> { loggedIn: bool }. Lets the admin page check its session on load
// without guessing from cookie presence alone (client JS can't read an
// HttpOnly cookie's validity).
'use strict';
const { checkSession } = require('./_auth');

module.exports = async function handler(req, res) {
  res.status(200).json({ loggedIn: checkSession(req) });
};
