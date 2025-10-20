import express from 'express';
import { search, searchNewsOnly } from '../services/search.js';
import { getCacheStats } from '../services/cache.js';
import { getMetrics, incrementRequestCount, incrementSearchCount, incrementErrorCount, recordResponseTime } from '../services/metrics.js';

const router = express.Router();

// Helper to create MCP response
function createMCPResponse(requestId, action, status, data = null, error = null, metrics = {}) {
  return {
    version: 'mcp.v1',
    service: 'web-search',
    action,
    requestId,
    status,
    data,
    error,
    metrics
  };
}

// POST /web.search - General web search
router.post('/web.search', async (req, res) => {
  const startTime = Date.now();
  incrementRequestCount();

  const { requestId, payload, context } = req.body;

  try {
    if (!payload || !payload.query) {
      incrementErrorCount();
      return res.status(400).json(
        createMCPResponse(
          requestId,
          'web.search',
          'error',
          null,
          {
            code: 'INVALID_REQUEST',
            message: 'Missing required field: query'
          }
        )
      );
    }

    incrementSearchCount();

    const result = await search(payload.query, {
      provider: payload.provider || 'auto',
      maxResults: payload.maxResults || 10,
      filters: payload.filters,
      language: payload.language || 'en',
      sortBy: payload.sortBy,
      fromDate: payload.fromDate,
      toDate: payload.toDate
    }, {
      userId: context?.userId,
      sessionId: context?.sessionId
    });

    const elapsedMs = Date.now() - startTime;
    recordResponseTime(elapsedMs);

    res.json(
      createMCPResponse(
        requestId,
        'web.search',
        'ok',
        result,
        null,
        {
          elapsedMs,
          providerMs: result.elapsedMs,
          cacheMs: elapsedMs - result.elapsedMs
        }
      )
    );
  } catch (error) {
    incrementErrorCount();
    const elapsedMs = Date.now() - startTime;
    recordResponseTime(elapsedMs);

    console.error('Search error:', error);

    res.status(500).json(
      createMCPResponse(
        requestId,
        'web.search',
        'error',
        null,
        {
          code: error.message.includes('PROVIDER_ERROR') ? 'PROVIDER_ERROR' : 'INTERNAL_ERROR',
          message: error.message
        },
        { elapsedMs }
      )
    );
  }
});

// POST /web.news - News search
router.post('/web.news', async (req, res) => {
  const startTime = Date.now();
  incrementRequestCount();

  const { requestId, payload, context } = req.body;

  try {
    if (!payload || !payload.query) {
      incrementErrorCount();
      return res.status(400).json(
        createMCPResponse(
          requestId,
          'web.news',
          'error',
          null,
          {
            code: 'INVALID_REQUEST',
            message: 'Missing required field: query'
          }
        )
      );
    }

    incrementSearchCount();

    const result = await searchNewsOnly(payload.query, {
      category: payload.category,
      country: payload.country || 'us',
      maxResults: payload.maxResults || 10,
      sortBy: payload.sortBy || 'publishedAt',
      fromDate: payload.fromDate,
      toDate: payload.toDate
    }, {
      userId: context?.userId,
      sessionId: context?.sessionId
    });

    const elapsedMs = Date.now() - startTime;
    recordResponseTime(elapsedMs);

    res.json(
      createMCPResponse(
        requestId,
        'web.news',
        'ok',
        result,
        null,
        {
          elapsedMs,
          providerMs: result.elapsedMs,
          cacheMs: elapsedMs - result.elapsedMs
        }
      )
    );
  } catch (error) {
    incrementErrorCount();
    const elapsedMs = Date.now() - startTime;
    recordResponseTime(elapsedMs);

    console.error('News search error:', error);

    res.status(500).json(
      createMCPResponse(
        requestId,
        'web.news',
        'error',
        null,
        {
          code: error.message.includes('INVALID_API_KEY') ? 'INVALID_API_KEY' : 'INTERNAL_ERROR',
          message: error.message
        },
        { elapsedMs }
      )
    );
  }
});

// POST /web.scrape - URL scraping (future feature)
router.post('/web.scrape', async (req, res) => {
  const { requestId } = req.body;

  res.status(501).json(
    createMCPResponse(
      requestId,
      'web.scrape',
      'error',
      null,
      {
        code: 'NOT_IMPLEMENTED',
        message: 'URL scraping is not yet implemented. This feature is planned for a future release.'
      }
    )
  );
});

// GET /service.health - Health check
router.get('/service.health', async (req, res) => {
  try {
    const cacheStats = await getCacheStats();
    const metrics = getMetrics();

    // Check provider availability
    const providers = {
      duckduckgo: 'available',
      newsapi: process.env.NEWSAPI_KEY ? 'available' : 'unavailable'
    };

    res.json({
      service: 'web-search',
      version: '1.0.0',
      status: 'up',
      uptime: metrics.uptime,
      providers,
      cache: cacheStats,
      metrics
    });
  } catch (error) {
    res.status(500).json({
      service: 'web-search',
      version: '1.0.0',
      status: 'degraded',
      error: error.message
    });
  }
});

// GET /service.capabilities - Service capabilities
router.get('/service.capabilities', (req, res) => {
  res.json({
    service: 'web-search',
    version: '1.0.0',
    capabilities: {
      actions: [
        {
          name: 'web.search',
          description: 'Perform web search with automatic provider selection',
          inputSchema: {
            query: 'string (required)',
            provider: 'string (optional, default: auto)',
            maxResults: 'number (optional, default: 10)',
            filters: 'object (optional)',
            language: 'string (optional, default: en)',
            sortBy: 'string (optional)',
            fromDate: 'string (optional)',
            toDate: 'string (optional)'
          },
          outputSchema: {
            results: 'array',
            total: 'number',
            query: 'string',
            provider: 'string',
            cached: 'boolean',
            elapsedMs: 'number'
          }
        },
        {
          name: 'web.news',
          description: 'Search news articles specifically',
          inputSchema: {
            query: 'string (required)',
            category: 'string (optional)',
            country: 'string (optional, default: us)',
            maxResults: 'number (optional, default: 10)',
            sortBy: 'string (optional, default: publishedAt)',
            fromDate: 'string (optional)',
            toDate: 'string (optional)'
          },
          outputSchema: {
            articles: 'array',
            total: 'number',
            query: 'string',
            cached: 'boolean',
            elapsedMs: 'number'
          }
        },
        {
          name: 'web.scrape',
          description: 'Scrape content from URL (future)',
          status: 'planned'
        }
      ],
      providers: [
        {
          name: 'duckduckgo',
          status: 'active',
          features: ['general-search', 'instant-answers', 'related-topics'],
          primary: true
        },
        {
          name: 'newsapi',
          status: process.env.NEWSAPI_KEY ? 'active' : 'inactive',
          features: ['news', 'articles', 'sources'],
          primary: false
        }
      ],
      features: [
        'multi-provider',
        'intelligent-caching',
        'fallback-mechanism',
        'rate-limiting',
        'result-enrichment'
      ]
    }
  });
});

export default router;
