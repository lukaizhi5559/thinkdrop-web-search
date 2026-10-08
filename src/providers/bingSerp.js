/**
 * bingSerp.js — Free Bing search via the hidden Playwright Chrome.
 * Fallback for google-serp; mirrors the same provider shape.
 * Extracts: Copilot/answer box, organic results (li.b_algo), entity
 * carousel cards, news cards — plus bing.com/images|videos fallbacks.
 */
import { searchBrowser } from '../services/searchBrowserDriver.js';

// Bing wraps links as /ck/a?...&u=a1<base64url(target)> — decode locally,
// no request needed. Falls back to the wrapped URL if decoding fails.
function unwrapBingUrl(href) {
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith('bing.com') || !u.pathname.startsWith('/ck/')) return href;
    const enc = u.searchParams.get('u');
    if (!enc) return href;
    const b64 = enc.replace(/^a[12]/, '');
    const decoded = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//.test(decoded) ? decoded : href;
  } catch (_) { return href; }
}

function extractSerp() {
  const out = { blocked: false, blockReason: null, answer: null, results: [], rawText: '' };
  const txt = (el) => (el.innerText || el.textContent || '').trim();
  const seen = new Set();

  const url = location.href;
  const bodyText = document.body ? document.body.innerText : '';
  if (url.includes('accounts.google.') || url.includes('ServiceLogin') ||
      /captcha|verify you are human|are you a robot/i.test(bodyText) ||
      document.querySelector('iframe[src*="captcha"]')) {
    out.blocked = true;
    out.blockReason = url.includes('google.') ? 'signin-wall' : 'captcha';
    return out;
  }

  // Copilot generative answer first, then classic answer box.
  const copilot = document.querySelector('#b_sydConvCont, .b_sydText, #b_chat');
  const ans = copilot || document.querySelector('.b_ans, .b_entityTP, [data-tag="AnswerBox"]');
  if (ans) {
    const t = txt(ans);
    if (t.length > 40) out.answer = t.slice(0, 3000);
  }

  // Entity carousel — photo cards (e.g. "Verified oldest people")
  for (const card of document.querySelectorAll('.b_vPanel .b_entityCard, .b_carousel .b_card, li.b_entityTP')) {
    const a = card.querySelector('a[href]');
    if (!a) continue;
    const t = txt(card);
    if (t.length < 4) continue;
    const img = card.querySelector('img');
    const key = a.href + '|' + t.split('\n')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.results.push({
      title: t.split('\n')[0].slice(0, 140),
      url: a.href,
      description: t.split('\n').slice(1).join(' ').slice(0, 200),
      thumbnail: img ? (img.src || undefined) : undefined,
      type: 'entity-card'
    });
  }

  // Organic results: li.b_algo > h2 > a (stable for years)
  for (const li of document.querySelectorAll('li.b_algo')) {
    const h2a = li.querySelector('h2 a');
    if (!h2a || !h2a.href || seen.has(h2a.href)) continue;
    seen.add(h2a.href);
    const cap = li.querySelector('.b_caption p, .b_algoSlug, p');
    const img = li.querySelector('img');
    out.results.push({
      title: txt(h2a),
      url: h2a.href,
      description: (cap ? txt(cap) : '').slice(0, 400),
      thumbnail: img ? (img.src || undefined) : undefined,
      type: 'web-result'
    });
  }

  // News cards
  for (const card of document.querySelectorAll('.news-card, .card-with-cluster, .newscard')) {
    const a = card.querySelector('a[href^="http"]');
    if (!a || seen.has(a.href)) continue;
    const t = txt(a);
    if (t.length < 10) continue;
    seen.add(a.href);
    const img = card.querySelector('img');
    out.results.push({
      title: t.split('\n')[0].slice(0, 140),
      url: a.href,
      description: t.split('\n').slice(1).join(' ').slice(0, 300),
      thumbnail: img ? (img.src || undefined) : undefined,
      type: 'news'
    });
  }

  out.rawText = bodyText.slice(0, 15000);
  return out;
}

