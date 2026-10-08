import { searchNewsAPI, searchNews } from '../providers/newsapi.js';
import { searchDuckDuckGo } from '../providers/duckduckgo.js';
import { searchGoogleSerp } from '../providers/googleSerp.js';
import { searchBingSerp } from '../providers/bingSerp.js';
import { 
  searchBraveWeb, 
  searchBraveRich, 
  searchBraveNews, 
  searchBraveVideo, 
  searchBraveImage 
} from '../providers/braveMulti.js';
import { classifyQueryIntent, explainIntent } from './intentClassifier.js';
import { searchBrowser } from './searchBrowserDriver.js';
import { getCachedResult, setCachedResult, deleteCachedResult, normalizeQuery, getCacheTTL } from './cache.js';
import { logSearchHistory } from './metrics.js';

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY) || 1000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A scraped "result set" that is really a login/sign-in wall — happens when
// the hidden browser is mid sign-in flow or a consent redirect hijacks the
// tab. Signature: ≥60% of result URLs are auth endpoints or login-titled
// links on the engine's own domain. Never accept or keep these.
const LOGIN_WALL_URL = /accounts\.google\.|servicelogin|docaction|login\.live\.|login\.microsoftonline|\/oauth|\/signin\b/i;
const LOGIN_WALL_TITLE = /sign[- ]?in|log ?in|inicia sesión|fazer login|anmelden|connexion|accedi|ログイン|登录|登入/i;
function isLoginWallJunk(results) {
  if (!Array.isArray(results) || results.length === 0) return false;
  const junk = results.filter(r => {
    const u = r.url || '';
    return LOGIN_WALL_URL.test(u) || (LOGIN_WALL_TITLE.test(r.title || '') && /\.?(google|bing|microsoft)\.com/i.test(u));
  }).length;
  return junk >= Math.max(2, Math.ceil(results.length * 0.6));
}

// Degraded engines sometimes serve query-agnostic SERPs (Bing bot-tier pages
// return unrelated results — e.g. DID articles for a SpaceX query). Check at
// least ONE of the top-5 titles/snippets echoes a significant query term.
const QUERY_STOPWORDS = new Set(['the','a','an','of','for','and','or','in','on','at','to','is','are','was','were','what','who','whos','when','where','how','why','which','does','did','do','about','with','from','show','tell','give','find','get','best','top','latest','new','this','that']);
function resultsMatchQuery(query, results) {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [])
    .filter(t => !QUERY_STOPWORDS.has(t));
  if (!terms.length || !results?.length) return true; // can't judge → accept
  return results.slice(0, 5).some(r =>
    terms.some(t => `${r.title || ''} ${r.description || ''}`.toLowerCase().includes(t)));
}

// Cached entries scraped before the favicon floor: thumbnails that are all
// logo/favicon URLs or tiny data-URIs (<~1.5KB — real photo thumbs are larger)
// mean the extractor grabbed icons instead of photos.
const looksLikeIcon = (u = '') =>
  /favicon|s2\/favicons|\/logo|logo\./i.test(u) || (u.startsWith('data:image') && u.length < 1500);
