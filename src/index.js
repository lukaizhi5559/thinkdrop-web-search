import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase } from './database/init.js';
import { authenticateRequest } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import mcpRoutes from './routes/mcp.js';

// Load environment variables from service directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'];

// Middleware
app.use(helmet());
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true
}));
app.use(express.json());
app.use(rateLimitMiddleware);
app.use(authenticateRequest);

// Routes
app.use('/', mcpRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    version: 'mcp.v1',
    service: 'web-search',
    status: 'error',
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    version: 'mcp.v1',
    service: 'web-search',
    status: 'error',
    error: {
      code: 'NOT_FOUND',
      message: `Endpoint ${req.path} not found`
    }
  });
});

// Initialize and start server
async function start() {
  try {
    console.log('Initializing database...');
    await initializeDatabase();
    console.log('Database initialized successfully');

    app.listen(PORT, HOST, () => {
      console.log(`
╔═══════════════════════════════════════════════════════╗
║   ThinkDrop Web Search Service                        ║
║   Version: 1.0.0                                      ║
║   Port: ${PORT}                                       ║
║   Environment: ${process.env.NODE_ENV || 'development'}                              ║
║   MCP Protocol: v1                                    ║
╚═══════════════════════════════════════════════════════╝

Available endpoints:
  - POST /web.search       (General web search)
  - POST /web.news         (News search)
  - POST /web.scrape       (URL scraping - planned)
  - GET  /service.health   (Health check)
  - GET  /service.capabilities (Service info)

Smart Routing Strategy:
  1. DuckDuckGo (free, unlimited) - Try first
  2. Intent Classification - Detect query type
  3. Route to appropriate Brave API:
     • Rich Search (prices, weather, crypto)
     • News Search (current events)
     • Video Search (movies, tutorials)
     • Image Search (pictures, photos)
     • Web Search (general queries)
  4. Fallback to Brave Web if needed

Providers Status:
  - DuckDuckGo: ✓ Always available
  - Brave APIs: ${process.env.BRAVE_API_WEB_KEY ? '✓ Configured (Web, Rich, News, Video, Image)' : '✗ Not configured (optional)'}
  - NewsAPI: ${process.env.NEWSAPI_KEY ? '✓ Configured' : '✗ Not configured (optional)'}

Server ready at http://${HOST}:${PORT}
      `);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
