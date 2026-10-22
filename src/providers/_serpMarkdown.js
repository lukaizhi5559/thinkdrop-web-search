/**
 * _serpMarkdown.js — shared DOM→markdown walker for SERP answer blocks
 * (Google AI Overview, Bing answer box, Bing Copilot search).
 *
 * Runs INSIDE page.evaluate — must stay dependency-free: no imports, no
 * closure references. Inject it by serializing the function:
 *
 *   import { serpMarkdown } from './_serpMarkdown.js';
 *   const md = await page.evaluate(
 *     `(${serpMarkdown.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(hostRe)})`
 *   );
 *
 * @param {Element} root        - answer container element
 * @param {string} [internalRe] - regex source for host-internal hrefs to
 *                              de-link (e.g. "google\\.com$", "bing\\.com$")
 * @returns {string} markdown
 */
export function serpMarkdown(root, internalRe = null) {
  if (!root || !root.querySelectorAll) return '';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME', 'BUTTON', 'SELECT', 'INPUT', 'TEXTAREA', 'FORM', 'AUDIO', 'VIDEO', 'TEMPLATE', 'NAV']);
  const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'HR', 'DL', 'DT', 'DD', 'FIGURE', 'DETAILS', 'SUMMARY']);
  // UI chrome by behavior, not wording — share sheets, feedback rows, tab
  // bars, and sr-only a11y text are pruned whatever labels engines give them.
  const CHROME_ROLES = new Set(['button', 'menu', 'menubar', 'menuitem',
    'tooltip', 'status', 'alert', 'dialog', 'navigation', 'complementary',
    'tab', 'tablist', 'banner', 'contentinfo', 'search', 'form']);
  const isChrome = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const role = el.getAttribute('role');
    if (role && CHROME_ROLES.has(role)) return true;
    if (el.hasAttribute('aria-live')) return true;
    if ((el.offsetWidth || 0) <= 1 && (el.offsetHeight || 0) <= 1) return true;
    return false;
  };
  const internal = internalRe ? new RegExp(internalRe, 'i') : null;
  const isInternal = (u) => {
    if (!u || !/^https?:/i.test(u)) return true;
    if (!internal) return false;
    try { return internal.test(new URL(u).hostname); } catch (_) { return true; }
  };
  const mdInline = (node) => {
    let s = '';
    for (const c of node.childNodes || []) {
      if (c.nodeType === 3) { s += c.nodeValue; continue; }
      if (c.nodeType !== 1 || SKIP.has(c.tagName) || isChrome(c)) continue;
      const t = (c.textContent || '').trim();
      if (!t) continue;
      if (/^\+\d{1,2}$/.test(t)) { s += ` [${t.slice(1)}]`; continue; }
      if (c.tagName === 'SUP' && /^\[?\d{1,2}\]?$/.test(t)) { s += ` [${t.replace(/\D/g, '')}]`; continue; }
      if (c.tagName === 'BR') { s += '  \n'; continue; }
      if (c.tagName === 'A') {
        const href = c.href || '';
        const label = mdInline(c).trim() || t;
        s += (href && /^https?:/.test(href) && !isInternal(href)) ? ` [${label}](${href})` : ` ${label}`;
        continue;
      }
      if (c.tagName === 'STRONG' || c.tagName === 'B') { s += ` **${mdInline(c).trim() || t}**`; continue; }
      if (c.tagName === 'EM' || c.tagName === 'I') { s += ` *${mdInline(c).trim() || t}*`; continue; }
      if (c.tagName === 'CODE') { s += ` \`${t}\``; continue; }
      s += mdInline(c);
    }
    return s;
  };
  const mdItem = (li) => {
    const parts = [];
    let nested = '';
    for (const c of li.childNodes || []) {
      if (c.nodeType === 3) parts.push(c.nodeValue);
      else if (c.nodeType === 1 && !SKIP.has(c.tagName) && !isChrome(c)) {
        if (c.tagName === 'UL' || c.tagName === 'OL') {
          const items = [...c.children].filter(x => x.tagName === 'LI');
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
      if (c.nodeType === 3) direct.push(c.nodeValue);
      else if (c.nodeType === 1 && !SKIP.has(c.tagName) && !BLOCK.has(c.tagName) && !isChrome(c)) direct.push(mdInline(c));
    }
    const lead = direct.join('').replace(/\s+/g, ' ').trim();
    if (lead) out += lead + '\n\n';
    for (const c of el.children || []) {
      const tag = c.tagName;
      if (SKIP.has(tag) || isChrome(c) || !(c.textContent || '').trim()) continue;
      if (/^H[1-6]$/.test(tag)) { const t = mdInline(c).trim(); if (t) out += `${'#'.repeat(+tag[1])} ${t}\n\n`; continue; }
      if (tag === 'UL' || tag === 'OL') {
        const items = [...c.children].filter(li => li.tagName === 'LI');
        if (items.length) out += items.map((li, i) => `${tag === 'OL' ? `${i + 1}.` : '-'} ${mdItem(li)}`).join('\n') + '\n\n';
        continue;
      }
      if (tag === 'TABLE') { out += mdTable(c); continue; }
      if (tag === 'BLOCKQUOTE') { const t = mdInline(c).trim(); if (t) out += `> ${t}\n\n`; continue; }
      if (tag === 'PRE') { out += '```\n' + (c.textContent || '').trim() + '\n```\n\n'; continue; }
      if (tag === 'HR') { out += '---\n\n'; continue; }
      if (BLOCK.has(tag)) { out += mdBlocks(c); continue; }
      // Non-block inline children were already collected into `lead` above —
      // emitting them again here explodes token spans into one line each.
    }
    return out;
  };
  return mdBlocks(root).replace(/\n{3,}/g, '\n\n').trim();
}