function isFaviconJunk(results) {
  const thumbed = (results || []).filter(r => r.thumbnail || r.imageUrl);
  return thumbed.length >= 2 && thumbed.every(r => looksLikeIcon(r.thumbnail || r.imageUrl));
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
    } else if (options.provider === 'google-serp' || options.provider === 'google') {
      return await searchGoogleSerp(query, options);
    } else if (options.provider === 'bing-serp' || options.provider === 'bing') {
      return await searchBingSerp(query, options);
    }
  }

  // Auto mode: free out-of-the-box chain — no API keys required.
  // Google SERP → Bing SERP → DuckDuckGo → LLM fallback.
  let lastError = null;
  let weakResult = null; // sub-2-result response — kept as fallback if all engines stay weak

  // Step 1: Classify query intent (regex only — no LLM call).
  // options.intent is a hint from the stategraph media classifier — honor it
  // when the English regex can't match a non-English query (e.g. "猫的视频").
  const classified = classifyQueryIntent(query);
  const intent = (classified.intent === 'web' && (options.intent === 'image' || options.intent === 'video'))
    ? options.intent
    : classified.intent;

  // Media results carry alt-text titles that never echo query terms — the
  // relevance check would wrongly reject a valid image/video SERP.
  const skipRelevance = intent === 'image' || intent === 'video' || intent === 'music';
  const accept = (r, min = 2) =>
    r?.results?.length >= min && !isLoginWallJunk(r.results) &&
    (skipRelevance || resultsMatchQuery(effectiveQuery, r.results));
  // Non-English queries skip English-keyword enhancement — appending English
  // words would de-localize the SERP.
  const enhancedQuery = (options.lang && options.lang !== 'en') ? query : classified.enhancedQuery;
  const explanation = explainIntent(query, intent);
  console.log(`🎯 Step 1: Detected intent: ${intent} - ${explanation}${options.intent && intent === options.intent ? ' (caller hint)' : ''}`);
  console.log(`📝 Query: "${query}" → Enhanced: "${enhancedQuery}"${options.lang ? ` [lang=${options.lang}]` : ''}`);

  // Update query for cache key to use enhanced version (consistent with search)
  const effectiveQuery = enhancedQuery;

  // Step 2: Google SERP via hidden Chrome (AI Overview + organic + verticals)
  try {
    console.log('� Step 2: Google SERP via Playwright Chrome...');
    const googleResult = await searchGoogleSerp(effectiveQuery, { ...options, intent });
    if (accept(googleResult)) {
      console.log(`✅ Google SERP returned ${googleResult.results.length} results (intent: ${intent})`);
      return googleResult;
    }
    if (googleResult.results?.length > 0 && !isLoginWallJunk(googleResult.results) &&
        resultsMatchQuery(effectiveQuery, googleResult.results)) {
      weakResult = weakResult || googleResult; // 1 result — weak, keep trying
    }
    if (isLoginWallJunk(googleResult.results)) {
      console.warn('⚠️  Google SERP returned a sign-in wall, trying Bing...');
      searchBrowser.markEngineBlocked('google', 10 * 60 * 1000);
    } else if (googleResult.blocked) {
      console.warn(`⚠️  Google SERP blocked (${googleResult.blocked}), trying Bing...`);
    } else if (googleResult.pacedOut) {
      console.warn('⚠️  Google SERP paced out (human-rate guard), trying Bing...');
    } else {
      console.log('⚠️  Google SERP returned empty results, trying Bing...');
    }
  } catch (error) {
    console.warn('⚠️  Google SERP failed:', error.message);
    lastError = error;
  }

  // Step 3: Bing SERP via the same hidden Chrome
  try {
    console.log('🔍 Step 3: Bing SERP via Playwright Chrome...');
    const bingResult = await searchBingSerp(effectiveQuery, { ...options, intent });
    if (accept(bingResult)) {
      console.log(`✅ Bing SERP returned ${bingResult.results.length} results`);
      return bingResult;
    }
    if (bingResult.results?.length > 0 && !isLoginWallJunk(bingResult.results) &&
        resultsMatchQuery(effectiveQuery, bingResult.results)) {
      weakResult = weakResult || bingResult;
    }
    if (bingResult.results?.length > 0 && !resultsMatchQuery(effectiveQuery, bingResult.results)) {
      console.warn('⚠️  Bing SERP results don\'t match query (degraded SERP), trying DuckDuckGo...');
    } else
    if (isLoginWallJunk(bingResult.results)) {
      console.warn('⚠️  Bing SERP returned a sign-in wall, trying DuckDuckGo...');
    } else {
      console.log('⚠️  Bing SERP returned empty/weak results');
    }
  } catch (error) {
    console.warn('⚠️  Bing SERP failed:', error.message);
    lastError = error;
  }

  // Step 4: Try DuckDuckGo (free, unlimited, no browser needed)
  try {
    console.log('🔍 Step 4: Trying DuckDuckGo (free provider)...');
    const duckResult = await searchDuckDuckGo(effectiveQuery, options);

    if (duckResult.results && duckResult.results.length > 0 && !isLoginWallJunk(duckResult.results)) {
      console.log(`✅ DuckDuckGo returned ${duckResult.results.length} results`);
      return duckResult;
    }
    if (duckResult.results?.length > 0 && !isLoginWallJunk(duckResult.results) &&
        resultsMatchQuery(effectiveQuery, duckResult.results)) {
      weakResult = weakResult || duckResult;
    }

    console.log('⚠️  DuckDuckGo returned empty results');
  } catch (error) {
    console.warn('⚠️  DuckDuckGo failed:', error.message);
    lastError = error;
  }

  // Step 5: All providers failed - return LLM fallback response.
  // Return an EMPTY results array with a `fallback` message rather than a
  // URL-less pseudo-result. Downstream consumers (web.agent.searchWeb) filter
  // URL-less results, so a pseudo-result with url:'' would be dropped anyway —
  // but returning it as a real result caused `best= score=0` selections in
  // web.agent before the URL filter was added. The `fallback` field lets the
  // MCP route/answer path surface a graceful "search unavailable" message
  // without polluting the results array.
  // Every engine stayed weak — serve the best weak response rather than nothing.
  if (weakResult) {
    console.log('⚠️  All providers weak — returning best weak result set');
    return weakResult;
  }

  console.log('🤖 All search providers failed, returning LLM fallback response');
  return {
    results: [],
    total: 0,
    provider: 'llm-fallback',
    fallback: {
      title: 'Search providers unavailable',
      description: `I apologize, but I'm unable to search the web right now due to provider limitations. However, I can try to help answer your question: "${effectiveQuery}" based on my training data. Please note that my knowledge may be outdated and I cannot access real-time information.`,
    },
    fallbackReason: lastError?.message || 'All search providers failed or returned empty results'
  };
}

