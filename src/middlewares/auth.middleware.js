const jwt = require('jsonwebtoken');

/**
 * Verifies a JWT and returns its decoded payload, or null if invalid/expired.
 */
function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * Express middleware — protects REST routes.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : req.cookies?.token;

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.user = payload; // { id, email, name, ... }
  next();
}

module.exports = { requireAuth, verifyToken };