/** bing.com/images grid — anchor `m` attr carries JSON with murl (full-res) */
function extractImageGrid() {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a.iusc, a[m]')) {
    let meta = {};
    try { meta = JSON.parse(a.getAttribute('m') || '{}'); } catch (_) {}
    const img = a.querySelector('img');
    const imageUrl = meta.murl;
    const pageUrl = meta.purl || a.href;
    if (!imageUrl && !img) continue;
    if (seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    out.push({
      title: (meta.t || img?.alt || 'Image').slice(0, 140),
      url: pageUrl,
      imageUrl,
      thumbnail: meta.turl || img?.src || undefined,
      description: (a.innerText || '').trim().slice(0, 200),
      type: 'image'
    });
  }
  return out;
}

/** bing.com/videos cards */
function extractVideoList() {
  const out = [];
  const seen = new Set();
  for (const card of document.querySelectorAll('.mc_vtvc, .dg_u, .vrhcontainer')) {
    const a = card.querySelector('a[href]');
    if (!a || seen.has(a.href)) continue;
    let meta = {};
    try { meta = JSON.parse(card.getAttribute('vrhm') || a.getAttribute('m') || '{}'); } catch (_) {}
    const t = (card.innerText || '').trim();
    const title = t.split('\n')[0] || meta.t;
    if (!title || title.length < 4) continue;
    seen.add(a.href);
    const img = card.querySelector('img');
    const dur = (t.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0];
    out.push({
      title: title.slice(0, 140),
      url: meta.murl || meta.ourl || a.href,
      description: t.split('\n').slice(1).join(' ').slice(0, 300),
      thumbnail: img ? (img.src || undefined) : undefined,
      duration: dur,
      type: 'video'
    });
  }
  return out;
}

export async function searchBingSerp(query, options = {}) {
  const startTime = Date.now();
  const maxResults = options.maxResults || 10;
  // setlang steers the SERP language toward the user's detected language so
  // original-language queries return native-language results.
  const lang = (options.lang || 'en').replace(/[^a-zA-Z-]/g, '');
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=${encodeURIComponent(lang)}`;

  if (searchBrowser.paceExceeded('bing')) {
    return { results: [], total: 0, provider: 'bing-serp', pacedOut: true, elapsedMs: 0 };
  }

  if (searchBrowser.engineBlocked('bing')) {
    return { results: [], total: 0, provider: 'bing-serp', blocked: 'cooldown', elapsedMs: 0 };
  }

  let page;
  try {
    page = await searchBrowser.navigate(url, { expectHost: 'bing.com' });
  } catch (err) {
    throw new Error(`bing-serp navigation failed: ${err.message}`);
  }

  const extracted = await page.evaluate(extractSerp);

  if (extracted.blocked) {
    searchBrowser.markEngineBlocked('bing', 5 * 60 * 1000);
    return { results: [], total: 0, provider: 'bing-serp', blocked: extracted.blockReason, elapsedMs: Date.now() - startTime };
  }

  let results = extracted.results;

  // Dedicated-tab fallback for image/video intent.
  const intent = options.intent;
  const tagged = results.filter(r => r.type === 'image' || r.type === 'video');
  if ((intent === 'image' || intent === 'video') && tagged.length < 3 &&
      !searchBrowser.paceExceeded('bing')) {
    try {
      const path = intent === 'image' ? 'images' : 'videos';
      await searchBrowser.navigate(`https://www.bing.com/${path}/search?q=${encodeURIComponent(query)}`, { expectHost: 'bing.com' });
      const extra = await page.evaluate(intent === 'image' ? extractImageGrid : extractVideoList);
      const seen = new Set(results.map(r => r.url));
      for (const r of extra) if (!seen.has(r.url)) { results.push(r); seen.add(r.url); }
      console.log(`[bingSerp] /${path} fallback added ${extra.length} ${intent} results`);
    } catch (err) {
      console.warn('[bingSerp] vertical fallback failed (non-fatal):', err.message);
    }
  }

  results = results.slice(0, maxResults).map((r, i) => ({
    ...r,
    url: unwrapBingUrl(r.url),
    source: 'Bing',
    relevanceScore: 0.85 - (i * 0.04)
  }));
  const elapsedMs = Date.now() - startTime;

  if (results.length === 0 && (extracted.rawText || '').length > 400 && !extracted.answer) {
    results.push({
      title: `Bing results for "${query}"`,
      description: extracted.rawText.slice(0, 2000),
      url,
      source: 'Bing',
      type: 'raw-text',
      relevanceScore: 0.3
    });
  }

  return {
    results,
    total: results.length,
    provider: 'bing-serp',
    aiOverview: extracted.answer || undefined,
    rawText: extracted.rawText || undefined,
    elapsedMs
  };
}
