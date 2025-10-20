import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.API_KEY;

export function authenticateRequest(req, res, next) {
  // Skip auth for health and capabilities endpoints
  if (req.path === '/service.health' || req.path === '/service.capabilities') {
    return next();
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({
      version: 'mcp.v1',
      service: 'web-search',
      status: 'error',
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing authorization header'
      }
    });
  }

  const token = authHeader.replace('Bearer ', '');
  
  if (token !== API_KEY) {
    return res.status(401).json({
      version: 'mcp.v1',
      service: 'web-search',
      status: 'error',
      error: {
        code: 'INVALID_API_KEY',
        message: 'Invalid API key'
      }
    });
  }

  next();
}
