import { searchNewsAPI, searchNews } from '../providers/newsapi.js';
import { searchDuckDuckGo } from '../providers/duckduckgo.js';
import { searchGoogleSerp } from '../providers/googleSerp.js';
import { searchBingSerp } from '../providers/bingSerp.js';
import { searchBingCopilot } from '../providers/bingCopilot.js';
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

// Cached entries extracted before the breadcrumb-desc fix: descriptions that
// are the SERP cite row ("Yelp https://www.yelp.com › …") instead of snippet
// prose. Signature = raw https:// inside a description — real snippets never
// contain URLs. Require half the described results to match so organic junk
// doesn't hide behind legit meta descs ("Reddit · r/Chipotle 40+ comments").
function isBreadcrumbJunk(results) {
  const descs = (results || []).filter(r => r.description);
  const junk = descs.filter(r => /https?:\/\//.test(r.description)).length;
  return junk >= 2 && junk >= Math.ceil(descs.length * 0.5);
}

async function searchWithFallback(query, options = {}) {
  // If specific provider requested, use it directly
  if (options.provider && options.provider !== 'auto') {
    if (typeof options.onEvent === 'function') {
      try { options.onEvent({ type: 'engine', engine: options.provider }); } catch (_) {}
    }
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
    } else if (options.provider === 'bing-copilot' || options.provider === 'copilot') {
      return await searchBingCopilot(query, options);
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
  const accept = (r, min = 2) => {
    if (!r) return false;
    const n = r.results?.length || 0;
    // An AI Overview IS the answer — accept it even when organic extraction
    // came back thin/empty. Observed: overview-only SERPs failed the min-2
    // gate and fell through to Bing "calculator" spam, discarding the
    // overview entirely.
    if (r.aiOverview) {
      // The overview is the answer — organic thinness/irrelevance doesn't
      // matter (observed: n=9 + overview rejected on title relevance while
      // the overview itself held the exact stat asked for).
      return !isLoginWallJunk(r.results);
    }
    return n >= min && !isLoginWallJunk(r.results) &&
      (skipRelevance || resultsMatchQuery(effectiveQuery, r.results));
  };
  // Non-English queries skip English-keyword enhancement — appending English
  // words would de-localize the SERP.
  const enhancedQuery = (options.lang && options.lang !== 'en') ? query : classified.enhancedQuery;
  const explanation = explainIntent(query, intent);
  console.log(`🎯 Step 1: Detected intent: ${intent} - ${explanation}${options.intent && intent === options.intent ? ' (caller hint)' : ''}`);
  console.log(`📝 Query: "${query}" → Enhanced: "${enhancedQuery}"${options.lang ? ` [lang=${options.lang}]` : ''}`);

  // Update query for cache key to use enhanced version (consistent with search)
  const effectiveQuery = enhancedQuery;

  // Intent-ordered provider chain. Google primary everywhere (~2-3s, now
  // hardened with consent/gbv=1/thin recovery); Bing Copilot is the rich
  // fallback for web/news — its generated answer covers the thin AI-Mode
  // pages Google occasionally serves, at the cost of ~10-15s generation.
  // Media intents skip Copilot entirely (no image/video results there).
  const isMedia = intent === 'image' || intent === 'video' || intent === 'music';
  const CHAIN = isMedia
    ? [['google-serp', 'Google SERP', searchGoogleSerp],
       ['bing-serp', 'Bing SERP', searchBingSerp]]
    : [['google-serp', 'Google SERP', searchGoogleSerp],
       ['bing-copilot', 'Bing Copilot', searchBingCopilot],
       ['bing-serp', 'Bing SERP', searchBingSerp]];
  CHAIN.push(['duckduckgo', 'DuckDuckGo', searchDuckDuckGo]);
  const primaryKey = CHAIN[0][0];

  let step = 1;
  for (const [key, label, fn] of CHAIN) {
    step++;
    try {
      // Progress event — consumers show "Searching <engine>" chip updates as
      // the chain falls through (SSE stream:true only; no-op otherwise).
      if (typeof options.onEvent === 'function') {
        try { options.onEvent({ type: 'engine', engine: key }); } catch (_) {}
      }
      console.log(`🔍 Step ${step}: ${label} via ${key === 'duckduckgo' ? 'API (free provider)' : 'Playwright Chrome'}...`);
      const r = await fn(effectiveQuery, { ...options, intent, onChunk: options.onAnswerChunk, onPartial: options.onPartial });
      if (accept(r)) {
        r._chainRole = key === primaryKey ? 'primary' : 'fallback';
        console.log(`✅ ${label} returned ${r.results.length} results${r.aiOverview ? ' + answer' : ''}`);
        return r;
      }
      if (r?.results?.length > 0 && !isLoginWallJunk(r.results) &&
          resultsMatchQuery(effectiveQuery, r.results)) {
        weakResult = weakResult || r;
      }
      if (isLoginWallJunk(r?.results)) {
        console.warn(`⚠️  ${label} returned a sign-in wall, trying next...`);
        if (key === 'google-serp') searchBrowser.markEngineBlocked('google', 10 * 60 * 1000);
      } else if (r?.blocked) {
        console.warn(`⚠️  ${label} blocked (${r.blocked}), trying next...`);
      } else if (r?.pacedOut) {
        console.warn(`⚠️  ${label} paced out (human-rate guard), trying next...`);
      } else {
        console.log(`⚠️  ${label} unusable (n=${r?.results?.length || 0}, overview=${!!r?.aiOverview}), trying next...`);
      }
    } catch (error) {
      console.warn(`⚠️  ${label} failed:`, error.message);
      lastError = error;
    }
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
    // Entire free chain (Google → Bing Copilot → Bing → DDG) is down — surface
    // actionable guidance rather than a silent empty result set. Callers that
    // render chat answers should show userMessage verbatim.
    searchUnavailable: true,
    userMessage: "I couldn't reach any free web search providers right now. To search the web, connect a Web Search API (e.g. Brave Search API) in Settings.",
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
  // Overviews scraped before the social-block floor shipped — stacked
  // "N comments/reactions/time-ago" markers mean a discussions carousel was
  // mis-scored as the AI Overview. Evict and re-scrape.
  const junkOverview = cached?.aiOverview
    && ((cached.aiOverview.match(/\b[\d.,]+k?\+?\s*(?:comments?|reactions?|likes|views|reposts)\b|\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi) || []).length >= 3);
  if (cached && (missingMedia || junkOverview || isLoginWallJunk(cached.results) || (!mediaIntent && !resultsMatchQuery(query, cached.results)) || isFaviconJunk(cached.results) || isBreadcrumbJunk(cached.results))) {
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

  // In-flight dedupe: an express-lane timeout can trigger a stategraph retry
  // of the SAME query — joining one execution beats launching a second
  // (queue-serialized) navigation on the shared worker page and saves a
  // human-rate pacing slot. Late callers await the same promise.
  const pending = _pendingSearches.get(cacheKey);
  if (pending) {
    console.log(`🔗 Joining in-flight search for "${query}"`);
    return pending;
  }
  const execution = _executeAndCache(query, options, context, cacheKey, startTime);
  _pendingSearches.set(cacheKey, execution);
  try {
    return await execution;
  } finally {
    _pendingSearches.delete(cacheKey);
  }
}

const _pendingSearches = new Map(); // cacheKey -> Promise<searchResult>

async function _executeAndCache(query, options, context, cacheKey, startTime) {
  // Execute search with fallback
  const searchResult = await searchWithFallback(query, options);
  const elapsedMs = Date.now() - startTime;

  // Fallback-provider results (bing/duckduckgo served because the google
  // engine failed) get the short TTL — a full 24h cache keeps serving the
  // degraded SERP long after the primary recovers (observed: bing
  // "percentage calculator" spam persisted across retries for the whole
  // failure window).
  const _autoChain = !options.provider || options.provider === 'auto';
  const ttl = (_autoChain && searchResult._chainRole !== 'primary')
    ? Math.min(getCacheTTL(query, options), 10 * 60 * 1000)
    : getCacheTTL(query, options);
  await setCachedResult(cacheKey, {
    query,
    provider: searchResult.provider,
    results: searchResult.results,
    total: searchResult.total,
    aiOverview: searchResult.aiOverview || null
  }, ttl);

  // Background enrichment (URL unwrap, oEmbed titles) — providers return an
  // optional _enrich hook; when it completes, overwrite the cache so the
  // next identical query gets the enriched copy.
  // When the response would ship google.com/goto redirect links to the UI,
  // await the enrich for a bounded window (~1.8s) so the FIRST response
  // carries unwrapped URLs too — stragglers still land via the cache
  // overwrite below. No wrapped links → zero added latency.
  if (typeof searchResult._enrich === 'function') {
    const hasWrapped = (searchResult.results || []).some(r => /google\.com\/goto/.test(r?.url || ''));
    const enrichP = searchResult._enrich();
    if (hasWrapped) {
      const enriched = await Promise.race([
        enrichP,
        new Promise(res => setTimeout(() => res(null), 1800)),
      ]).catch(() => null);
      if (enriched) searchResult.results = enriched;
    }
    enrichP.then(async (enriched) => {
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
