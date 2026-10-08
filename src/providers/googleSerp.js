/**
 * googleSerp.js — Free Google search via the hidden Playwright Chrome.
 *
 * Navigates google.com/search in the shared warmed tab and copies the
 * rendered content: AI Overview, organic links, and the query-driven inline
 * vertical blocks (Images grid, Videos cards, Top Stories). For image/video
 * intent queries that yield too few tagged results, falls back to one extra
 * paced navigation to the dedicated tab (tbm=isch / tbm=vid).
 */
import axios from 'axios';
import { searchBrowser } from '../services/searchBrowserDriver.js';

const AI_OVERVIEW_WAIT_MS = parseInt(process.env.SERP_AI_WAIT_MS) || 2000;
const GOOGLE_BLOCK_COOLDOWN_MS = parseInt(process.env.GOOGLE_BLOCK_COOLDOWN_MS) || 10 * 60 * 1000;
const UNWRAP_CONCURRENCY = 5;

// Google wraps result links as /goto?url=<opaque token> — resolve the real
// target by following the redirect server-side (one request per link, capped).
async function unwrapGoogleUrls(results) {
  const isWrapped = (u) => { try { const x = new URL(u); return x.hostname.endsWith('google.com') && x.pathname.startsWith('/goto'); } catch (_) { return false; } };
  const pending = results.filter(r => isWrapped(r.url));
  // goto?url= tokens are short-lived — resolve promptly while they're fresh
  // (a stale token 400s; a fresh one follows through to the real target).
  for (let i = 0; i < pending.length; i += UNWRAP_CONCURRENCY) {
    await Promise.all(pending.slice(i, i + UNWRAP_CONCURRENCY).map(async (r) => {
      try {
        const resp = await axios.get(r.url, {
          maxRedirects: 5, timeout: 3000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          validateStatus: () => true
        });
        const finalUrl = resp.request?.res?.responseUrl || resp.request?.responseURL;
        if (finalUrl && !isWrapped(finalUrl)) r.url = finalUrl;
      } catch (_) { /* keep redirect link — still resolves when clicked */ }
    }));
  }
  const resolved = pending.filter(r => !isWrapped(r.url)).length;
  if (pending.length) console.log(`[unwrap] resolved ${resolved}/${pending.length} goto links`);
  return results;
}

// Video results scraped from page JSON arrive title-less ('Video') — fetch
// real titles via YouTube oEmbed (no key needed). Capped: 3 titles, 1.5s each.
async function enrichVideoTitles(results) {
  const needsTitle = results.filter(r => r.type === 'video' && (!r.title || r.title === 'Video')).slice(0, 3);
  await Promise.all(needsTitle.map(async (r) => {
    try {
      const resp = await axios.get(`https://www.youtube.com/oembed?url=${encodeURIComponent(r.url)}&format=json`, { timeout: 1500 });
      if (resp.data?.title) r.title = resp.data.title.slice(0, 140);
    } catch (_) { /* keep generic title */ }
  }));
}

/**
 * In-page extractor for the main SERP. Single evaluate, layered so partial
 * markup breakage degrades to rawText rather than empty results.
 */