export async function search(query, options = {}, context = {}) {
  const startTime = Date.now();
  
  if (!query || typeof query !== 'string') {
    throw new Error('INVALID_REQUEST: Query is required and must be a string');
  }

  // Normalize query and check cache
  const cacheKey = normalizeQuery(query, options);
  const cached = await getCachedResult(cacheKey);

  const mediaIntent = options.intent === 'image' || options.intent === 'video' ||
    ['image', 'video', 'music'].includes(classifyQueryIntent(query).intent);
  // An image/video-intent entry containing zero media results predates the
  // extraction that produces them — evict and re-scrape.
  const missingMedia = mediaIntent && cached && !(cached.results || []).some(r => r.type === 'image' || r.type === 'image-result' || r.type === 'video');
  if (cached && (missingMedia || isLoginWallJunk(cached.results) || (!mediaIntent && !resultsMatchQuery(query, cached.results)) || isFaviconJunk(cached.results))) {
    // Junk scraped before the guards existed (sign-in wall, or a degraded
    // query-agnostic SERP) — evict and fall through to a live search.
    console.warn(`🗑️  Evicting junk cache entry for "${query}"`);
    await deleteCachedResult(cacheKey);
  } else if (cached) {
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
      aiOverview: cached.aiOverview || null,
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
    total: searchResult.total,
    aiOverview: searchResult.aiOverview || null
  }, ttl);

  // Background enrichment (URL unwrap, oEmbed titles) — providers return an
  // optional _enrich hook; when it completes, overwrite the cache so the
  // next identical query gets the enriched copy. Response is already sent.
  if (typeof searchResult._enrich === 'function') {
    searchResult._enrich().then(async (enriched) => {
      try {
        await setCachedResult(cacheKey, {
          query,
          provider: searchResult.provider,
          results: enriched || searchResult.results,
          total: searchResult.total,
          aiOverview: searchResult.aiOverview || null
        }, ttl);
        console.log('✨ Cache enriched (unwrapped URLs / video titles)');
      } catch (_) {}
    }).catch(() => {});
    delete searchResult._enrich;
  }

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
