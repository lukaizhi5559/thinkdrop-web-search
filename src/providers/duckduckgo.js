import dotenv from 'dotenv';

dotenv.config();

const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 10000;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Use global fetch (undici), NOT axios: axios's TLS/header fingerprint trips
// DuckDuckGo's anomaly filter (202 challenge page); undici gets real SERP HTML.
async function getText(url, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(qs ? `${url}?${qs}` : url, {
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
  });
  return res.text();
}

// DuckDuckGo HTML search (more reliable than API)
export async function searchDuckDuckGo(query, options = {}) {
  const startTime = Date.now();

  try {
    // Use DuckDuckGo HTML search
    // kl steers result-region/language toward the caller's detected language
    // (e.g. 'zh-cn'); wt-wt stays the neutral default.
    const kl = (options.lang && options.lang !== 'en')
      ? (options.lang === 'zh' ? 'cn-zh' : `${options.lang}-${options.lang}`)
      : 'wt-wt';
    const html = await getText('https://html.duckduckgo.com/html/', { q: query, kl });

    const elapsedMs = Date.now() - startTime;
    const results = [];

    // Parse HTML results - try multiple patterns for robustness
    const maxResults = options.maxResults || 10;
    let count = 0;
    
    // Pattern 1: Standard result blocks
    const pattern1 = /<div class="result__body">[\s\S]*?<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    
    // Pattern 2: Alternative structure
    const pattern2 = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    
    // Pattern 3: Simpler fallback
    const pattern3 = /<a[^>]*href="\/\/duckduckgo\.com\/l\/\?uddg=([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    
    // Try pattern 1
    let match;
    while ((match = pattern1.exec(html)) !== null && count < maxResults) {
      const url = match[1];
      const title = match[2].replace(/<[^>]*>/g, '').trim();
      const description = match[3].replace(/<[^>]*>/g, '').trim();

      if (url && title) {
        results.push({
          title: decodeHTMLEntities(title),
          description: decodeHTMLEntities(description),
          url: unwrapDdgUrl(url),
          source: 'DuckDuckGo',
          type: 'web-result',
          relevanceScore: 0.8 - (count * 0.05)
        });
        count++;
      }
    }
    
    // Try pattern 2 if pattern 1 failed
    if (results.length === 0) {
      while ((match = pattern2.exec(html)) !== null && count < maxResults) {
        const url = match[1];
        const title = match[2].replace(/<[^>]*>/g, '').trim();
        const description = match[3].replace(/<[^>]*>/g, '').trim();

        if (url && title) {
          results.push({
            title: decodeHTMLEntities(title),
            description: decodeHTMLEntities(description),
            url: unwrapDdgUrl(url),
            source: 'DuckDuckGo',
            type: 'web-result',
            relevanceScore: 0.8 - (count * 0.05)
          });
          count++;
        }
      }
    }

    // Fallback: Try Lite version if HTML parsing fails
    if (results.length === 0) {
      console.log('HTML parsing returned no results, trying Lite version...');
      return await searchDuckDuckGoLite(query, options);
    }

    return {
      results,
      total: results.length,
      provider: 'duckduckgo',
      elapsedMs
    };
  } catch (error) {
    console.error('DuckDuckGo HTML search failed, trying Lite fallback:', error.message);
    // Fallback to Lite version
    return await searchDuckDuckGoLite(query, options);
  }
}

// DuckDuckGo Lite - simpler, more reliable
async function searchDuckDuckGoLite(query, options = {}) {
  const startTime = Date.now();

  try {
    const html = await getText('https://lite.duckduckgo.com/lite/', { q: query });
    const results = [];
    const maxResults = options.maxResults || 10;

    // Parse Lite version — attribute order and extra classes vary, so capture
    // the full attrs blob first, then pull href out of it.
    const linkPattern = /<a\s+([^>]*class=['"][^'"]*result-link[^'"]*['"][^>]*)>([\s\S]*?)<\/a>[\s\S]*?<td\s+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;

    let match;
    let count = 0;
    while ((match = linkPattern.exec(html)) !== null && count < maxResults) {
      const url = (match[1].match(/href=['"]([^'"]+)['"]/) || [])[1] || '';
      const title = decodeHTMLEntities(match[2].replace(/<[^>]+>/g, '').trim());
      const description = decodeHTMLEntities(match[3].replace(/<[^>]+>/g, '').trim());

      if (url && title) {
        results.push({
          title,
          description,
          url: unwrapDdgUrl(url),
          source: 'DuckDuckGo Lite',
          type: 'web-result',
          relevanceScore: 0.75 - (count * 0.05)
        });
        count++;
      }
    }

    if (results.length > 0) {
      return {
        results,
        total: results.length,
        provider: 'duckduckgo-lite',
        elapsedMs: Date.now() - startTime
      };
    }

    // Final fallback to API
    console.log('Lite version returned no results, trying API fallback...');
    return await searchDuckDuckGoAPI(query, options);
  } catch (error) {
    console.error('DuckDuckGo Lite failed, trying API fallback:', error.message);
    return await searchDuckDuckGoAPI(query, options);
  }
}

// Fallback to instant answer API
async function searchDuckDuckGoAPI(query, options = {}) {
  const startTime = Date.now();

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: 1,
    skip_disambig: 1
  });

  const url = `https://api.duckduckgo.com/?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ThinkdropAI/1.0' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    });
    const data = await res.json();

    const elapsedMs = Date.now() - startTime;
    const results = [];

    // Parse instant answer
    if (data.AbstractText) {
      results.push({
        title: data.Heading || 'Instant Answer',
        description: data.AbstractText,
        url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        source: 'DuckDuckGo',
        type: 'instant-answer',
        relevanceScore: 0.95
      });
    }

    // Parse related topics
    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      data.RelatedTopics.forEach((topic, idx) => {
        if (topic.Text && topic.FirstURL) {
          const titleMatch = topic.Text.split(' - ');
          results.push({
            title: titleMatch[0] || topic.Text,
            description: topic.Text,
            url: topic.FirstURL,
            source: 'DuckDuckGo',
            type: 'related-topic',
            relevanceScore: 0.7 - (idx * 0.05)
          });
        }
      });
    }

    // Limit results
    const maxResults = options.maxResults || 10;
    const limitedResults = results.slice(0, maxResults);

    return {
      results: limitedResults,
      total: limitedResults.length,
      provider: 'duckduckgo',
      elapsedMs
    };
  } catch (error) {
    throw new Error(`DuckDuckGo search failed: ${error.message}`);
  }
}

// DDG wraps outbound links as //duckduckgo.com/l/?uddg=<encoded> — decode the
// real target so cards click through correctly.
function unwrapDdgUrl(url) {
  try {
    let u = url.startsWith('//') ? `https:${url}` : url;
    const l = new URL(u);
    const enc = l.searchParams.get('uddg');
    if (enc) u = decodeURIComponent(enc);
    return u;
  } catch (_) { return url; }
}

// Helper to decode HTML entities
function decodeHTMLEntities(text) {
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
    '&#x27;': "'",
    '&#x2F;': '/',
    '&apos;': "'"
  };
  
  return text.replace(/&[#\w]+;/g, (entity) => entities[entity] || entity);
}
