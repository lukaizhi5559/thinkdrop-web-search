/**
 * bingCopilot.js — Bing Copilot Search ("AI Mode") via the hidden Playwright
 * Chrome. Primary provider for web/news intents: copilotsearch renders a
 * generated answer + cited source cards — a synthesized overview Google
 * frequently withholds from headless engines.
 *
 * Page mechanics (observed): the /copilotsearch shell embeds a lazy iframe
 * (bing.com/search?…&cpltsrchif=1&convid=…&convsig=…) that carries the
 * actual answer — the URL is signed per-session, so the shell must spawn
 * it; we force-load the iframe (loading=eager + scrollIntoView) and extract
 * inside it. Anonymous CfT gets the full answer — no sign-in required.
 *
 * The answer generates progressively, so the extractor polls the frame and
 * emits markdown deltas via options.onChunk — the caller can stream the
 * answer to the UI while it writes itself.
 */
import { searchBrowser } from '../services/searchBrowserDriver.js';
import { serpMarkdown } from './_serpMarkdown.js';

// Bing wraps outbound links as /ck/a?...&u=a1<base64url(target)> — decode
// locally, no request needed. Same helper as bingSerp.
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

/** In-frame snapshot: answer container text + source cards. Serialized into
 *  frame.evaluate — must stay dependency-free. */
function copilotSnapshot() {
  const seen = new Set();
  const sources = [];
  // Citation/source cards: .gs_cit_cont blocks wrap each cited page.
  for (const card of document.querySelectorAll('.gs_cit_cont, [class*="cit_cont"], .gs_cit')) {
    const a = card.querySelector('a[href]');
    if (!a) continue;
    const href = a.href || '';
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    const title = ((card.querySelector('.gs_cit_title, [class*="cit_title"], cite') || a).innerText
      || '').trim().split('\n')[0].trim();
    const snippet = ((card.querySelector('.gs_cit_text, [class*="cit_text"], [class*="snippet"]') || {}).innerText || '').trim();
    sources.push({ title: title.slice(0, 140), url: href, description: snippet.slice(0, 300) });
  }
  if (!sources.length) {
    for (const a of document.querySelectorAll('a[href^="http"], a[href^="/ck/"]')) {
      const href = a.href || '';
      if (seen.has(href)) continue;
      const t = (a.innerText || '').trim().split('\n')[0].trim();
      if (t.length < 8) continue;
      seen.add(href);
      sources.push({ title: t.slice(0, 140), url: href, description: '' });
      if (sources.length >= 10) break;
    }
  }

  // Answer container: .gs_multianshead_main holds the generated answer
  // (hero lead + structured body); .gs_ans_cont-style fallbacks, then the
  // widest text block outside a citation card.
  let container = document.querySelector('.gs_multianshead_main, .gs_ans_cont, #cplt_answer, [class*="ans_cont"]');
  if (!container) {
    let best = null, bestLen = 0;
    for (const el of document.querySelectorAll('main, section, article, div')) {
      if (el.closest('.gs_cit_cont')) continue;
      const t = (el.innerText || '').trim();
      if (t.length > bestLen && t.length < 12000) { best = el; bestLen = t.length; }
    }
    container = best;
  }
  return {
    answerLen: container ? (container.innerText || '').trim().length : 0,
    sources,
    bodyPeek: (document.body?.innerText || '').slice(0, 200),
  };
}

export async function searchBingCopilot(query, options = {}) {
  const startTime = Date.now();
  const maxResults = options.maxResults || 10;
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;
  const lang = (options.lang || 'en').replace(/[^a-zA-Z-]/g, '');
  const url = `https://www.bing.com/copilotsearch?q=${encodeURIComponent(query)}&setlang=${encodeURIComponent(lang)}`;

  if (searchBrowser.paceExceeded('bing')) {
    return { results: [], total: 0, provider: 'bing-copilot', pacedOut: true, elapsedMs: 0 };
  }
  if (searchBrowser.engineBlocked('bing')) {
    return { results: [], total: 0, provider: 'bing-copilot', blocked: 'cooldown', elapsedMs: 0 };
  }

  let page;
  try {
    page = await searchBrowser.navigate(url, { expectHost: 'bing.com' });
  } catch (err) {
    throw new Error(`bing-copilot navigation failed: ${err.message}`);
  }

  // The answer iframe is lazy: force it into view so the browser loads it.
  // One retry: stale profile state can leave the frame stuck on "Searching
  // for…" — a shell reload respawns it with a fresh convsig.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      console.log('[bing-copilot] frame stalled on generation — reloading shell');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (_) {}
    }
    const out = await extractAnswer(page, { onChunk, maxResults });
    if (out && (out.aiOverview || out.results.length)) {
      return { ...out, provider: 'bing-copilot', elapsedMs: Date.now() - startTime };
    }
    if (out?.blocked && out.blocked !== 'no-answer-frame') return out;
  }
  return { results: [], total: 0, provider: 'bing-copilot', elapsedMs: Date.now() - startTime };
}