function extractSerp(opts = {}) {
  const out = { blocked: false, blockReason: null, aiOverview: null, results: [], rawText: '' };
  const txt = (el) => (el?.innerText || el?.textContent || '').trim();
  const seen = new Set();
  const isGoogleUrl = (u) => { try { return new URL(u).hostname.endsWith('google.com'); } catch (_) { return true; } };
  const BAD_IMG = /logo|favicon|s2\/favicons|gstatic\.com\/.*nav/i;
  // An anchor holding a media card contains BOTH the content thumbnail and a
  // small source favicon — pick the largest img, skipping known icon URLs.
  const biggestImg = (root) => {
    let best = null, bestArea = 0;
    for (const img of root.querySelectorAll('img')) {
      const src = img.src || img.dataset?.src || '';
      if (!src || BAD_IMG.test(src)) continue;
      // favicons/icons are ~16-32px; All-tab image-strip thumbs are ~48px+.
      // offsetWidth covers lazy thumbs not yet loaded (CSS-sized cells);
      // applies to data: URIs too — Google inlines favicons as base64 as well.
      if (Math.max(img.naturalWidth || 0, img.width || 0, img.offsetWidth || 0) < 40) continue;
      const area = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
      if (area > bestArea) { bestArea = area; best = img; }
    }
    return best;
  };

  // A photo thumb that qualifies as content (not favicon/icon): ≥60×40 with
  // a src that isn't a known bad URL. Shared by the strip and fallback passes.
  const isPhotoThumb = (im) => {
    const w = Math.max(im.naturalWidth || 0, im.offsetWidth || 0);
    const h = Math.max(im.naturalHeight || 0, im.offsetHeight || 0);
    const src = im.src || im.dataset?.src || '';
    // <800B data-URIs are 1×1 lazy placeholders/icons, not photo content
    return w >= 60 && h >= 40 && src && !BAD_IMG.test(src) && !seen.has(src)
      && !(src.startsWith('data:image/') && src.length < 800);
  };

  // Emit one image result for a photo thumb: resolve the cell's link —
  // thumbs are often SIBLINGS of the anchor, not inside it — unwrap
  // google-internal hrefs to the real source page + full-res image.
  const emitImageFromThumb = (im) => {
    const cell = im.closest('a[href]');
    let scope = im.parentElement;
    for (let k = 0; k < 5 && scope && !scope.querySelector('a[href]'); k++) scope = scope.parentElement;
    const FOLLOW = 4; // Node.DOCUMENT_POSITION_FOLLOWING
    const a = cell || (scope && ([...scope.querySelectorAll('a[href]')]
      .find(x => im.compareDocumentPosition(x) & FOLLOW) || scope.querySelector('a[href]')));
    let href = a?.href || '', imageUrl;
    if (href && isGoogleUrl(href)) {
      try {
        const u = new URL(href);
        const ref = u.searchParams.get('imgrefurl') || u.searchParams.get('url') || u.searchParams.get('q');
        const img = u.searchParams.get('imgurl') || u.searchParams.get('uddg');
        if (ref && !isGoogleUrl(ref)) href = ref;
        if (img && !isGoogleUrl(img)) imageUrl = img;
      } catch (_) {}
    }
    // h3 inside the link = an organic result (already emitted by section-4).
    // Otherwise dedupe per (href, src) — a single gallery anchor can wrap a
    // strip of different thumbs sharing one href; each is its own card.
    if (!href || a?.querySelector('h3')) return;
    const key = `${href}|${im.src}`;
    if (seen.has(key)) return;
    seen.add(key); seen.add(im.src);
    const t = txt(a) || txt(im.parentElement);
    out.results.push({
      title: (t.split('\n')[0] || 'Image').slice(0, 140),
      url: href,
      imageUrl,
      description: t.split('\n').slice(1).join(' ').slice(0, 300),
      thumbnail: im.src,
      type: 'image'
    });
  };

  // ── 1. Block / interstitial detection ─────────────────────────────────
  const url = location.href;
  const bodyText = document.body ? document.body.innerText : '';
  if (url.includes('consent.google.') || url.includes('/sorry/') ||
      url.includes('accounts.google.') || url.includes('ServiceLogin') ||
      /unusual traffic/i.test(bodyText) ||
      document.querySelector('iframe[src*="recaptcha"], #captcha-form')) {
    out.blocked = true;
    out.blockReason = url.includes('/sorry/') ? 'sorry-page'
      : url.includes('consent.google.') ? 'consent-wall'
      : (url.includes('accounts.google.') || url.includes('ServiceLogin')) ? 'signin-wall'
      : 'captcha';
    return out;
  }

  // ── 2. AI Overview ────────────────────────────────────────────────────
  // Locate the "AI Overview" heading (localized label set covers the languages
  // comms-graph can hand us via original-language queries), climb to the
  // smallest ancestor with substantial text, then strip script/UI junk.
  const AI_OVERVIEW_LABELS = new Set([
    'ai overview', 'ai mode',
    'ai 概览', 'ai概览',                    // zh
    'ai 概要', 'ai概要',                    // ja
    'ai 개요',                             // ko
    'resumen de ia', 'descripción general de ia', // es
    'présentation de l\'ia', 'aperçu ia', 'aperçu de l\'ia', // fr
    'ki-übersicht', 'ki übersicht',         // de
    'visão geral de ia',                    // pt
    'обзор от ии',                          // ru
  ]);
  const cleanAiText = (t) => t
    .replace(/^AI (Overview|Mode)[^\n]*\n?/i, '')
    .split('\n')
    .map(l => l.trim())
    .filter((l, i) => !(i === 0 && AI_OVERVIEW_LABELS.has(l.toLowerCase())))
    .filter(l => l && !/[{;}]|function\s*\(|window\.|try\s*\{|\.rll\(|var |const |=>/.test(l)
             && !/^(show more|show less|all|images|videos|news|more|tools)$/i.test(l))
    .join('\n')
    .slice(0, 3000)
    .trim();
  for (const h of document.querySelectorAll('h1, h2, h3, div[role="heading"], strong')) {
    const hl = txt(h).trim().toLowerCase();
    if (AI_OVERVIEW_LABELS.has(hl)) {
      let node = h.parentElement;
      for (let i = 0; i < 6 && node; i++) {
        const t = cleanAiText(node.innerText || '');
        if (t.length > 80) { out.aiOverview = t; break; }
        node = node.parentElement;
      }
      if (out.aiOverview) break;
    }
  }

  // ── 3. Vertical sections (Images grid / Videos cards / Top stories) ────
  // Google renders these inline on the main SERP when the query signals
  // intent. Find the section heading, climb to a container holding media
  // links, then harvest the cards.
  // Localized section headings — a non-English query (hl=<lang>) renders
  // native labels, so match both English and common localizations.
  const sectionLabels = {
    'images': 'image', 'videos': 'video', 'top stories': 'news',
    'top news': 'news', 'news': 'news',
    '图片': 'image', '视频': 'video', '热门故事': 'news', '新闻': 'news', '资讯': 'news', // zh
    '画像': 'image', '動画': 'video', 'トップニュース': 'news', 'ニュース': 'news',      // ja
    '이미지': 'image', '동영상': 'video', '주요 뉴스': 'news', '뉴스': 'news',            // ko
    'imágenes': 'image', 'vídeos': 'video', 'videos': 'video', 'noticias': 'news',
    'principales noticias': 'news',                                                // es
    'bilder': 'image', 'nachrichten': 'news', 'schlagzeilen': 'news',                // de
    'imagenes': 'image', 'actualités': 'news', 'à la une': 'news',                   // fr
    'imagens': 'image', 'vídeos em destaque': 'video', 'principais notícias': 'news' // pt
  };
  const sectionHeadingSel = 'h1, h2, h3, div[role="heading"], g-link, a[aria-label], span, strong';
  out.debug = out.debug || {};
  for (const h of document.querySelectorAll(sectionHeadingSel)) {
    const label = (txt(h) || h.getAttribute('aria-label') || '').trim().toLowerCase();
    const type = sectionLabels[label];
    if (!type) continue;
    let box = h.parentElement;
    for (let i = 0; i < 6 && box; i++) {
      // All-tab Images strip cells: the photo thumb is NOT inside the link —
      // each cell holds a big <img> plus a sibling <a> (title + 24px favicon).
      // Index the strip by thumbs, resolve the sibling anchor per cell.
      if (type === 'image') {
        const thumbs = [...box.querySelectorAll('img')].filter(isPhotoThumb);
        if (thumbs.length >= 2) {
          for (const im of thumbs) emitImageFromThumb(im);
          break;
        }
      }
      const cards = box.querySelectorAll('a[href]');
      const mediaCards = [...cards].filter(a => a.querySelector('img') || a.href.includes('/url?') || !isGoogleUrl(a.href));
      if (mediaCards.length >= 2) {
        for (const a of mediaCards) {
          if (!a.href || seen.has(a.href)) continue;
          // Image-strip cards link via google.com/imgres — unwrap the real
          // source page (imgrefurl) + full-res (imgurl) so clicks land on the
          // site, not a Google redirect. Only skip if still google-internal.
          let href = a.href, imageUrl;
          if (type === 'image' && isGoogleUrl(href)) {
            try {
              const u = new URL(href);
              const ref = u.searchParams.get('imgrefurl') || u.searchParams.get('url') || u.searchParams.get('q');
              const img = u.searchParams.get('imgurl') || u.searchParams.get('uddg');
              if (ref && !isGoogleUrl(ref)) href = ref;
              if (img && !isGoogleUrl(img)) imageUrl = img;
            } catch (_) {}
          }
          if (isGoogleUrl(href)) continue;
          const t = txt(a);
          if (t.length < 8) continue;
          const img = biggestImg(a);
          const dur = (t.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0];
          seen.add(a.href);
          out.results.push({
            title: t.split('\n')[0].slice(0, 140),
            url: href,
            imageUrl,
            description: t.split('\n').slice(1).join(' ').slice(0, 300),
            thumbnail: img ? (img.src || img.dataset?.src || undefined) : undefined,
            duration: type === 'video' ? dur : undefined,
            type
          });
        }
        break;
      }
      box = box.parentElement;
    }
  }

  // ── 4. Organic links — anchors wrapping an h3 (Google's stable signal) ──
  const VIDEO_HOSTS = /youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d|tiktok\.com\/@|dailymotion\.com\/video/i;
  for (const h3 of document.querySelectorAll('a h3')) {
    const a = h3.closest('a');
    if (!a || !a.href || seen.has(a.href)) continue;
    seen.add(a.href);
    let desc = '';
    let box = a.parentElement;
    for (let i = 0; i < 4 && box; i++) {
      const t = (box.innerText || '').replace(h3.innerText, '').trim();
      if (t.length > 40) { desc = t.split('\n').filter(Boolean).slice(-2).join(' '); break; }
      box = box.parentElement;
    }
    const img = biggestImg(a);
    out.results.push({
      title: h3.innerText.trim(),
      url: a.href,
      description: desc,
      thumbnail: img ? (img.src || undefined) : undefined,
      type: VIDEO_HOSTS.test(a.href) ? 'video' : 'web-result'
    });
  }

  // ── 4b. Unlabeled-image fallback (image intent only) ──────────────────
  // Some SERPs inline photos with NO "Images" section heading — knowledge-
  // panel portraits, unlabeled carousels ("show me pics of the president").
  // The strip pass above needs a heading anchor, so when it came up short
  // scan the whole doc for photo-sized thumbs and resolve their cell links.
  // Dedupe is natural: organic hrefs are already in `seen`, and thumbs in
  // the same cell share its link → one result per source.
  if (opts.intent === 'image' && out.results.filter(r => r.type === 'image').length < 3) {
    for (const im of document.querySelectorAll('img')) {
      if (isPhotoThumb(im)) emitImageFromThumb(im);
    }
  }

  // ── 5. Copy-all safety net ────────────────────────────────────────────
  out.rawText = bodyText.slice(0, 15000);
  // Diagnostics for "image intent but no images" cases — heading labels on
  // the page + every img's size signature so favicon/thumb failures are
  // visible without a live browser.
  out.debug.headings = [...document.querySelectorAll('h1,h2,h3,div[role="heading"],g-link,strong,span')]
    .map(h => (h.textContent || h.getAttribute?.('aria-label') || '').trim().toLowerCase())
    .filter(l => l && l.length < 40).slice(0, 60);
  out.debug.imgs = [...document.querySelectorAll('img')].slice(0, 40).map(i =>
    `${Math.max(i.naturalWidth || 0, i.offsetWidth || 0)}x${Math.max(i.naturalHeight || 0, i.offsetHeight || 0)} ${(i.src || '').slice(0, 50)}${i.closest('a') ? ' <a>' : ''}`);
  return out;
}

/** tbm=isch/udm=2 image grid extractor — each grid cell carries BOTH the
 * photo thumb (lazy: data-URI or gstatic) and the publisher favicon. Keep the
 * largest img per cell and require a real-size floor — otherwise cards get
 * source favicons (Getty 'g', CNN logo) instead of photos. */
function extractImageGrid() {
  const out = [];
  const seen = new Set();
  const BAD_IMG = /logo|favicon|s2\/favicons|gstatic\.com\/.*nav/i;
  const cellOf = (img) =>
    img.closest('a[href]') || img.closest('div[role="listitem"]') ||
    img.closest('figure') || img.parentElement;
  const cellBest = new Map();
  for (const img of document.querySelectorAll('img')) {
    const src = img.src || (img.srcset || '').split(' ')[0] || img.dataset?.src || '';
    if (!src || BAD_IMG.test(src)) continue;
    const area = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
    const cell = cellOf(img);
    const prev = cellBest.get(cell);
    if (!prev || area > prev.area) cellBest.set(cell, { img, src, area });
  }
  for (const { img, src } of cellBest.values()) {
    if (seen.has(src)) continue;
    // Real photo: sizeable layout/natural size (offsetWidth covers unloaded
    // lazy thumbs; data-URI favicons die here too)
    if (Math.max(img.naturalWidth || 0, img.width || 0, img.offsetWidth || 0) < 100) continue;
    seen.add(src);
    const cell = cellOf(img);
    const t = ((cell && cell.innerText) || img.alt || '').trim();
    let pageUrl;
    try {
      const a = img.closest('a');
      if (a && a.href && !a.href.includes('google.com/search')) pageUrl = a.href;
    } catch (_) {}
    out.push({
      title: (img.alt || t.split('\n')[0] || 'Image').slice(0, 140),
      url: pageUrl || src,
      imageUrl: src,
      thumbnail: src,
      description: t.split('\n').slice(1).join(' ').slice(0, 200),
      type: 'image'
    });
  }
  return out;
}

/** tbm=vid video list extractor */
function extractVideoList() {
  const out = [];
  const seen = new Set();
  const BAD_IMG = /logo|favicon|s2\/favicons|gstatic\.com\/.*nav/i;
  const biggestImg = (root) => {
    let best = null, bestArea = 0;
    for (const img of root.querySelectorAll('img')) {
      const src = img.src || img.dataset?.src || '';
      if (!src || BAD_IMG.test(src)) continue;
      // favicons/icons are ~16-32px; All-tab image-strip thumbs are ~48px+.
      // offsetWidth covers lazy thumbs not yet loaded (CSS-sized cells);
      // applies to data: URIs too — Google inlines favicons as base64 as well.
      if (Math.max(img.naturalWidth || 0, img.width || 0, img.offsetWidth || 0) < 40) continue;
      const area = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
      if (area > bestArea) { bestArea = area; best = img; }
    }
    return best;
  };
  for (const a of document.querySelectorAll('a[href^="http"], a[href^="/url?"]')) {
    // unwrap google redirect links; skip other internal anchors
    let href = a.href;
    try {
      const u = new URL(href, location.origin);
      if (u.pathname === '/url' && u.searchParams.get('q')) href = u.searchParams.get('q');
    } catch (_) {}
    if (href.includes('google.com/') || seen.has(href)) continue;
    // climb to the card so title/duration/summary text is captured
    let card = a, t = '';
    for (let i = 0; i < 5 && card; i++) {
      const ct = (card.innerText || '').trim();
      if (ct.length > t.length) t = ct;
      if (ct.length > 30) break;
      card = card.parentElement;
    }
    const h3 = a.querySelector('h3') || card?.querySelector('h3');
    const title = h3 ? h3.innerText.trim() : t.split('\n')[0];
    if (!title || title.length < 4) continue;
    seen.add(href);
    const img = biggestImg(a);
    const dur = (t.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0];
    out.push({
      title: title.slice(0, 140),
      url: href,
      description: t.split('\n').slice(1).join(' ').slice(0, 300),
      thumbnail: img ? (img.src || undefined) : undefined,
      duration: dur,
      type: 'video'
    });
  }

  // Video-tab anchors are JS-bound (no hrefs) — the real URLs sit in the
  // page's JSON payload. Scan raw HTML for known video hosts and pair each
  // with the nearest img thumb + surrounding title text when resolvable.
  if (out.length === 0) {
    const html = document.documentElement.outerHTML;
    const re = /https?:\\?\/\\?\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|vimeo\.com\/\d+|tiktok\.com\/@[\w.]+\/video\/|dailymotion\.com\/video\/)[\w./?=&%-]+/g;
    const urls = [...new Set((html.match(re) || []).map(u => u.replace(/\\\//g, '/')))];
    for (const u of urls.slice(0, 20)) {
      let title = '', thumb, el;
      // find a DOM element referencing this url for title/thumb context
      el = document.querySelector(`a[href="${u}"]`) ||
           [...document.querySelectorAll('a')].find(a => a.href === u);
      if (el) {
        const cell = el.closest('div,li');
        title = ((cell?.innerText || el.innerText || '').split('\n')
          .find(l => l.trim().length > 10) || '').trim();
        const img = cell?.querySelector('img') || el.querySelector('img');
        if (img) thumb = img.src;
      }
      out.push({
        title: title.slice(0, 140) || 'Video',
        url: u,
        description: '',
        thumbnail: thumb,
        type: 'video'
      });
    }
  }
  return out;
}

export async function searchGoogleSerp(query, options = {}) {
  const startTime = Date.now();
  const maxResults = options.maxResults || 10;
  // hl localizes UI + result language skew; setlang reinforces it for the
  // results themselves. Original-language queries (from comms-graph
  // detectedLanguage) need both to return native-language sources/overviews.
  const lang = (options.lang || 'en').replace(/[^a-zA-Z-]/g, '');
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(lang)}&setlang=${encodeURIComponent(lang)}`;

  if (searchBrowser.paceExceeded('google')) {
    return { results: [], total: 0, provider: 'google-serp', pacedOut: true, elapsedMs: 0 };
  }
  // Recently sorry/consent-blocked — don't pay a full nav timeout per query.
  if (searchBrowser.engineBlocked('google')) {
    return { results: [], total: 0, provider: 'google-serp', blocked: 'cooldown', elapsedMs: 0 };
  }

  let page;
  try {
    page = await searchBrowser.navigate(url, { expectHost: 'google.com' });
  } catch (err) {
    throw new Error(`google-serp navigation failed: ${err.message}`);
  }

  // AI Overview streams in after DOMContentLoaded — give it a bounded wait.
  try {
    await page.waitForFunction(
      () => {
        const labels = ['ai overview', 'ai mode', 'ai 概览', 'ai概览', 'ai 概要', 'ai概要',
          'ai 개요', 'resumen de ia', 'descripción general de ia', 'présentation de l\'ia',
          'aperçu ia', 'aperçu de l\'ia', 'ki-übersicht', 'ki übersicht',
          'visão geral de ia', 'обзор от ии'];
        return [...document.querySelectorAll('h1,h2,h3,div[role="heading"],strong')]
          .some(h => labels.includes((h.textContent || '').trim().toLowerCase()));
      },
      { timeout: AI_OVERVIEW_WAIT_MS }
    );
  } catch (_) { /* no AI Overview for this query — fine */ }

  const extracted = await page.evaluate(extractSerp, { intent: options.intent });

  if (extracted.blocked) {
    searchBrowser.markEngineBlocked('google', GOOGLE_BLOCK_COOLDOWN_MS);
    return { results: [], total: 0, provider: 'google-serp', blocked: extracted.blockReason, elapsedMs: Date.now() - startTime };
  }

  let results = extracted.results;

  // Inline-only: the All tab's Images block is faster and better-looking than
  // a dedicated tbm=isch hop (user direction — no second navigation).
  const intent = options.intent;

  // Image intent: the All-tab Images strip extracts as photo-thumbed
  // web-results (anchors with h3) — retype thumbed items as 'image' so the
  // renderer gives them the media-card treatment, and rank them first.
  if (intent === 'image') {
    for (const r of results) {
      if (r.type !== 'image' && (r.thumbnail || r.imageUrl)) r.type = 'image';
    }
    if (!results.some(r => r.type === 'image')) {
      console.warn(`[google-serp] image intent but 0 images — headings: ${JSON.stringify(extracted.debug?.headings || [])}`);
      console.warn(`[google-serp] img sizes: ${JSON.stringify(extracted.debug?.imgs || [])}`);
    }
    results = [...results.filter(r => r.type === 'image'), ...results.filter(r => r.type !== 'image')];
  }

  results = results.slice(0, maxResults).map((r, i) => ({
    ...r,
    source: 'Google',
    relevanceScore: 0.9 - (i * 0.04)
  }));
  const elapsedMs = Date.now() - startTime;

  // Return at extraction speed — URL unwrap + oEmbed title enrichment run
  // in the background via the enrich hook; search.js re-caches the mutated
  // results when it completes. The HTTP response goes out unblocked.
  const _enrich = async () => {
    await Promise.all([unwrapGoogleUrls(results), enrichVideoTitles(results)]);
    return results;
  };

  // Never return empty when the page had real content — wrap the raw text.
  if (results.length === 0 && (extracted.rawText || '').length > 400 && !extracted.aiOverview) {
    results.push({
      title: `Google results for "${query}"`,
      description: extracted.rawText.slice(0, 2000),
      url,
      source: 'Google',
      type: 'raw-text',
      relevanceScore: 0.3
    });
  }

  return {
    results,
    total: results.length,
    provider: 'google-serp',
    aiOverview: extracted.aiOverview || undefined,
    rawText: extracted.rawText || undefined,
    elapsedMs,
    _enrich
  };
}
