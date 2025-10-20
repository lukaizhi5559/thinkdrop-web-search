import { searchNewsAPI, searchNews } from '../providers/newsapi.js';
import { searchDuckDuckGo } from '../providers/duckduckgo.js';
import { getCachedResult, setCachedResult, normalizeQuery, getCacheTTL } from './cache.js';
import { logSearchHistory } from './metrics.js';

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY) || 1000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchWithFallback(query, options = {}) {
  // DuckDuckGo is now primary, NewsAPI as optional fallback
  const providers = options.provider === 'auto' || !options.provider
    ? ['duckduckgo'] 
    : [options.provider];
  
  let lastError = null;
  
  for (const provider of providers) {
    let retries = 0;
    
    while (retries < MAX_RETRIES) {
      try {
        if (provider === 'duckduckgo') {
          return await searchDuckDuckGo(query, options);
        } else if (provider === 'newsapi') {
          return await searchNewsAPI(query, options);
        }
      } catch (error) {
        lastError = error;
        
        // Don't retry on auth errors
        if (error.message.includes('INVALID_API_KEY')) {
          break;
        }
        
        // Retry on rate limit or network errors
        if (retries < MAX_RETRIES - 1) {
          const delay = RETRY_DELAY * Math.pow(2, retries);
          console.warn(`Provider ${provider} failed (attempt ${retries + 1}/${MAX_RETRIES}), retrying in ${delay}ms...`);
          await sleep(delay);
          retries++;
        } else {
          console.warn(`Provider ${provider} failed after ${MAX_RETRIES} attempts:`, error.message);
          break;
        }
      }
    }
  }
  
  // All providers failed
  throw new Error(`PROVIDER_ERROR: All providers failed. Last error: ${lastError?.message}`);
}

export async function search(query, options = {}, context = {}) {
  const startTime = Date.now();
  
  if (!query || typeof query !== 'string') {
    throw new Error('INVALID_REQUEST: Query is required and must be a string');
  }

  // Normalize query and check cache
  const cacheKey = normalizeQuery(query, options);
  const cached = await getCachedResult(cacheKey);
  
  if (cached) {
    const elapsedMs = Date.now() - startTime;
    
    // Log cache hit
    await logSearchHistory({
      query,
      provider: cached.provider || 'unknown',
      resultsCount: cached.results?.length || 0,
      cached: true,
      elapsedMs,
      userId: context.userId,
      sessionId: context.sessionId
    });

    return {
      results: cached.results,
      total: cached.total || cached.results?.length || 0,
      query,
      provider: cached.provider || 'cache',
      cached: true,
      elapsedMs
    };
  }

  // Execute search with fallback
  const searchResult = await searchWithFallback(query, options);
  const elapsedMs = Date.now() - startTime;

  // Cache the result
  const ttl = getCacheTTL(query, options);
  await setCachedResult(cacheKey, {
    query,
    provider: searchResult.provider,
    results: searchResult.results,
    total: searchResult.total
  }, ttl);

  // Log search
  await logSearchHistory({
    query,
    provider: searchResult.provider,
    resultsCount: searchResult.results?.length || 0,
    cached: false,
    elapsedMs,
    userId: context.userId,
    sessionId: context.sessionId
  });

  return {
    ...searchResult,
    query,
    cached: false,
    elapsedMs
  };
}

export async function searchNewsOnly(query, options = {}, context = {}) {
  const startTime = Date.now();
  
  if (!query || typeof query !== 'string') {
    throw new Error('INVALID_REQUEST: Query is required and must be a string');
  }

  // Check cache
  const cacheKey = normalizeQuery(query, { ...options, type: 'news' });
  const cached = await getCachedResult(cacheKey);
  
  if (cached) {
    const elapsedMs = Date.now() - startTime;
    return {
      ...cached,
      cached: true,
      elapsedMs
    };
  }

  // Execute news search
  const result = await searchNews(query, options);
  const elapsedMs = Date.now() - startTime;

  // Cache the result
  const ttl = getCacheTTL(query, options);
  await setCachedResult(cacheKey, {
    query,
    provider: 'newsapi',
    results: result.articles,
    total: result.total
  }, ttl);

  // Log search
  await logSearchHistory({
    query,
    provider: 'newsapi',
    resultsCount: result.articles?.length || 0,
    cached: false,
    elapsedMs,
    userId: context.userId,
    sessionId: context.sessionId
  });

  return {
    ...result,
    elapsedMs
  };
}
