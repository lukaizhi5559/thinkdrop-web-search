import axios from 'axios';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_CONTENT_CHARS  = 20000;

// Minimal HTML → readable text stripper (no external deps)
function htmlToText(html) {
  return html
    // Remove <script> and <style> blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    // Replace block-level tags with newlines
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|header|footer|nav|aside|figure|figcaption)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    // Replace <li> open tags with bullet
    .replace(/<li[^>]*>/gi, '\n• ')
    // Replace heading tags with markdown-style prefix
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(parseInt(n)) + ' ')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    // Collapse excessive whitespace / blank lines
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Extract <title> from raw HTML
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();
}

// Extract meta description
function extractDescription(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  return m ? m[1].trim() : null;
}

/**
 * Crawl a single URL and return clean readable text.
 *
 * @param {string} url   - URL to fetch
 * @param {object} opts
 * @param {number} [opts.maxChars=20000]   - truncate content to this many chars
 * @param {number} [opts.timeoutMs=15000]  - request timeout
 * @returns {{ ok, url, title, description, content, contentLength, elapsedMs, error? }}
 */
export async function crawlUrl(url, opts = {}) {
  const startTime = Date.now();
  const maxChars  = opts.maxChars  || MAX_CONTENT_CHARS;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!url || typeof url !== 'string') {
    return { ok: false, url, error: 'URL is required', elapsedMs: 0 };
  }

  // Normalise: add https:// if missing scheme
  let normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = 'https://' + normalizedUrl;
  }

  try {
    const response = await axios.get(normalizedUrl, {
      timeout: timeoutMs,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ThinkDropBot/1.0; +https://thinkdrop.ai)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      // Treat HTML as text regardless of Content-Type charset
      responseType: 'text',
      // Don't throw on 4xx/5xx — let caller decide
      validateStatus: () => true,
    });

    const statusCode  = response.status;
    const contentType = (response.headers['content-type'] || '').toLowerCase();
    const rawBody     = response.data || '';

    if (statusCode >= 400) {
      return {
        ok: false,
        url: normalizedUrl,
        statusCode,
        error: `HTTP ${statusCode}`,
        elapsedMs: Date.now() - startTime,
      };
    }

    // For non-HTML responses (JSON, PDF, binary), return raw snippet
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return {
        ok: true,
        url: normalizedUrl,
        statusCode,
        title: null,
        description: null,
        content: typeof rawBody === 'string' ? rawBody.slice(0, maxChars) : '[binary content]',
        contentLength: typeof rawBody === 'string' ? rawBody.length : 0,
        contentType,
        elapsedMs: Date.now() - startTime,
      };
    }

    const title       = extractTitle(rawBody);
    const description = extractDescription(rawBody);
    const text        = htmlToText(rawBody);
    const truncated   = text.length > maxChars;
    const content     = text.slice(0, maxChars);

    return {
      ok: true,
      url: normalizedUrl,
      statusCode,
      title,
      description,
      content,
      contentLength: text.length,
      truncated,
      elapsedMs: Date.now() - startTime,
    };

  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    // Axios timeout or network error
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return { ok: false, url: normalizedUrl, error: `Request timed out after ${timeoutMs}ms`, elapsedMs };
    }
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
      return { ok: false, url: normalizedUrl, error: `DNS lookup failed for ${normalizedUrl}`, elapsedMs };
    }
    return { ok: false, url: normalizedUrl, error: err.message, elapsedMs };
  }
}

/**
 * Crawl multiple URLs in parallel (up to concurrency limit).
 *
 * @param {string[]} urls
 * @param {object}   opts
 * @param {number}   [opts.concurrency=3]
 * @returns {{ results: CrawlResult[], elapsedMs: number }}
 */
export async function crawlUrls(urls, opts = {}) {
  const startTime   = Date.now();
  const concurrency = opts.concurrency || 3;
  const results     = [];

  // Simple semaphore-less chunked parallel execution
  for (let i = 0; i < urls.length; i += concurrency) {
    const chunk = urls.slice(i, i + concurrency);
    const batch = await Promise.all(chunk.map(u => crawlUrl(u, opts).catch(e => ({
      ok: false, url: u, error: e.message, elapsedMs: 0,
    }))));
    results.push(...batch);
  }

  return { results, elapsedMs: Date.now() - startTime };
}
