import NodeCache from 'node-cache';

const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== 'false';
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW) || 86400000; // 24 hours
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_NEWSAPI) || 100;

const rateLimitCache = new NodeCache({ 
  stdTTL: RATE_LIMIT_WINDOW / 1000,
  checkperiod: 600 
});

export function rateLimitMiddleware(req, res, next) {
  if (!RATE_LIMIT_ENABLED) {
    return next();
  }

  // Skip rate limiting for health and capabilities
  if (req.path === '/service.health' || req.path === '/service.capabilities') {
    return next();
  }

  const clientKey = req.ip || req.connection.remoteAddress || 'unknown';
  const requestCount = rateLimitCache.get(clientKey) || 0;

  if (requestCount >= RATE_LIMIT_MAX) {
    return res.status(429).json({
      version: 'mcp.v1',
      service: 'web-search',
      status: 'error',
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded. Maximum ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW / 1000 / 60 / 60} hours.`,
        retryAfter: Math.ceil(rateLimitCache.getTtl(clientKey) / 1000)
      }
    });
  }

  rateLimitCache.set(clientKey, requestCount + 1);
  next();
}