/** Runs the iframe-force + poll loop against the current shell page.
 *  Returns the provider-shaped result, a {blocked} marker, or null when
 *  nothing generated (caller retries with a fresh shell). */
async function extractAnswer(page, { onChunk, maxResults }) {
  let frame = null;
  try {
    await page.waitForSelector('iframe', { timeout: 5000 });
    const force = () => page.evaluate(() => {
      for (const f of document.querySelectorAll('iframe')) {
        if (/cpltsrchif|\/search\?/.test(f.src)) {
          f.loading = 'eager';
          f.scrollIntoView({ block: 'center' });
        }
      }
    }).catch(() => {});
    await force();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      frame = page.frames().find(f => /bing\.com\/search.*cpltsrchif/.test(f.url()));
      if (frame) break;
      // Frame may attach under a slightly different URL (locale params) —
      // accept any bing.com/search iframe that's not the shell itself.
      frame = page.frames().find(f =>
        f !== page.mainFrame() && /bing\.com/.test(f.url()) && /\/search/.test(f.url()) && f.url().length > 60);
      if (frame) break;
      await page.waitForTimeout(300);
      await force();
    }
  } catch (_) { /* shell never produced the iframe */ }

  if (!frame) {
    // Fingerprint the shell — what did copilotsearch actually serve?
    const diag = await page.evaluate(() => ({
      title: document.title,
      url: location.href.slice(0, 120),
      iframes: [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 100) || '(no-src)'),
      body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
    })).catch(e => ({ evalErr: e.message }));
    console.log(`[bing-copilot] no-answer-frame — title="${diag.title}" url=${diag.url} iframes=${JSON.stringify(diag.iframes || diag.evalErr)} body="${diag.body || ''}"`);
    return { results: [], total: 0, provider: 'bing-copilot', blocked: 'no-answer-frame' };
  }

  const POLL_MS = 400;
  const STABLE_MS = 2500;   // answer unchanged this long → generation done
  const BUDGET_MS = 15000;  // hard cap — fall back past this
  const STALL_MS = 8000;    // empty answer this long after attach → stalled frame
  const frameAt = Date.now();
  // The walker is embedded per-poll — stateless, immune to frame reloads.
  // CDP evaluate is not subject to the page's CSP eval restrictions.
  const pollSrc = `(() => {
    const snap = (${copilotSnapshot.toString()})();
    let container = document.querySelector('.gs_multianshead_main, .gs_ans_cont, #cplt_answer, [class*="ans_cont"]');
    if (!container) {
      let best = null, bestLen = 0;
      for (const el of document.querySelectorAll('main, section, article, div')) {
        if (el.closest('.gs_cit_cont')) continue;
        const t = (el.innerText || '').trim();
        if (t.length > bestLen && t.length < 12000) { best = el; bestLen = t.length; }
      }
      container = best;
    }
    let answerMd = '';
    if (container) {
      // The generated answer is exactly two children: .gs_heroTextHeader
      // (lead) + .gs_text (structured body). Status rows ("Searching for…",
      // "Reading sources…"), the source-name list and citation cards are
      // siblings — build from the two answer nodes so they never leak in.
      const parts = container.matches('.gs_multianshead_main, .gs_ans_cont, #cplt_answer, [class*="ans_cont"]')
        ? [...container.querySelectorAll(':scope > .gs_heroTextHeader, :scope > .gs_text, .gs_heroTextHeader, .gs_text.gs_mdr')]
        : [container];
      const targets = parts.length ? parts : [container];
      // Mark hidden elements on the LIVE tree — innerText skips them but
      // textContent (what the walker sees) doesn't, so hidden token/aria
      // copies explode into duplicate lines. getComputedStyle only works on
      // the live DOM, so flag first, then strip the flags in the clone.
      for (const el of container.querySelectorAll('*')) {
        try {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') {
            el.setAttribute('data-serp-hide', '1');
          }
        } catch (_) {}
      }
      const mds = [];
      for (const t of targets) {
        const clone = t.cloneNode(true);
        for (const el of clone.querySelectorAll('[data-serp-hide="1"]')) el.remove();
        // Citation chips + aria-hidden SR copies — junk by class.
        for (const el of clone.querySelectorAll('[aria-hidden="true"], .gs_sup_cit, .gs_sm_cit, [class*="sup_cit"], [aria-label*="View source"], [aria-label*="citation"]')) el.remove();
        // Token-replay list items — li.gs_tkn carrying a bare word render
        // the typing animation; real bullets have a .gs_p body inside.
        for (const li of clone.querySelectorAll('li.gs_tkn')) {
          if (!li.querySelector('.gs_p')) li.remove();
        }
        const junkRe = /^(searching for|reading sources|summarizing results|almost there|generating)/i;
        const srcCountRe = /^\d+\s+sources?$/i;
        for (const el of clone.querySelectorAll('*')) {
          const tx = (el.innerText || '').trim();
          if (!tx || tx.length > 120) continue;
          if (srcCountRe.test(tx) || (junkRe.test(tx) && el.childElementCount <= 2)) el.remove();
        }
        let m = ((${serpMarkdown.toString()})(clone, 'bing\\\\.com$|microsoft\\\\.com$|msn\\\\.com$'))
          || (clone.innerText || '').trim();
        // Bing token spans glue words after closing bold runs — pad ONLY a
        // closing '**' followed by a word char (opening markers must not get
        // a leading space or the bold fails to parse and shows literally).
        m = m.replace(/(\\S)\\*\\*(?=\\S)/g, '$1** ');
        // Copilot's "Search results" appendix (organic cards) can leak in
        // via the container — drop it; sources come from the citation cards.
        m = m.replace(/\\n[ \\t]*#{0,6}[ \\t]*\\**[ \\t]*search results\\b[\\s\\S]*$/im, '');
        // "- N Sources" chip rows that survived the DOM strip.
        m = m.replace(/^[ \\t]*[-*•]?[ \\t]*\\d+[ \\t]+sources?[.\\s]*$/gim, '');
        // Token replay drops the space before punctuation too — "levels ,"
        // "standards ." → tighten (but not inside inline-code).
        m = m.replace(/ +([.,;:])/g, '$1');
        if (m) mds.push(m);
      }
      answerMd = mds.join('\\n\\n');
    }
    snap.answerMd = answerMd;
    return snap;
  })()`;
  let lastText = '';
  let lastChangeAt = Date.now();
  let snap = {};
  const deadline = Date.now() + BUDGET_MS;

  while (Date.now() < deadline) {
    try {
      snap = await frame.evaluate(pollSrc);
      const cur = snap.answerMd || '';
      if (cur !== lastText) {
        if (onChunk && cur.length > lastText.length && cur.startsWith(lastText)) {
          onChunk(cur.slice(lastText.length));
        } else if (onChunk && !lastText && cur) {
          onChunk(cur);
        }
        lastText = cur;
        lastChangeAt = Date.now();
      }
      // Stalled generation: frame attached but the answer never started
      // (status text only) — bail early so the shell-reload retry respawns
      // a fresh frame instead of burning the whole budget.
      if (!cur && Date.now() - frameAt > STALL_MS) return null;
      const quiet = Date.now() - lastChangeAt;
      // Done: stable text ending on terminal punctuation AND citation cards
      // arrived (they render last), or a long quiet stretch when no cards
      // ever come. The `complete` check stops mid-sentence clips when
      // generation pauses between sections.
      const complete = /[.!?…\)"'\]:]$/.test(cur.trim());
      if (cur.length > 60 && (((snap.sources || []).length > 0 && complete && quiet > STABLE_MS) || quiet > 8000)) break;
    } catch (_) { /* frame navigating mid-generation — retry next tick */ }
    await page.waitForTimeout(POLL_MS);
  }

  const answer = (snap.answerMd || lastText || '').trim();
  let results = (snap.sources || []).map(r => ({ ...r, url: unwrapBingUrl(r.url) }));

  if (!answer && results.length === 0) {
    console.log(`[bing-copilot] no answer extracted — frame url=${frame.url().slice(0, 140)} body="${(snap.bodyPeek || '').replace(/\s+/g, ' ')}"`);
    return null; // caller retries once with a reloaded shell
  }

  results = results.slice(0, maxResults).map((r, i) => ({
    ...r, source: 'Bing Copilot', relevanceScore: 0.88 - (i * 0.04)
  }));

  return { results, aiOverview: answer || null, total: results.length };
}
