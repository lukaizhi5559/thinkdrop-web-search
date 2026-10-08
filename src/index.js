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
import { getCachePath, isCached } from './utils/imageCache.js';
import { searchBrowser } from './services/searchBrowserDriver.js';

// Push browser state transitions to the Electron overlay-control server so
// GhostLayer can show a "Web search starting up…" pill (mirrors voice:state).
const OVERLAY_CONTROL_URL = process.env.OVERLAY_CONTROL_URL || 'http://127.0.0.1:3010';
async function pushBrowserState(state) {
  try {
    await fetch(`${OVERLAY_CONTROL_URL}/websearch/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state })
    });
  } catch (_) { /* overlay-control not up yet — non-fatal */ }
}
searchBrowser.on('state', pushBrowserState);

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

// Serve cached images
app.get('/images/:filename', async (req, res) => {
  const { filename } = req.params;
  
  // Security: only allow alphanumeric, dash, underscore, and dot in filename
  if (!filename.match(/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/)) {
    return res.status(400).send('Invalid filename');
  }
  
  try {
    const exists = await isCached(filename);
    if (!exists) {
      return res.status(404).send('Image not found');
    }

    const filepath = await getCachePath(filename);
    
    // Determine content type from extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.sendFile(filepath);
  } catch (error) {
    console.error('[ImageServer] Error serving image:', error);
    res.status(500).send('Error serving image');
  }
});

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

    // Launch the hidden Chrome search worker (non-blocking — first queries
    // fall back to DDG while it warms up). State transitions push to the
    // overlay-control server for the GhostLayer startup pill.
    searchBrowser.start().then(r => {
      if (!r.ok) console.warn('[SearchBrowser] initial launch:', r.reason);
    });

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
  - POST /web.crawl        (URL crawl — free HTML→text extractor)
  - POST /web.scrape       (alias for /web.crawl)
  - GET  /service.health   (Health check)
  - GET  /service.capabilities (Service info)

Smart Routing Strategy (free, no API keys):
  1. Intent Classification - Detect query type (regex, no LLM)
  2. Google SERP via hidden Playwright Chrome
     (AI Overview + organic links + news/video/image blocks)
  3. Fallback to Bing SERP (same hidden Chrome)
  4. Fallback to DuckDuckGo (free, unlimited)
  5. LLM fallback response if all providers fail
  (Brave APIs remain available via explicit provider= requests)

Providers Status:
  - Search Browser: ${searchBrowser.status()}
  - DuckDuckGo: ✓ Always available (fallback)
  - Brave APIs (explicit only): ${process.env.BRAVE_API_WEB_KEY ? '✓ Configured' : '✗ Not configured'}
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
