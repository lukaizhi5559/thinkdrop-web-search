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
const NAV_TIMEOUT_MS = parseInt(process.env.SEARCH_NAV_TIMEOUT_MS) || 15000;
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

// Lite pass — organic anchors + their source hosts only. Runs right after
// the render wait resolves so stream:true consumers can show favicon chips
// while the full extractSerp/media phases are still working.
function extractOrganicLite() {
  const isGoogleUrl = (u) => { try { return new URL(u).hostname.endsWith('google.com'); } catch (_) { return true; } };
  const items = [], seen = new Set();
  for (const h3 of document.querySelectorAll('a h3')) {
    const a = h3.closest('a[href]');
    let href = a?.href || '';
    // Organic hrefs are often google.com/url?q= wrapped — unwrap before the
    // isGoogleUrl check, same as extractSerp's section-4a.
    try {
      const u = new URL(href, location.origin);
      // /url carries the destination under q (organic) or url (Videos tab).
      if (u.pathname === '/url' && (u.searchParams.get('q') || u.searchParams.get('url')))
        href = u.searchParams.get('q') || u.searchParams.get('url');
      if (u.pathname === '/url' && u.searchParams.get('url')) href = u.searchParams.get('url');
    } catch (_) {}
    if (!href || seen.has(href) || isGoogleUrl(href)) continue;
    seen.add(href);
    // Cite row carries the real host even when the href stayed wrapped.
    let displayDomain = '';
    const cite = a.querySelector('cite');
    const citeM = ((cite && cite.innerText) || a.innerText || '')
      .match(/(?:https?:\/\/)?([\w.-]+\.(?:com|net|org|io|ai|app|co|dev|gov|edu|info|me|us|uk|de|fr|jp|au|ca|tv|gg|news|shop|store|site))\b/i);
    if (citeM) displayDomain = citeM[1].replace(/^www\./, '').toLowerCase();
    items.push({
      title: (h3.textContent || '').trim().slice(0, 140),
      url: href,
      ...(displayDomain && { displayDomain }),
      type: 'web-result'
    });
    if (items.length >= 8) break;
  }
  const sh = new Set(), sources = [];
  for (const it of items) {
    let hostname = it.displayDomain || '';
    if (!hostname) { try { hostname = new URL(it.url).hostname.replace(/^www\./, ''); } catch (_) {} }
    if (!hostname || sh.has(hostname)) continue;
    sh.add(hostname);
    sources.push({ url: it.url, hostname, title: it.title });
  }
  return { items, sources };
}

