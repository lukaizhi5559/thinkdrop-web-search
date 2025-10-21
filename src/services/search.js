import { searchNewsAPI, searchNews } from '../providers/newsapi.js';
import { searchDuckDuckGo } from '../providers/duckduckgo.js';
import { 
  searchBraveWeb, 
  searchBraveRich, 
  searchBraveNews, 
  searchBraveVideo, 
  searchBraveImage 
} from '../providers/braveMulti.js';
import { classifyQueryIntent, explainIntent } from './intentClassifier.js';
import { getCachedResult, setCachedResult, normalizeQuery, getCacheTTL } from './cache.js';
import { logSearchHistory } from './metrics.js';

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY) || 1000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchWithFallback(query, options = {}) {
  // If specific provider requested, use it directly
  if (options.provider && options.provider !== 'auto') {
    if (options.provider === 'brave-rich') {
      return await searchBraveRich(query, options);
    } else if (options.provider === 'brave-news') {
      return await searchBraveNews(query, options);
    } else if (options.provider === 'brave-video') {
      return await searchBraveVideo(query, options);
    } else if (options.provider === 'brave-image') {
      return await searchBraveImage(query, options);
    } else if (options.provider === 'brave-web') {
      return await searchBraveWeb(query, options);
    } else if (options.provider === 'duckduckgo') {
      return await searchDuckDuckGo(query, options);
    } else if (options.provider === 'newsapi') {
      return await searchNewsAPI(query, options);
    }
  }

  // Auto mode: Smart routing with fallback
  let lastError = null;
  
  // Step 1: Try DuckDuckGo first (free, unlimited)
  try {
    console.log('🔍 Step 1: Trying DuckDuckGo (free provider)...');
    const duckResult = await searchDuckDuckGo(query, options);
    
    // Check if we got results
    if (duckResult.results && duckResult.results.length > 0) {
      console.log(`✅ DuckDuckGo returned ${duckResult.results.length} results`);
      return duckResult;
    }
    
    console.log('⚠️  DuckDuckGo returned empty results, using smart routing...');
  } catch (error) {
    console.warn('⚠️  DuckDuckGo failed:', error.message);
    lastError = error;
  }
  
  // Step 2: Classify query intent and route to appropriate Brave API
  const intent = classifyQueryIntent(query);
  const explanation = explainIntent(query, intent);
  console.log(`🎯 Step 2: Detected intent: ${intent} - ${explanation}`);
  
  // Try the appropriate Brave API based on intent
  try {
    let braveResult;
    
    switch (intent) {
      case 'rich':
        console.log('💰 Trying Brave Rich Search (prices, weather, calculations)...');
        braveResult = await searchBraveRich(query, options);
        break;
      
      case 'news':
        console.log('📰 Trying Brave News Search (current events)...');
        braveResult = await searchBraveNews(query, options);
        break;
      
      case 'video':
        console.log('🎬 Trying Brave Video Search (movies, shows, tutorials)...');
        braveResult = await searchBraveVideo(query, options);
        break;
      
      case 'image':
        console.log('🖼️  Trying Brave Image Search (pictures, photos)...');
        braveResult = await searchBraveImage(query, options);
        break;
      
      case 'web':
      default:
        console.log('🌐 Trying Brave Web Search (general queries)...');
        braveResult = await searchBraveWeb(query, options);
        break;
    }
    
    if (braveResult.results && braveResult.results.length > 0) {
      console.log(`✅ Brave ${intent} search returned ${braveResult.results.length} results`);
      return braveResult;
    }
    
    console.log(`⚠️  Brave ${intent} search returned empty results, trying fallback...`);
  } catch (error) {
    console.warn(`⚠️  Brave ${intent} search failed:`, error.message);
    lastError = error;
  }
  
  // Step 3: Fallback to Brave Web Search if intent-specific search failed
  if (intent !== 'web') {
    try {
      console.log('🌐 Step 3: Fallback to Brave Web Search...');
      const braveWebResult = await searchBraveWeb(query, options);
      
      if (braveWebResult.results && braveWebResult.results.length > 0) {
        console.log(`✅ Brave Web returned ${braveWebResult.results.length} results`);
        return braveWebResult;
      }
    } catch (error) {
      console.warn('⚠️  Brave Web fallback failed:', error.message);
      lastError = error;
    }
  }
  
  // All providers failed or returned empty
  throw new Error(`PROVIDER_ERROR: All providers failed or returned empty results. Last error: ${lastError?.message}`);
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
