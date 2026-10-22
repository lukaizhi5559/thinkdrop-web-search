# # ThinkDrop Web Search Service

A production-ready web search microservice with MCP (Model Context Protocol) support for ThinkDrop AI.

## Features

- 🔍 **Multi-Provider Search**: NewsAPI (primary) + DuckDuckGo (fallback)
- ⚡ **Intelligent Caching**: Time-sensitive queries cached for 10min, general queries for 24h
- 🔄 **Automatic Fallback**: Seamless provider switching on failure
- 🛡️ **Rate Limiting**: Client-side throttling to respect API quotas
- 📊 **Metrics & Monitoring**: Built-in health checks and performance tracking
- 🐳 **Docker Ready**: Full containerization support

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- No API keys required! DuckDuckGo is free and open

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/thinkdrop-web-search-service.git
cd thinkdrop-web-search-service

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env and add your NEWSAPI_KEY

# Initialize database
npm run db:init

# Start development server
npm run dev
```

Server will start at `http://localhost:3002`

## Environment Variables

See `.env.example` for all available configuration options.

**Required:**
- `API_KEY` - Secret key for API authentication (e.g., `test-key-123`)

**Optional (Brave Search):**
- `BRAVE_API_AI_KEY` - Your Brave AI Search API key (get one at https://brave.com/search/api/)
- `BRAVE_AI_URL` - Brave AI API URL (default: https://api.search.brave.com/res/v1/chat/completions)
- `BRAVE_API_WEB_KEY` - Your Brave Web Search API key (same as AI key)
- `BRAVE_WEB_URL` - Brave Web API URL (default: https://api.search.brave.com/res/v1/web/search)

**Optional (Other):**
- `PORT` - Server port (default: 3002)
- `CACHE_ENABLED` - Enable/disable caching (default: true)
- `RATE_LIMIT_ENABLED` - Enable/disable rate limiting (default: true)
- `NEWSAPI_KEY` - Optional NewsAPI key if you want news-specific features

## Provider Notes

- **Licensed APIs vs. page scraping**: the Brave and Bing API providers are
  the properly licensed path — configure the keys above and they take
  precedence. The free fallback chain (Google SERP → Bing SERP → DuckDuckGo)
  scrapes public result pages on demand; it is best-effort, unofficial, and
  may break when engines change their markup or rate-limit automated traffic.
- **Dedicated browser profile**: SERP scraping runs in a separate anonymous
  profile (`~/.thinkdrop/search-browser`) — it never touches your signed-in
  browser session or its cookies.
- **Graceful degradation**: when an engine serves a consent wall or blocks
  automated traffic, the chain automatically falls through to the next
  provider, then to the LLM-fallback response — a search never hard-fails on
  one engine's anti-bot posture.

## API Endpoints

### Health Check
```bash
GET /service.health
```

### Capabilities
```bash
GET /service.capabilities
```

### Web Search
```bash
POST /web.search
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{
  "version": "mcp.v1",
  "service": "web-search",
  "action": "web.search",
  "requestId": "uuid-123",
  "payload": {
    "query": "latest AI developments",
    "provider": "auto",
    "maxResults": 10
  }
```

Example with Brave AI (default - gets AI answer with sources):
```json
{
  "version": "mcp.v1",
  "service": "web-search",
  "action": "web.search",
  "requestId": "unique-id",
  "payload": {
    "query": "who is the current president of usa",
    "maxResults": 10,
    "provider": "auto"
  }
}
```

Example with specific provider:
```json
{
  "version": "mcp.v1",
  "service": "web-search",
  "action": "web.search",
  "requestId": "unique-id",
  "payload": {
    "query": "artificial intelligence",
    "maxResults": 10,
    "provider": "brave-ai"
  }
}
```

**Smart Fallback Strategy (Auto Mode - Default):**
1. **DuckDuckGo** (free, unlimited) - Tries first
2. **Brave AI** (2000 free/month) - Only if DuckDuckGo returns empty
3. **Brave Web** (requires API key) - Final fallback

**Available Providers (Manual Selection):**
- `auto` - Smart fallback (default, recommended)
- `duckduckgo` - DuckDuckGo search only
- `brave-ai` - AI-powered search with grounded answers
- `brave-web` - Traditional web search from Brave
- `newsapi` - News-specific search (requires API key)

### News Search
```bash
POST /web.news
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{
  "version": "mcp.v1",
  "service": "web-search",
  "action": "web.news",
  "requestId": "uuid-456",
  "payload": {
    "query": "artificial intelligence",
    "category": "technology",
    "maxResults": 5
  }
}
```

## Docker Deployment

```bash
# Build image
docker build -t thinkdrop-web-search-service .

# Run with docker-compose
docker-compose up -d

# Check logs
docker-compose logs -f
```

## Testing

```bash
# Run all tests
npm test

# Run integration tests
npm run test:integration

# Run load tests
npm run test:load
```

## Architecture

```
src/
├── database/          # DuckDB database setup
├── providers/         # NewsAPI & DuckDuckGo integrations
├── services/          # Core business logic (search, cache, metrics)
├── middleware/        # Auth, rate limiting
├── routes/            # MCP endpoints
└── index.js           # Express server
```

## Performance

- **p50 latency**: <200ms (cached), <500ms (uncached)
- **p95 latency**: <1000ms
- **Cache hit rate**: >60%
- **Throughput**: >50 req/s

## License

MIT License - See LICENSE file

## Support

- Issues: https://github.com/your-org/thinkdrop-web-search-service/issues
- Documentation: See AGENT_SPEC_WebSearch.md