function extractSerp(opts = {}) {
  const out = { blocked: false, blockReason: null, aiOverview: null, results: [], rawText: '' };
  const txt = (el) => (el?.innerText || el?.textContent || '').trim();
  const seen = new Set();
  const isGoogleUrl = (u) => { try { return new URL(u).hostname.endsWith('google.com'); } catch (_) { return true; } };
  const BAD_IMG = /logo|favicon|s2\/favicons|gstatic\.com\/.*nav/i;
  // Google's lazy img src is a data-URI placeholder until a script swaps it —
  // the page's script text carries a "dimg_id":"https:\/\/..." map of the real
  // URLs. Build it once so placeholder imgs resolve to their posters.
  const _dimgMap = (() => {
    const map = {};
    try {
      for (const s of document.scripts) {
        const t = s.textContent || '';
        for (const m of t.matchAll(/"(dimg_[^"]+)":"([^"]+)"/g)) {
          if (/encrypted-tbn|gstatic|ggpht|ytimg/i.test(m[2])) {
            map[m[1]] = m[2]
              .replace(/\\u003d/g, '=').replace(/\\u0026/g, '&')
              .replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
          }
        }
      }
    } catch (_) {}
    return map;
  })();
  // Real thumb src for a possibly-lazy img: data-URI placeholder → the
  // script-map URL; http(s)/dataset.src pass through.
  const resolveImgSrc = (img) => {
    if (!img) return undefined;
    const src = img.src || img.dataset?.src || '';
    if (/^\s*data:image\//.test(src) && img.id && _dimgMap[img.id]) return _dimgMap[img.id];
    return src || undefined;
  };
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
      const area = Math.max(img.naturalWidth || 0, img.width || 0, img.offsetWidth || 0)
        * Math.max(img.naturalHeight || 0, img.height || 0, img.offsetHeight || 0);
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
      thumbnail: resolveImgSrc(im) || im.src,
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
  // In-page consent interstitial — "Before you continue to Google" renders
  // ON google.com/search (no consent.google. redirect), so the checks above
  // miss it; the SERP behind it never loads → organic extraction reads a
  // wall as an empty page (observed: every query → "empty results").
  const _consentForm = document.querySelector('form[action*="consent"], form[action*="ServiceLogin"]');
  const _consentBtn = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
    .find(b => /^(accept all|i agree|agree|alle akzeptieren|tout accepter|aceptar todo|接受|同意)/i
      .test((b.innerText || b.value || '').trim()));
  if (_consentForm || (_consentBtn && /before you continue/i.test(bodyText))
      || /before you continue to google/i.test(bodyText)) {
    out.blocked = true;
    out.blockReason = 'consent-interstitial';
    return out;
  }
  // Empty-shell flag — a JS-required/lite stub page with no extractable
  // content and no external anchors. Not blocked: gbv=1 recovery may work.
  const _externalAnchors = [...document.querySelectorAll('a[href^="http"]')]
    .filter(a => !isGoogleUrl(a.href)).length;
  if (bodyText.length < 200 && _externalAnchors === 0) out.emptyShell = true;

  // ── 2. Answer block (AI Overview / AI Mode / future answer surfaces) ──
  // Signal-based, not label-anchored: Google's generated answer is the
  // substantial prose region BEFORE the first organic result in the main
  // column. Localized labels are a scoring bonus only — a renamed panel is
  // still found because it sits in the same slot. UI chrome (share sheets,
  // feedback rows, tab bars, sr-only live text like "AI Mode replied") is
  // pruned by BEHAVIOR (role/aria/hidden/size), not wording, so added or
  // renamed controls can't leak into the answer.
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
  const CHROME_ROLES = new Set(['button', 'menu', 'menubar', 'menuitem',
    'tooltip', 'status', 'alert', 'dialog', 'navigation', 'complementary',
    'tab', 'tablist', 'banner', 'contentinfo', 'search', 'form']);
  // Mark label-anchored overview panels BEFORE extraction — Google ships the
  // tail of an AI Overview (bullet lists, follow-up prompts, extra citations)
  // inside hidden/aria-hidden subtrees behind a "Show more" toggle. That is
  // answer content, not chrome: elements inside a marked panel get a pass on
  // the hidden/clip pruning below (role/aria-live pruning still applies, so
  // sr-only announcements and controls can't leak through).
  for (const h of document.querySelectorAll('h1, h2, h3, div[role="heading"], strong')) {
    if (!AI_OVERVIEW_LABELS.has(txt(h).trim().toLowerCase())) continue;
    let node = h.parentElement;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      node.setAttribute('data-td-overview', '1');
      node = node.parentElement;
    }
  }
  const isChromeEl = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const inOverview = !!el.closest('[data-td-overview]');
    if (!inOverview && (el.hidden || el.getAttribute('aria-hidden') === 'true')) return true;
    const role = el.getAttribute('role');
    if (role && CHROME_ROLES.has(role)) {
      // Inside a marked panel, <span role="button"> chips are INLINE citation
      // links ("French Bulldog", "Pomeranian" mid-sentence) — their text is
      // answer content. Real controls are <button> elements or div[role=*].
      const citeChip = inOverview && el.tagName === 'SPAN'
        && !el.querySelector('button,[role="menu"],[role="dialog"],ul,ol');
      if (!citeChip) return true;
    }
    if (el.hasAttribute('aria-live')) return true;
    // display:none elements and 1px-clipped sr-only announcements — Google's
    // a11y text ("AI Mode replied") lives here and innerText keeps it. Inside
    // a marked overview panel a clipped subtree can instead be the collapsed
    // answer body or an inline cite phrase — any text-bearing node passes.
    if ((el.offsetWidth || 0) <= 1 && (el.offsetHeight || 0) <= 1) {
      return !(inOverview && (el.textContent || '').trim().length > 0);
    }
    if (inOverview) {
      // Inside the answer panel, a strip of thumbnail-carrying tiles is the
      // overview's source-carousel (Pinterest/Getty/IMDb cards at the panel
      // foot) — presentation chrome, not answer text. Structure, not text
      // share: ≥3 same-level children that each carry an <img> — prose
      // bullets and paragraphs never pack image children like that.
      const cardish = [...el.children].filter(k => k.querySelector && k.querySelector('img'));
      if (cardish.length >= 3 && !el.hasAttribute('data-td-overview')) return true;
      // Source-card strip — each row carries a "+N related results" chip
      // (button[data-amic]) or a site-favicon anchor (a.PMDqCb, aria-label
      // only). ≥2 chips = the list container — but only prune when the
      // chip-carrying rows dominate, so a shared panel wrapper (prose +
      // cards) survives to be walked. 1 chip + multi-line text = one row
      // reached on its own.
      const srcChips = [...el.querySelectorAll('[data-amic], button[aria-label*="related result" i], a[class*="PMDqCb"], a[class*="POYEld"], button[aria-label="About this result" i]')];
      if (srcChips.length >= 2) {
        let cardChars = 0;
        for (const ch of srcChips) {
          let row = ch;
          while (row.parentElement && row.parentElement !== el) row = row.parentElement;
          cardChars += (row.innerText || '').trim().length;
        }
        if (cardChars / Math.max((el.innerText || '').trim().length, 1) > 0.6) return true;
      }
      if (srcChips.length === 1
          && (el.innerText || '').split('\n').filter(l => l.trim()).length >= 2) return true;
      // A lone card-anchor — an <a> carrying a thumb with multi-line card
      // text (title + site + age/duration, e.g. the panel-foot video card).
      // querySelectorAll('a') can't see el itself, so this needs its own rule.
      if (el.tagName === 'A' && el.querySelector('img')) {
        const lt = (el.innerText || '').trim();
        if (lt.split('\n').filter(Boolean).length >= 2
            || /\b\d{1,2}:\d{2}\b|\b\d+[smhdwy]\b|\bago\b/i.test(lt)) return true;
      }
      // Source-list chrome can be text-only rows (Quora/Reddit/Wikipedia
      // citations under the answer) — no imgs at all. An element whose text
      // is dominated by ≥3 link labels is a citation strip, not prose.
      const anchors = [...el.querySelectorAll('a')]
        .filter(a => ((a.innerText || a.textContent) || '').trim().length > 3);
      const imgAnchors = anchors.filter(a => a.querySelector('img'));
      if (imgAnchors.length >= 2 || anchors.length >= 3) {
        const heavy = imgAnchors.length >= 2 ? imgAnchors : anchors;
        const linkChars = heavy.reduce((n, a) =>
          n + ((a.innerText || a.textContent || '').trim().length), 0);
        if (linkChars / Math.max((el.textContent || '').trim().length, 1) > 0.5) return true;
      }
      // A wrapper holding ONE multi-line card-anchor (title + site + age) is
      // still a card — the ≥3 rule above can't see it.
      if (imgAnchors.length >= 1 && imgAnchors.length <= 2
          && imgAnchors.some(a => (a.innerText || '').split('\n').filter(Boolean).length >= 2)) {
        const cardChars = imgAnchors.reduce((n, a) => n + (a.innerText || '').trim().length, 0);
        if (cardChars / Math.max((el.textContent || '').trim().length, 1) > 0.5) return true;
      }
    }
    return false;
  };
  // Backstop line filter — role/hidden pruning (A3) removes chrome by
  // behavior; these exact-line drops catch strays that survive (e.g. chrome
  // rendered as plain divs). Exact-match only, so real prose can't hit it.
  const CHROME_LINE_RE = /^(?:share public link|copy link|copied to clipboard|can'?t copy[^\n]*|learn more|good response|bad response|show all|show less|show more|read more|load more|view more|see more|dive deeper[^\n]*|listen|feedback|report|help|sign in|all|ai mode|ai overview|ai mode replied[^\n]*|images|videos|short videos|news|maps|shopping|forums|flights|finance|more|tools|web|share|facebook|gmail|x|reddit|whatsapp|export to \w+|people also ask|related searches|next|previous|close|about this result|a copy of this chat[^\n]*|google may use[^\n]*|for legal issues[^\n]*|copied|failed to copy|copy|thanks for letting us know[^\n]*)\.?$/i;
  const cleanAiText = (t) => {
    const cleaned = t
      .replace(/^#{0,6}\s*AI (Overview|Mode)[^\n]*\n?/i, '')
      .replace(/^#{0,6}\s*AI (Overview|Mode)\s*$/im, '')
      // "+N" citation chips concatenated into prose by innerText (the DOM→md
      // path already converts them to [n] markers — this catches the fallback).
      .replace(/ ?\+\d{1,2}(?=\s|$)/gm, '')
      // Truncation toggles concatenate inline at the end of innerText
      // ("...the constitution ...Read more") — strip anywhere they occur.
      .replace(/ ?(?:\.\.\.|…)? ?(?:read more|show more|view more|load more|see more)\.?(?=\s|$)/gi, '')
      // Clipboard-toast fragments concatenate into one line ("CopiedFailed to
      // copyCopy") — a line filter can't see inside a fused string.
      .replace(/copied\s*failed to copy\s*copy/gi, '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => !AI_OVERVIEW_LABELS.has(l.replace(/^#{1,6}\s*/, '').toLowerCase()))
      .filter(l => l && !/[{;}]|function\s*\(|window\.|try\s*\{|\.rll\(|var |const |=>/.test(l)
               && !CHROME_LINE_RE.test(l.replace(/^#{1,6}\s*/, ''))
               && !/^ai mode replied?$/i.test(l));
    // Source-card tail — variants where the strip's DOM isn't chrome-flagged
    // still emit its flat text: a bare site-name line immediately followed by
    // its own "Title | Site" line is a SERP card, not overview prose. Cut the
    // text at the first such pair (real prose never titles itself by site).
    let cut = cleaned.length;
    for (let i = 0; i < cleaned.length - 1; i++) {
      const name = cleaned[i], next = cleaned[i + 1];
      if (name.length > 2 && name.length <= 40 && !/[.!?,:;]$/.test(name)
          && new RegExp(`\\s[|·-]\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').test(next)) {
        // Require a second card-ish pair nearby so a stray "Title | X" line in
        // real prose can't truncate the answer.
        const rest = cleaned.slice(i + 1, i + 8);
        if (rest.some((l, j) => j > 0 && /\s[|·-]\s*\S.{2,}$/.test(l))) { cut = i; break; }
      }
    }
    return cleaned.slice(0, cut).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, 4000)
      .trim();
  };
  // Translate the overview's native DOM into markdown — headings, lists,
  // tables, bold, and real links survive; innerText flattens all of it and
  // concatenates "+N" citation chips into the prose. Citation chips/sup
  // become bare [n] markers (their hrefs are google-internal scroll/goto
  // URLs — the real sources surface in the result cards).
  const SKIP_MD = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','CANVAS','IFRAME','BUTTON','SELECT','INPUT','TEXTAREA','FORM','AUDIO','VIDEO','TEMPLATE','NAV']);
  const BLOCK_MD = new Set(['P','DIV','SECTION','ARTICLE','MAIN','HEADER','FOOTER','UL','OL','LI','TABLE','THEAD','TBODY','TR','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','HR','DL','DT','DD','FIGURE','DETAILS','SUMMARY']);
  const mdInline = (node) => {
    let s = '';
    // Element boundaries carry no whitespace in the DOM ("Sydney<span>because"
    // comes from innerText inserts a space where DOM concatenation doesn't) —
    // insert a boundary space unless the piece starts with punctuation/space.
    const app = (piece) => {
      if (piece && s && !/\s$/.test(s) && !/^[\s,.;:!?%)\]]/.test(piece)) s += ' ';
      s += piece;
    };
    for (const c of node.childNodes || []) {
      if (c.nodeType === 3) { app(c.nodeValue); continue; }
      if (c.nodeType !== 1 || SKIP_MD.has(c.tagName) || isChromeEl(c)) continue;
      const t = (c.textContent || '').trim();
      if (!t) continue;
      if (/^\+\d{1,2}$/.test(t)) { app(`[${t.slice(1)}]`); continue; }
      if (c.tagName === 'SUP' && /^\[?\d{1,2}\]?$/.test(t)) { app(`[${t.replace(/\D/g, '')}]`); continue; }
      if (c.tagName === 'BR') { s += '  \n'; continue; }
      if (c.tagName === 'A') {
        const href = c.href || '';
        const label = mdInline(c).trim() || t;
        app((href && /^https?:/.test(href) && !isGoogleUrl(href)) ? `[${label}](${href})` : label);
        continue;
      }
      if (c.tagName === 'STRONG' || c.tagName === 'B') { app(`**${mdInline(c).trim() || t}**`); continue; }
      if (c.tagName === 'EM' || c.tagName === 'I') { app(`*${mdInline(c).trim() || t}*`); continue; }
      if (c.tagName === 'CODE') { app(`\`${t}\``); continue; }
      app(mdInline(c));
    }
    return s;
  };
  const mdItem = (li) => {
    const parts = [];
    let nested = '';
    for (const c of li.childNodes || []) {
      if (c.nodeType === 3) parts.push(c.nodeValue);
      else if (c.nodeType === 1 && !SKIP_MD.has(c.tagName) && !isChromeEl(c)) {
        if (c.tagName === 'UL' || c.tagName === 'OL') {
          // Items owned by THIS list — Google can wrap <li>s in <div>s inside
          // the <ul>, while a nested list's <li>s keep their own inner list.
          const items = [...c.querySelectorAll('li')].filter(x => x.closest('ul,ol') === c);
          nested += '\n' + items.map((x, i) => `  ${c.tagName === 'OL' ? `${i + 1}.` : '-'} ${mdItem(x)}`).join('\n');
        } else parts.push(mdInline(c));
      }
    }
    return parts.join('').replace(/\s+/g, ' ').trim() + nested;
  };
  const mdTable = (tbl) => {
    const body = [...tbl.querySelectorAll('tr')]
      .map(tr => [...tr.querySelectorAll('th,td')].map(c => mdInline(c).trim().replace(/\|/g, '\\|').replace(/\s+/g, ' ')))
      .filter(r => r.some(c => c));
    if (!body.length) return '';
    const sep = body[0].map(() => '---');
    return [body[0], sep, ...body.slice(1)].map(r => `| ${r.join(' | ')} |`).join('\n') + '\n\n';
  };
  const mdBlocks = (el) => {
    let out = '';
    const direct = [];
    for (const c of el.childNodes || []) {
      if (c.nodeType === 3) { direct.push(c.nodeValue); continue; }
      if (c.nodeType !== 1 || SKIP_MD.has(c.tagName) || BLOCK_MD.has(c.tagName)) continue;
      // Inside a marked overview panel a bare <a> carrying a thumbnail (or
      // card-length text) is a source-carousel tile, not an inline cite —
      // prose links live inside P/DIV and never reach this loop.
      if (c.tagName === 'A' && c.closest('[data-td-overview]')
          && (c.querySelector('img') || (c.textContent || '').trim().length > 60)) continue;
      if (!isChromeEl(c)) direct.push(mdInline(c));
    }
    const lead = direct.join('').replace(/\s+/g, ' ').trim();
    if (lead) out += lead + '\n\n';
    for (const c of el.children || []) {
      const tag = c.tagName;
      if (SKIP_MD.has(tag) || isChromeEl(c) || !(c.textContent || '').trim()) continue;
      if (/^H[1-6]$/.test(tag)) { const t = mdInline(c).trim(); if (t) out += `${'#'.repeat(+tag[1])} ${t}\n\n`; continue; }
      if (tag === 'UL' || tag === 'OL') {
        // Items owned by THIS list — Google can wrap <li>s in <div>s inside
        // the <ul>, while a nested list's <li>s keep their own inner list.
        const items = [...c.querySelectorAll('li')].filter(li => li.closest('ul,ol') === c);
        if (items.length) out += items.map((li, i) => `${tag === 'OL' ? `${i + 1}.` : '-'} ${mdItem(li)}`).join('\n') + '\n\n';
        continue;
      }
      if (tag === 'TABLE') { out += mdTable(c); continue; }
      if (tag === 'BLOCKQUOTE') { const t = mdInline(c).trim(); if (t) out += `> ${t}\n\n`; continue; }
      if (tag === 'PRE') { out += '```\n' + (c.textContent || '').trim() + '\n```\n\n'; continue; }
      if (tag === 'HR') { out += '---\n\n'; continue; }
      if (BLOCK_MD.has(tag)) { out += mdBlocks(c); continue; }
      // Non-block inline children were already collected into `lead` above —
      // emitting them again explodes token spans into one line each.
    }
    return out;
  };
  // Plain-text fallback for when mdBlocks collapses to nothing — MUST keep
  // isChromeEl pruning: a raw innerText read re-admits every source-card /
  // related-results strip the markdown walk correctly skipped.
  const prunedText = (el) => {
    const parts = [];
    const walk = (n) => {
      for (const c of n.childNodes || []) {
        if (c.nodeType === 3) { parts.push(c.nodeValue); continue; }
        if (c.nodeType !== 1 || SKIP_MD.has(c.tagName) || isChromeEl(c)) continue;
        walk(c);
        if (BLOCK_MD.has(c.tagName) || /^H[1-6]$/.test(c.tagName) || c.tagName === 'LI') parts.push('\n');
      }
    };
    walk(el);
    return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  // Candidate pool = every substantial block that renders BEFORE the first
  // organic result in the main column, in READING ORDER — ancestors of the
  // first organic are wrappers (skipped), and siblings AFTER it are
  // Discussions-and-forums carousels / People-also-ask / related searches —
  // not answers. The position gate is what keeps those out of the pool.
  const _mainCol = document.querySelector('#rcnt, #search, #center_col, main, [role="main"]') || document.body;
  const _firstOrganic = _mainCol.querySelector('a h3');
  const _FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
  const _candSet = new Set();
  for (const el of _mainCol.querySelectorAll('div, section, article')) {
    const t = (el.innerText || '').trim();
    if (t.length < 80 || t.length > 20000) continue;
    if (_firstOrganic) {
      if (el.contains(_firstOrganic)) continue;
      if (!(el.compareDocumentPosition(_firstOrganic) & _FOLLOWING)) continue;
    }
    _candSet.add(el);
  }
  // Label-anchored climbs stay in the pool — covers layouts where the answer
  // sits at/below the organic block or outside the main column.
  for (const h of document.querySelectorAll('h1, h2, h3, div[role="heading"], strong')) {
    if (AI_OVERVIEW_LABELS.has(txt(h).trim().toLowerCase())) {
      let node = h.parentElement;
      for (let i = 0; i < 6 && node; i++) { _candSet.add(node); node = node.parentElement; }
    }
  }
  // Score each candidate: prose density + citation chips + known-label bonus
  // vs. interactive-descendant density + chrome-line hits. The winner is the
  // answer body, not the whole panel wrapper (which scores worse — more
  // buttons/menus per char of prose).
  const scoreCandidate = (el) => {
    // innerText excludes display:none/clipped subtrees — a marked overview
    // panel measures its collapsed body via textContent so a panel that hides
    // most of its answer behind "Show more" still outranks a small lead block.
    const inOverview = !!el.querySelector('[data-td-overview]') || el.hasAttribute('data-td-overview');
    const t = (inOverview ? (el.textContent || '') : (el.innerText || '')).trim();
    const desc = el.querySelectorAll('*').length || 1;
    const density = t.length / desc;
    const interactive = el.querySelectorAll(
      'button, [role="button"], [role="menu"], [role="dialog"], [role="tab"], [role="tablist"], [aria-live], select, input, textarea'
    ).length;
    const chips = (t.match(/\+\d{1,2}(?=\s|$)/g) || []).length + el.querySelectorAll('sup').length;
    let labelBonus = 0;
    for (const h of el.querySelectorAll('h1,h2,h3,div[role="heading"],strong')) {
      if (AI_OVERVIEW_LABELS.has(txt(h).trim().toLowerCase())) { labelBonus = 400; break; }
    }
    const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
    const chromeHits = lines.filter(l => CHROME_LINE_RE.test(l)).length;
    // Link-farm penalty — organic containers and discussion carousels are
    // ~90% anchor text; a real answer block is prose-dominated (its source
    // links stay a small share of the characters).
    const linkChars = [...el.querySelectorAll('a')].reduce((n, a) => n + ((a.innerText || '').trim().length), 0);
    const linkRatio = linkChars / Math.max(t.length, 1);
    // Social-post fingerprint — "10+ comments", "90+ reactions", "1.2K likes",
    // plus the time-ago stamps ("1 month ago", "Aug 19, 2026") every card in a
    // discussions/forums carousel carries. Stacked markers = social block, not
    // an answer — the floor below hard-rejects them when no label saved them.
    const socialHits = (t.match(/\b[\d.,]+k?\+?\s*(?:comments?|reactions?|likes|views|reposts|followers|members|posts)\b/gi) || []).length
      + (t.match(/\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi) || []).length
      + (t.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi) || []).length;
    const s = Math.min(t.length, 2500) + chips * 40 + labelBonus + Math.min(density, 40) * 10
      - interactive * 40 - chromeHits * 60 - Math.round(linkRatio * 200) - socialHits * 40;
    return { s, linkRatio, chips, labelBonus, socialHits };
  };
  const chromeRatio = (t) => {
    const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.length ? lines.filter(l => CHROME_LINE_RE.test(l)).length / lines.length : 1;
  };
  const _ranked = [..._candSet]
    .map(el => ({ el, ...scoreCandidate(el) }))
    .filter(c => c.s > 0)
    // Quality floor — a link-farm with no citation chips and no label isn't
    // an answer block, however much text it holds (image-intent SERPs often
    // ship no AI Overview at all; none beats a discussion carousel).
    .filter(c => !(c.linkRatio > 0.5 && c.chips === 0 && !c.labelBonus))
    // Stacked social markers = a discussions/forums carousel, not an answer —
    // hard floor regardless of raw text mass (label-anchored panels exempt).
    .filter(c => !(c.socialHits >= 3 && !c.labelBonus))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);
  // A SERP card caption ("Title | Site | Domain" / a site name repeated on
  // its own line) is not an overview — short text with pipe separators or a
  // trailing site-name line gets rejected even at the fallback, because no
  // overview beats a mislabeled result card.
  const isCaptionShape = (t) => {
    if (!t || t.length >= 200) return false;
    const ls = t.split('\n').map(l => l.trim()).filter(Boolean);
    if (/\|\s*\S/.test(t)) return true;
    if (ls.length >= 2 && ls[0].includes(ls[ls.length - 1])) return true;
    // Single-line product/result-card titles — slash- or dash-separated
    // fragments ("X / Standee - Dark Knight Style"), no sentence punctuation.
    if (ls.length === 1 && /[/–—]|\s-\s/.test(ls[0]) && !/[.!?]$/.test(ls[0])) return true;
    // Shopping-caption titles — a long comma-list of product fragments
    // ("png bundle, clipart set, super hero png, instant download").
    if (ls.length === 1 && ls[0].split(',').length >= 4 && !/[.!?]$/.test(ls[0])) return true;
    return false;
  };
  let _bestRejected = null;
  for (const { el: cand } of _ranked) {
    // A winning wrapper may outscore on raw text yet hold the overview plus
    // unrelated sections (related panels, shopping cards). Extract from the
    // marked panel boundary inside it instead — querySelectorAll returns
    // outermost-first, and the outermost marked node IS the panel root.
    const target = cand.hasAttribute('data-td-overview') ? cand
      : (cand.querySelector('[data-td-overview]') || cand);
    let md = mdBlocks(target).trim();
    let t = cleanAiText(md.length > 40 ? md : prunedText(target));
    // AI-Mode variants mark a reply box that's pure UI chrome (share/copy/
    // feedback) while the real answer prose sits elsewhere in the winner —
    // when the panel extracts to nothing, retry on the candidate itself.
    if (t.length <= 80 && target !== cand) {
      md = mdBlocks(cand).trim();
      t = cleanAiText(md.length > 40 ? md : prunedText(cand));
    }
    if (t.length <= 80 || isCaptionShape(t)) continue;
    // Sanity check — a candidate that's still >15% UI lines after pruning is
    // chrome, not answer; try the next-best candidate instead of shipping it.
    if (chromeRatio(t) <= 0.15) {
      out.aiOverview = t;
      // TEMP-DIAG: dump the winning target's interactive elements + tail structure
      try {
        out.debug = out.debug || {};
        out.debug.winner = {
          tag: target.tagName, cls: (target.className || '').toString().slice(0, 50),
          links: [...target.querySelectorAll('a,button,[role="button"]')].slice(0, 30).map(x => ({
            tag: x.tagName, txt: (x.innerText || '').trim().slice(0, 35), tc: (x.textContent || '').trim().slice(0, 35),
            aria: (x.getAttribute('aria-label') || '').slice(0, 30),
            html: x.outerHTML.slice(0, 160),
          })),
          stripPath: (() => {
            const w = target.querySelector('a[class*="PMDqCb"], [data-amic]')
              || [...target.querySelectorAll('div,p,span')].filter(x => /Petfinder|Chewy|Spruce/i.test(x.innerText || '') && (x.innerText || '').trim().length < 300).pop();
            if (!w) return null;
            const chain = [];
            let n = w;
            for (let i = 0; i < 8 && n && n !== target; i++) {
              const sigs = n.querySelectorAll('[data-amic], a[class*="PMDqCb"], a[class*="POYEld"], button[aria-label*="related result" i], button[aria-label="About this result" i]');
              let share = 0;
              if (sigs.length >= 2) {
                let cc = 0;
                for (const ch of sigs) { let row = ch; while (row.parentElement && row.parentElement !== n) row = row.parentElement; cc += (row.innerText || '').trim().length; }
                share = cc / Math.max((n.innerText || '').trim().length, 1);
              }
              chain.push({ lvl: i, tag: n.tagName, sigs: sigs.length, share: +share.toFixed(2), chrome: isChromeEl(n), role: n.getAttribute('role') || undefined, kids: n.children.length, txt: (n.innerText || '').trim().slice(0, 60) });
              n = n.parentElement;
            }
            return chain;
          })(),
          tailKids: [...(target.lastElementChild?.children || [])].slice(0, 10).map(x => ({
            tag: x.tagName, a: x.querySelectorAll('a').length, imgs: x.querySelectorAll('img').length,
            lines: (x.innerText || '').split('\n').filter(l => l.trim()).length,
            txt: (x.innerText || '').trim().slice(0, 50),
          })),
          md: md.slice(0, 3000),
        };
      } catch (_) {}
      break;
    }
    if (!_bestRejected) _bestRejected = t;
  }
  // Everything scored as chrome — keep the least-bad pick rather than nothing,
  // but only when it's mostly prose (a share sheet is not an answer).
  if (!out.aiOverview && _bestRejected && chromeRatio(_bestRejected) <= 0.4) {
    out.aiOverview = _bestRejected;
  }
  // AI-Mode variants: the label sits in a chrome-only reply box (share/copy/
  // feedback) while the answer prose is a SIBLING block of some ancestor.
  // Walk each ancestor's forward siblings until a clean text block appears.
  if (!out.aiOverview) {
    for (const h of document.querySelectorAll('h1, h2, h3, div[role="heading"], strong')) {
      if (!AI_OVERVIEW_LABELS.has(txt(h).trim().toLowerCase())) continue;
      let node = h.parentElement;
      for (let i = 0; i < 6 && node && node !== document.body && !out.aiOverview; i++) {
        let sib = node.nextElementSibling;
        for (let j = 0; j < 3 && sib; j++) {
          const md = mdBlocks(sib).trim();
          const t = cleanAiText(md.length > 40 ? md : prunedText(sib));
          if (t.length > 80 && !isCaptionShape(t) && chromeRatio(t) <= 0.15) { out.aiOverview = t; break; }
          sib = sib.nextElementSibling;
        }
        node = node.parentElement;
      }
      if (out.aiOverview) break;
    }
  }
  // Failure fingerprint — when extraction came up empty but candidates existed,
  // their tag/role signature explains what Google served.
  if (!out.aiOverview && _candSet.size) {
    out.debug = out.debug || {};
    out.debug.overviewCandidates = _ranked.map(({ el, s }) =>
      `${s.toFixed(0)} <${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}> ${(el.innerText || '').replace(/\s+/g, ' ').slice(0, 60)}`);
  }

  // ── 3. Vertical sections (Images grid / Videos cards / Top stories) ────
  // Google renders these inline on the main SERP when the query signals
  // intent. Find the section heading, climb to a container holding media
  // links, then harvest the cards.
  // Localized section headings — a non-English query (hl=<lang>) renders
  // native labels, so match both English and common localizations.
  const sectionLabels = {
    'images': 'image', 'videos': 'video', 'short videos': 'video',
    'shorts': 'video', 'top stories': 'news', 'top news': 'news', 'news': 'news',
    '图片': 'image', '视频': 'video', '短视频': 'video',
    '热门故事': 'news', '新闻': 'news', '资讯': 'news',                        // zh
    '画像': 'image', '動画': 'video', 'ショート動画': 'video',
    'トップニュース': 'news', 'ニュース': 'news',                                // ja
    '이미지': 'image', '동영상': 'video', '짧은 동영상': 'video',
    '주요 뉴스': 'news', '뉴스': 'news',                                          // ko
    'imágenes': 'image', 'vídeos': 'video', 'videos': 'video', 'vídeos cortos': 'video',
    'noticias': 'news', 'principales noticias': 'news',                        // es
    'bilder': 'image', 'kurzvideos': 'video', 'nachrichten': 'news', 'schlagzeilen': 'news', // de
    'imagenes': 'image', 'vidéos courtes': 'video', 'actualités': 'news', 'à la une': 'news', // fr
    'imagens': 'image', 'vídeos em destaque': 'video', 'vídeos curtos': 'video',
    'principais notícias': 'news' // pt
  };
  const sectionHeadingSel = 'h1, h2, h3, div[role="heading"], g-link, a[aria-label], span, strong';
  out.debug = out.debug || {};
  for (const h of document.querySelectorAll(sectionHeadingSel)) {
    const label = (txt(h) || h.getAttribute('aria-label') || '').trim().toLowerCase();
    const type = sectionLabels[label];
    if (!type) continue;
    if (type === 'video') out.hasVideoHeading = true;
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
          // Vertical cards link via google.com/imgres / /url redirects —
          // unwrap the real destination (imgrefurl/url/q) plus the full-res
          // image (imgurl) so clicks land on the site, not a Google redirect.
          // Applies to images AND videos/news tiles alike; only skip when the
          // link stays google-internal after unwrapping (opaque /goto tokens).
          let href = a.href, imageUrl;
          if (isGoogleUrl(href)) {
            try {
              const u = new URL(href);
              const ref = u.searchParams.get('imgrefurl') || u.searchParams.get('url')
                || u.searchParams.get('q') || u.searchParams.get('uddg');
              const img = u.searchParams.get('imgurl') || u.searchParams.get('uddg');
              if (ref && !isGoogleUrl(ref)) href = ref;
              if (type === 'image' && img && !isGoogleUrl(img)) imageUrl = img;
            } catch (_) {}
          }
          // Keep /goto wrapped links — unwrapGoogleUrls resolves them
          // server-side (image tiles survive via emitImageFromThumb the same
          // way). Only other google-internal links (/search chips) are junk.
          if (isGoogleUrl(href) && !href.includes('/goto')) continue;
          const t = txt(a) || txt(a.parentElement);
          if (t.length < 8) continue;
          // Tiles can split into TWO anchors sharing the href — a bare
          // title anchor (its only img is the site favicon) and a poster
          // anchor carrying the real thumb + aria-label. The picked anchor
          // may be the bare one, so climb until an ancestor holds a
          // CONTENT img (real/poster-sized or script-mapped) before hunting.
          const hasContentImg = (root) => [...(root?.querySelectorAll('img') || [])].some(i => {
            const s = i.src || i.dataset?.src || '';
            if (i.id && _dimgMap[i.id]) return true;
            const w = Math.max(i.naturalWidth || 0, i.width || 0, i.offsetWidth || 0);
            return w >= 40 && !BAD_IMG.test(s);
          });
          let imgScope = a;
          for (let k = 0; k < 4 && imgScope && !hasContentImg(imgScope); k++) imgScope = imgScope.parentElement;
          if (!imgScope || !hasContentImg(imgScope)) imgScope = a;
          // Short-video tiles are small portrait thumbs — below biggestImg's
          // 40px floor — so fall back to the anchor's imgs directly. Prefer an
          // http(s) src: a 28px data-URI is Google's pre-swap lazy placeholder,
          // not content (the real poster lands once the strip holds viewport).
          const httpImg = (root) => [...(root?.querySelectorAll('img') || [])]
            .find(i => /^https?:/.test(i.src || i.dataset?.src || '') && !BAD_IMG.test(i.src || i.dataset?.src || ''));
          // Lazy placeholder img whose real URL sits in the script map.
          const lazyImg = (root) => [...(root?.querySelectorAll('img') || [])]
            .find(i => i.id && _dimgMap[i.id] && !BAD_IMG.test(_dimgMap[i.id]));
          const img = biggestImg(imgScope) || httpImg(imgScope) || lazyImg(imgScope)
            || [...imgScope.querySelectorAll('img')].find(i => !/^\s*data:image\//.test(i.src || '')
                && (i.src || i.dataset?.src) && !BAD_IMG.test(i.src || ''));
          const tileText = `${t} ${(imgScope.innerText || '')} ${a.getAttribute('aria-label') || ''}`
            + ` ${[...imgScope.querySelectorAll('a[aria-label]')].map(x => x.getAttribute('aria-label') || '').join(' ')}`;
          const dur = (tileText.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0];
          seen.add(a.href);
          out.results.push({
            title: t.split('\n')[0].slice(0, 140),
            url: href,
            imageUrl,
            description: t.split('\n').slice(1).join(' ').slice(0, 300),
            thumbnail: resolveImgSrc(img),
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
    // Snippet text lives in a sibling div one ancestor up from the anchor;
    // the cite row ("Yelp https://www.yelp.com › …") plus title already pass
    // a naive >40-char test, so the climb must filter junk lines out of BOTH
    // the break test and the kept text — otherwise desc is breadcrumb noise.
    // Kept lines include rich-snippet prose ("Rating: 4.5 · 512 reviews").
    const JUNK_RE = /https?:\/\/| › |^[\w.-]+\.(?:com|net|org|io|ai|app|co|dev|gov|edu|info|me|us|uk|de|fr|jp|au|ca)(?:[\s/]|$)/i;
    // Real destination domain from the cite row — result hrefs are wrapped
    // google.com/goto links (background-only unwrap), so hostname derived
    // from r.url renders "google.com" downstream. Zero-latency alternative.
    let displayDomain = '';
    const cite = a.querySelector('cite');
    const citeM = ((cite && cite.innerText) || a.innerText || '')
      .match(/(?:https?:\/\/)?([\w.-]+\.(?:com|net|org|io|ai|app|co|dev|gov|edu|info|me|us|uk|de|fr|jp|au|ca|tv|gg|news|shop|store|site))\b/i);
    if (citeM) displayDomain = citeM[1].replace(/^www\./, '').toLowerCase();
    const h3t = h3.innerText.trim();
    let desc = '';
    // Structured rich-snippet fields — collected from every scanned line so
    // ratings/prices surface even when they sit beside (not inside) the
    // snippet block the desc climb selects.
    let rating, ratingMax, reviewCount, priceRange;
    let box = a.parentElement;
    for (let i = 0; i < 6 && box; i++) {
      const inner = box.innerText || '';
      // A very wide box spans multiple results — its prose would concatenate
      // neighbors' snippets. Stop climbing; keep the tighter-box fallback.
      if (inner.length > 2500) break;
      const lines = inner
        .replace(h3.innerText, '')
        .split('\n').map(l => l.trim()).filter(l => l && !JUNK_RE.test(l));
      // Scan all lines for rating/price patterns before the prose cap —
      // "3.1 ★ (4,472) · Price range: $" lines are non-junk and reach here.
      for (const l of lines) {
        if (rating === undefined) {
          let m = l.match(/\b(\d+(?:\.\d+)?)\s*★/)           // "3.1 ★"
               || l.match(/\brated\s+(\d+(?:\.\d+)?)\s+(?:of|out of)\s+(5|10)\b/i) // "rated 4.0 of 5"
               || l.match(/\b(\d+(?:\.\d+)?)\s*\/\s*(5|10)\b/)                    // "4.0/5"
               || l.match(/\b(\d+(?:\.\d+)?)\s*\(([\d,]+)\s*(?:reviews?|ratings?)\)/) // "1.5 (35 reviews)"
               || l.match(/\b(\d+(?:\.\d+)?)\s*stars?\b/i);                       // "3.5 stars"
          if (m) {
            rating = parseFloat(m[1]);
            // m[2] is the max for "of N"/"/N" patterns but the review count
            // for "(N reviews)" — only accept small values as a max.
            const g2 = m[2] ? parseInt(m[2].replace(/,/g, ''), 10) : NaN;
            ratingMax = (g2 >= 1 && g2 <= 10) ? g2 : 5;
            if (g2 > 10 && reviewCount === undefined) reviewCount = g2;
          } else if (/^★{2,5}☆{0,3}/.test(l)) {
            rating = (l.match(/★/g) || []).length;
            ratingMax = rating + (l.match(/☆/g) || []).length;
          }
        }
        if (reviewCount === undefined) {
          const m = l.match(/\(?([\d,]+)\+?\)?\s*(?:reviews?|ratings?|comments?|votes?)\b/i)
                 || l.match(/\b(?:reviews?:?)\s*\(?([\d,]+)\)?/i);
          if (m) reviewCount = parseInt(m[1].replace(/,/g, ''), 10);
        }
        if (priceRange === undefined) {
          const m = l.match(/price\s*range:?\s*(\${1,4})/i) || l.match(/(?:·|\s)(\${2,4})\b/);
          if (m) priceRange = m[1];
        }
      }
      // First non-junk lines are ours in DOM order — cap at 3 so a wide box
      // can't smear the next result's snippet into this one.
      const prose = lines.slice(0, 3).join(' ');
      if (prose.length > 40) { desc = prose.slice(0, 400); break; }
      // Shorter junk-free lines (e.g. a bare "Rating: 4.2") stay as fallback
      // if the climb never reaches a real snippet block.
      if (lines.length && !desc) desc = lines.slice(0, 3).join(' ').slice(0, 300);
      box = box.parentElement;
    }
    if (desc === h3t) desc = '';
    const img = biggestImg(a);
    out.results.push({
      title: h3.innerText.trim(),
      url: a.href,
      description: desc,
      ...(displayDomain && { displayDomain }),
      ...(rating !== undefined && { rating, ratingMax }),
      ...(reviewCount !== undefined && { reviewCount }),
      ...(priceRange && { priceRange }),
      thumbnail: img ? (img.src || undefined) : undefined,
      type: VIDEO_HOSTS.test(a.href) ? 'video' : 'web-result'
    });
  }

  // ── 4a-lite. Basic-HTML / lite-variant organic fallback ───────────────
  // The gbv=1 SERP (and some JS-minimal variants served to headless engines)
  // puts organic links in table cells as plain external anchors — no h3
  // wrapper, so the pass above yields nothing (observed: every query →
  // "empty results" while the page had real links). Scan the result
  // containers (or the whole doc if they're absent) for external anchors.
  if (out.results.length === 0) {
    const scope = document.querySelector('#main, #search, #rso, #center_col, #topstuff') || document.body;
    for (const a of (scope || document).querySelectorAll('a[href^="http"], a[href^="/url?"]')) {
      let href = a.href || '';
      try {
        const u = new URL(href, location.origin);
        if (u.pathname === '/url' && u.searchParams.get('q')) href = u.searchParams.get('q');
        if (u.pathname === '/url' && u.searchParams.get('url')) href = u.searchParams.get('url');
      } catch (_) {}
      if (!href || seen.has(href) || isGoogleUrl(href)) continue;
      const t = txt(a);
      const title = (t.split('\n')[0] || '').trim();
      if (title.length < 6) continue;
      seen.add(href);
      // Snippet prose: climb a few ancestors for the first non-junk lines.
      const _JUNK_RE = /https?:\/\/| › |^[\w.-]+\.(?:com|net|org|io|ai|app|co|dev|gov|edu|info|me|us|uk|de|fr|jp|au|ca)(?:[\s/]|$)/i;
      let desc = '';
      let box = a.parentElement;
      for (let i = 0; i < 5 && box; i++) {
        const inner = (box.innerText || '').replace(t, '');
        const lines = inner.split('\n').map(l => l.trim()).filter(l => l && !_JUNK_RE.test(l));
        const prose = lines.slice(0, 3).join(' ');
        if (prose.length > 40) { desc = prose.slice(0, 400); break; }
        if (lines.length && !desc) desc = lines.slice(0, 3).join(' ').slice(0, 300);
        box = box.parentElement;
      }
      out.results.push({
        title: title.slice(0, 140),
        url: href,
        description: desc,
        type: VIDEO_HOSTS.test(href) ? 'video' : 'web-result',
        liteVariant: true
      });
      if (out.results.length >= 12) break;
    }
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
  out.debug.title = document.title || '';
  out.debug.url = location.href;
  out.debug.bodyPeek = bodyText.slice(0, 300);
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
    let host = '';
    try { host = pageUrl ? new URL(pageUrl).hostname.replace(/^www\./, '') : ''; } catch (_) {}
    out.push({
      title: (img.alt || t.split('\n')[0] || host || 'Image').slice(0, 140),
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
  // Same dimg_→real-URL script map as extractSerp — lazy imgs hold data-URI
  // placeholders until the swap, and the tab may render before it fires.
  const _dimgMap = (() => {
    const map = {};
    try {
      for (const s of document.scripts) {
        const t = s.textContent || '';
        for (const m of t.matchAll(/"(dimg_[^"]+)":"([^"]+)"/g)) {
          if (/encrypted-tbn|gstatic|ggpht|ytimg/i.test(m[2])) {
            map[m[1]] = m[2]
              .replace(/\\u003d/g, '=').replace(/\\u0026/g, '&')
              .replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
          }
        }
      }
    } catch (_) {}
    return map;
  })();
  const biggestImg = (root) => {
    let best = null, bestArea = 0;
    for (const img of root.querySelectorAll('img')) {
      const src = img.src || img.dataset?.src || '';
      if (!src || BAD_IMG.test(src)) continue;
      // favicons/icons are ~16-32px; All-tab image-strip thumbs are ~48px+.
      // offsetWidth covers lazy thumbs not yet loaded (CSS-sized cells);
      // applies to data: URIs too — Google inlines favicons as base64 as well.
      if (Math.max(img.naturalWidth || 0, img.width || 0, img.offsetWidth || 0) < 40) continue;
      const area = Math.max(img.naturalWidth || 0, img.width || 0, img.offsetWidth || 0)
        * Math.max(img.naturalHeight || 0, img.height || 0, img.offsetHeight || 0);
      if (area > bestArea) { bestArea = area; best = img; }
    }
    return best;
  };
  for (const a of document.querySelectorAll('a[href^="http"], a[href^="/url?"]')) {
    // unwrap google redirect links; skip other internal anchors
    let href = a.href;
    try {
      const u = new URL(href, location.origin);
      // /url carries the destination under q (organic) or url (Videos tab).
      if (u.pathname === '/url' && (u.searchParams.get('q') || u.searchParams.get('url')))
        href = u.searchParams.get('q') || u.searchParams.get('url');
    } catch (_) {}
    // /goto wrapped links pass through — unwrapGoogleUrls resolves them
    // server-side; only other google-internal links are junk.
    if ((href.includes('google.com/') && !href.includes('/goto')) || seen.has(href)) continue;
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
    // Tiles can split into two same-href anchors (bare title + poster); pick
    // imgs from the climbed card, not just the anchor.
    let img = biggestImg(card) || biggestImg(a);
    // A data-URI pick is Google's pre-swap lazy placeholder — resolve it via
    // the script map, else prefer any http(s) img on the card.
    if (img && /^\s*data:image\//.test(img.src || '')) {
      const mapped = img.id && _dimgMap[img.id];
      if (mapped) {
        img = { src: mapped };
      } else {
        const scope = card || a;
        const alt = [...scope.querySelectorAll('img')].find(i => /^https?:/.test(i.src || i.dataset?.src || ''))
          || [...scope.querySelectorAll('img')].find(i => i.id && _dimgMap[i.id]);
        if (alt) img = alt.src && /^\s*data:image\//.test(alt.src) ? { src: _dimgMap[alt.id] } : alt;
      }
    }
    const dur = (`${t} ${a.getAttribute('aria-label') || ''}`.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/) || [])[0];
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

  // Content streams in after DOMContentLoaded — wait for ANY extractable
  // surface (organic anchors, an AI-Overview heading, or a block marker).
  // The overview-only wait let extraction run against a still-empty DOM
  // on slow renders, and gave no signal when Google served a lite/consent
  // variant instead (observed: every query → 0 organic → Bing fallback).
  try {
    await page.waitForFunction(
      () => {
        if (document.querySelector('a h3')) return true;
        const labels = ['ai overview', 'ai mode', 'ai 概览', 'ai概览', 'ai 概要', 'ai概要',
          'ai 개요', 'resumen de ia', 'descripción general de ia', 'présentation de l\'ia',
          'aperçu ia', 'aperçu de l\'ia', 'ki-übersicht', 'ki übersicht',
          'visão geral de ia', 'обзор от ии'];
        if ([...document.querySelectorAll('h1,h2,h3,div[role="heading"],strong')]
          .some(h => labels.includes((h.textContent || '').trim().toLowerCase()))) return true;
        // Lite-variant SERP — external result anchors without h3 wrappers.
        if ([...document.querySelectorAll('#main a[href^="http"], #search a[href^="http"], #rso a[href^="http"]')]
          .some(a => { try { return !new URL(a.href).hostname.endsWith('google.com'); } catch (_) { return false; } })) return true;
        return /unusual traffic|before you continue/i.test(document.body?.innerText || '')
          || !!document.querySelector('iframe[src*="recaptcha"], #captcha-form');
      },
      { timeout: AI_OVERVIEW_WAIT_MS }
    );
  } catch (_) { /* nothing recognizable rendered — extract what exists */ }

  // Early partial emit — organic anchors render first, so a lite pass here
  // lets consumers show favicon chips + first cards while the full extract
  // (media grids, overview markdown) is still running.
  if (typeof options.onPartial === 'function') {
    try {
      const lite = await page.evaluate(extractOrganicLite);
      if (lite.items.length) options.onPartial({ items: lite.items, sources: lite.sources, provider: 'google-serp' });
    } catch (_) {}
  }

  // Expand collapsed AI Overview panels — Google lazy-renders the tail
  // (bullet lists, deep citations) on the "Show more" click. aria-expanded
  // is language-independent; the text match is the fallback. Inside the
  // labelled panel only, so random page expanders can't fire.
  try {
    await page.evaluate(() => {
      const LABELS = /^(ai overview|ai mode|ai 概[览要]|ai概要|ai 개요|resumen de ia|descripción general de ia|présentation de l'ia|aperçu (de l'|)ia|ki-übersicht|ki übersicht|visão geral de ia|обзор от ии)$/i;
      for (const h of document.querySelectorAll('h1,h2,h3,div[role="heading"],strong')) {
        if (!LABELS.test((h.innerText || '').trim())) continue;
        let n = h.parentElement;
        for (let i = 0; i < 8 && n && n !== document.body; i++) {
          // Click EVERY collapsed expander in the panel — the body, bullet
          // list, and source strip can each carry their own toggle.
          const btns = [...n.querySelectorAll('[aria-expanded="false"], button, [role="button"], a')]
            .filter(b => b.getAttribute('aria-expanded') === 'false'
              || /^(show more|read more|view more|load more|see more|expand|show all)\.?$/i.test((b.innerText || '').trim()));
          for (const b of btns) { try { b.click(); } catch (_) {} }
          if (btns.length) return;
          n = n.parentElement;
        }
      }
    });
    await page.waitForTimeout(600);
  } catch (_) {}

  // Lazy media strips (Short videos carousel, image-grid tiles) mount when
  // they enter the viewport — the "short videos" heading can be present with
  // zero tiles beneath it until a scroll. Nudge to the bottom and back.
  try {
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const h = document.body.scrollHeight;
      // Stepped descent — each lazy region must hold the viewport briefly or
      // the strip's tiles never mount (a single jump races past them).
      for (const y of [h * 0.33, h * 0.66, h]) { window.scrollTo(0, y); await sleep(350); }
      // Lazy imgs only swap their data-URI placeholder for the real poster
      // while the strip holds the viewport — park the media section there
      // briefly, then return to the top.
      const stripHead = [...document.querySelectorAll('h1,h2,h3,div[role="heading"],strong')]
        .find(h => /^(short videos|videos|images)$/i.test((h.innerText || '').trim()));
      if (stripHead) {
        stripHead.scrollIntoView({ block: 'center' });
        await sleep(700);
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);
  } catch (_) {}

  let extracted = await page.evaluate(extractSerp, { intent: options.intent });
  if (extracted.debug?.winner) console.log('[DIAG winner]', JSON.stringify(extracted.debug.winner));

  // Overview-first extraction — the combined wait resolves on the AI
  // Overview heading, which often renders BEFORE organic `a h3` anchors
  // stream in. Observed: overview present + 0 organic → accept() rejected
  // the result and the overview was discarded for Bing junk. Give organic
  // anchors a brief second chance, then merge.
  if (extracted.aiOverview && extracted.results.length === 0 && !extracted.blocked) {
    try {
      await page.waitForFunction(
        () => !!document.querySelector('a h3'),
        { timeout: 1500 }
      );
      const retry = await page.evaluate(extractSerp, { intent: options.intent });
      if (retry.results.length > 0) {
        extracted = { ...retry, aiOverview: retry.aiOverview || extracted.aiOverview };
      }
    } catch (_) { /* organic never rendered — keep the overview-only result */ }
  }

  // Consent-interstitial recovery — "Before you continue to Google" renders
  // on google.com itself (no redirect), so the launch-time warmup click
  // misses it when it re-appears mid-session. Click the consent control on
  // the live page, re-navigate, re-extract — once.
  if (extracted.blocked && extracted.blockReason === 'consent-interstitial') {
    try {
      const btn = page.locator(
        'button:has-text("Accept all"), button:has-text("I agree"), button:has-text("Accept"), ' +
        'button:has-text("Agree"), button:has-text("Alle akzeptieren"), button:has-text("Tout accepter"), ' +
        'button:has-text("Aceptar todo"), button:has-text("接受"), button:has-text("同意"), input[type="submit"]'
      ).first();
      if (await btn.count()) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        const retry = await page.evaluate(extractSerp, { intent: options.intent });
        if (retry.results.length > 0 || retry.aiOverview || !retry.blocked) {
          console.log('[google-serp] consent interstitial accepted — SERP recovered');
          extracted = retry;
        }
      }
    } catch (e) {
      console.log(`[google-serp] consent-interstitial recovery failed: ${e.message}`);
    }
  }

  // Empty-shell recovery — the SERP variant served to this engine rendered
  // nothing extractable. The basic-HTML SERP (gbv=1) always renders plain
  // result anchors; re-navigate once and re-extract before giving up.
  if (!extracted.blocked
      && extracted.results.length <= 1 && !extracted.aiOverview
      && (extracted.emptyShell || extracted.results.length === 0 || (extracted.rawText || '').length < 400)) {
    try {
      console.log(`[google-serp] thin extraction (n=${extracted.results.length}) — retrying with gbv=1 (title="${extracted.debug?.title || ''}")`);
      await page.goto(`${url}&gbv=1`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      const retry = await page.evaluate(extractSerp, { intent: options.intent });
      if (retry.results.length > 0 || retry.aiOverview || retry.blocked) extracted = retry;
    } catch (e) {
      console.log(`[google-serp] gbv=1 retry failed: ${e.message}`);
    }
  }

  if (extracted.blocked) {
    searchBrowser.markEngineBlocked('google', GOOGLE_BLOCK_COOLDOWN_MS);
    return { results: [], total: 0, provider: 'google-serp', blocked: extracted.blockReason, elapsedMs: Date.now() - startTime };
  }

  let results = extracted.results;

  // Post-extract partial — organic anchors often stream in after the
  // lite pass ran (wait resolves on the overview heading first). Emit
  // the extracted set now so consumers show cards/sources while the
  // isch recovery hop + URL unwrap are still working.
  if (typeof options.onPartial === 'function' && results.length) {
    try {
      const sh = new Set(), srcs = [];
      for (const r of results) {
        const host = r.displayDomain || (() => { try { return new URL(r.url || r.link || '').hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
        if (!host || host === 'google.com' || sh.has(host)) continue;
        sh.add(host);
        srcs.push({ url: r.url || r.link, hostname: host, title: r.title || '' });
      }
      options.onPartial({ items: results, sources: srcs, provider: 'google-serp' });
    } catch (_) {}
  }

  // Inline-first: the All tab's Images block is faster and better-looking than
  // a dedicated tbm=isch hop — but AI-Mode SERPs often ship no strip at all.
  // One recovery navigation only when inline extraction came up short.
  const intent = options.intent;
  if (intent === 'image'
      && results.filter(r => r.type === 'image').length < 3
      && !searchBrowser.paceExceeded('google')) {
    try {
      console.log(`[google-serp] image recovery — ${results.filter(r => r.type === 'image').length} inline images, trying tbm=isch`);
      // Second navigation costs ~1-2s — push what we have so cards show during it.
      if (typeof options.onPartial === 'function' && results.length) {
        try { options.onPartial({ items: results, provider: 'google-serp' }); } catch (_) {}
      }
      await page.goto(`${url}&tbm=isch`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForFunction(() => document.querySelectorAll('img').length > 10, { timeout: 2500 }).catch(() => {});
      const grid = await page.evaluate(extractImageGrid);
      const have = new Set(results.map(r => r.imageUrl || r.thumbnail || r.url));
      const fresh = grid.filter(g => !have.has(g.imageUrl || g.thumbnail || g.url));
      if (fresh.length) {
        console.log(`[google-serp] tbm=isch recovery: +${fresh.length} images`);
        results = [...fresh, ...results];
      }
    } catch (e) {
      console.log(`[google-serp] tbm=isch recovery failed: ${e.message}`);
    }
  }

  // Image intent: the All-tab Images strip extracts as photo-thumbed
  // web-results (anchors with h3) — retype thumbed items as 'image' so the
  // renderer gives them the media-card treatment, and rank them first.
  if (intent === 'image') {
    for (const r of results) {
      if (r.type === 'web-result' && (r.thumbnail || r.imageUrl)) r.type = 'image';
    }
    if (!results.some(r => r.type === 'image')) {
      console.log(`[google-serp] image intent but 0 images — headings: ${JSON.stringify(extracted.debug?.headings || [])}`);
      console.log(`[google-serp] img sizes: ${JSON.stringify(extracted.debug?.imgs || [])}`);
    }
    results = [...results.filter(r => r.type === 'image'), ...results.filter(r => r.type !== 'image')];
  }

  // Short-videos recovery — the heading can sit in the served DOM while the
  // carousel tiles lazy-mount unreliably in a minimized window. The Videos
  // tab is a server-rendered list: one hop when a video strip was implied
  // but nothing was extracted.
  if ((intent === 'video' || intent === 'image')
      && extracted.hasVideoHeading
      && results.filter(r => r.type === 'video').length < 2
      && !searchBrowser.paceExceeded('google')) {
    try {
      console.log(`[google-serp] video recovery — ${results.filter(r => r.type === 'video').length} inline videos, trying tbm=vid`);
      if (typeof options.onPartial === 'function' && results.length) {
        try { options.onPartial({ items: results, provider: 'google-serp' }); } catch (_) {}
      }
      await page.goto(`${url}&tbm=vid`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForFunction(() => document.querySelectorAll('a[href] img').length > 4, { timeout: 2500 }).catch(() => {});
      const vids = await page.evaluate(extractVideoList);
      console.log(`[google-serp] tbm=vid page: ${vids.length} rows (title="${await page.title().catch(() => '')}")`);
      const have = new Set(results.map(r => r.url));
      const fresh = vids.filter(v => !have.has(v.url)).slice(0, 6);
      if (fresh.length) {
        console.log(`[google-serp] tbm=vid recovery: +${fresh.length} videos`);
        results = [...results, ...fresh];
      }
    } catch (e) {
      console.log(`[google-serp] tbm=vid recovery failed: ${e.message}`);
    }
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

  // Fingerprint the page on total/near-total extraction failure — the next
  // log line tells us what Google actually served (consent text, JS-required
  // shell, bot wall) instead of a bare "empty results". n<=1 because a lone
  // raw-text fallback row also means the organic extraction missed.
  if (results.length <= 1 && !extracted.blocked && !extracted.aiOverview) {
    console.log(`[google-serp] 0 organic — title="${extracted.debug?.title || ''}" url=${(extracted.debug?.url || '').slice(0, 100)} body="${(extracted.debug?.bodyPeek || '').replace(/\s+/g, ' ').slice(0, 200)}" headings=${JSON.stringify((extracted.debug?.headings || []).slice(0, 12))}`);
  }

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
