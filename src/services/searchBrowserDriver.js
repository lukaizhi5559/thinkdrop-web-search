/**
 * searchBrowserDriver.js — Hidden Chrome search-worker.
 *
 * Owns the Playwright lifecycle for free SERP-based web search:
 *   - Launches REAL Google Chrome (`channel: 'chrome'`) in headed mode,
 *     sized 1×1 and minimized — identical to the hidden-headed pattern in
 *     voice-service/src/companion-driver.cjs and command-service's
 *     browser-engine.cjs. Headed+minimized is used instead of --headless
 *     because headless Chrome is trivially fingerprinted by search engines.
 *   - ONE tab is kept alive and reused per query; navigations are
 *     serialized through a promise queue.
 *   - Human-pacing guard: enforces a minimum inter-navigation interval
 *     with jitter and a rolling per-minute budget. When the pace would
 *     look non-human, callers are told to defer/fallback rather than
 *     trigger a "unusual traffic" /sorry page.
 */

import { chromium } from 'playwright';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

const execFileP = promisify(execFile);

// DYLD_INSERT_LIBRARIES payload: flips the app to .accessory activation policy
// so agent-launched CfT registers as UIElement — no Dock icon. (LSUIElement in
// Info.plist was tried first: it makes Chromium crash on icudtl load.)
const HIDE_DOCK_DYLIB = path.join(os.homedir(), '.thinkdrop', 'lib', 'hide-dock.dylib');
const HIDE_DOCK_SRC = `#import <Cocoa/Cocoa.h>
__attribute__((constructor)) static void _td_hide(void) {
  void (^acc)(void) = ^{ [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory]; };
  dispatch_async(dispatch_get_main_queue(), acc);
  for (int i = 1; i <= 20; i++)
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(i * 0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), acc);
}
`;

// Deliberately OUTSIDE ~/.thinkdrop/browser-profiles/ — command-service's
// forceKillPlaywright() pkills 'Google Chrome.*browser-profiles' at every boot
// AND on every /automation.cancel, and its session-scoped cleaners scan that
// dir. A persistent search worker is not automation; isolating the profile
// keeps those lifecycle sweeps from killing it mid-search.
const PROFILE_DIR = path.join(os.homedir(), '.thinkdrop', 'search-browser');

// Hidden-window args. IMPORTANT: a real window size, not 1×1 — innerWidth=1
// is a top Google bot-detection signal. The window hides via offscreen
// position + CDP minimize instead, so JS sees a normal geometry.
const HIDDEN_ARGS = [
  '--window-size=1366,900',
  '--window-position=-32000,-32000',
  '--window-workspace=-32000',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-component-update',
  // A killed session shows a "didn't shut down correctly" restore bubble —
  // which resurrects the minimized window onto the screen.
  '--hide-crash-restore-bubble',
  '--disable-session-crashed-bubble',
];

// Human-pacing: a person googles maybe 20–100×/day with minutes between.
// Agents can burst — throttle so we never look like "unusual traffic".
const MIN_INTERVAL_MS = parseInt(process.env.SEARCH_MIN_INTERVAL_MS) || 1800;
const INTERVAL_JITTER_MS = 900;
const MAX_QUERIES_PER_MINUTE = parseInt(process.env.SEARCH_MAX_QPM) || 12;
const NAV_TIMEOUT_MS = parseInt(process.env.SEARCH_NAV_TIMEOUT_MS) || 15000;
const RELAUNCH_COOLDOWN_MS = 60 * 1000;

class SearchBrowserDriver extends EventEmitter {
  constructor() {
    super();
    this.context = null;
    this.page = null;
    this.starting = false;
    this._queue = Promise.resolve();
    this._lastNavAt = 0;
    this._queryTimes = [];
    this._relaunchBlockedUntil = 0;
    this._status = 'closed';
    this.engine = null;        // 'chrome' | 'cft'
    this._launchedAt = 0;
    this._forceCft = false;    // set when real Chrome gets absorbed by a running instance
    this._hideDylib = undefined; // undefined=not attempted, null=build failed, string=ready
    this._engineBlockedUntil = new Map(); // engine -> timestamp: skip navs to a blocking engine instead of paying a timeout per query
    // Survive nodemon/service restarts — otherwise every restart pays one
    // dead Google nav before the cooldown is re-learned.
    try {
      const f = path.join(PROFILE_DIR, 'engine-blocks.json');
      if (fs.existsSync(f)) {
        for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8'))))
          if (v > Date.now()) this._engineBlockedUntil.set(k, v);
      }
    } catch (_) {}
  }

  /** Skip an engine for `ms` after a sorry/captcha/signin detection. */
  markEngineBlocked(engine, ms) {
    this._engineBlockedUntil.set(engine, Date.now() + ms);
    try {
      const f = path.join(PROFILE_DIR, 'engine-blocks.json');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(Object.fromEntries(this._engineBlockedUntil)));
    } catch (_) {}
  }

  engineBlocked(engine) {
    return Date.now() < (this._engineBlockedUntil.get(engine) || 0);
  }

  get running() {
    return !!(this.context && this.page && !this.page.isClosed());
  }

  status() {
    if (this.starting) return 'starting';
    if (this.running) return 'ready';
    return this._status;
  }

  _setStatus(s) {
    if (this._status !== s) {
      this._status = s;
      this.emit('state', s);
    }
  }

  /** Park the window in the Dock — macOS clamps offscreen positions. */
  async _hideWindow() {
    if (!this.page || this.page.isClosed()) return;
    try {
      const cdp = await this.context.newCDPSession(this.page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } catch (err) {
      console.warn('[SearchBrowser] window minimize failed (non-fatal):', err.message);
    }
  }

  async start() {
    if (this.running) {
      await this._hideWindow();
      return { ok: true, reused: true };
    }
    if (this.starting) {
      // A launch/relaunch is in flight — callers should wait for it rather
      // than fail (navigate() awaits this promise via _startPromise).
      return this._startPromise || { ok: false, reason: 'already-starting' };
    }
    if (Date.now() < this._relaunchBlockedUntil) {
      return { ok: false, reason: 'relaunch-cooldown' };
    }
    this.starting = true;
    this._startPromise = this._doStart();
    try { return await this._startPromise; }
    finally { this._startPromise = null; }
  }

  /**
   * On macOS a second real-Chrome launch is absorbed by the running instance
   * ("Opening in existing browser session" — or worse, a context that launches
   * then dies seconds later). Detect a running user Chrome up front and go
   * straight to bundled CfT instead of launching a doomed one.
   */
  _userChromeRunning() {
    return new Promise((resolve) => {
      if (process.platform !== 'darwin') return resolve(false);
      execFile('pgrep', ['-x', 'Google Chrome'], (err, stdout) => {
        resolve(!err && !!stdout.trim());
      });
    });
  }

  /**
   * Build the hide-dock dylib once (clang ships with Xcode CLT). Returns the
   * dylib path, or null when the build isn't possible — the browser then just
   * launches with a Dock icon, functionality unaffected.
   */
  async _ensureHideDockDylib() {
    if (process.platform !== 'darwin') return null;
    if (this._hideDylib !== undefined) return this._hideDylib;
    try {
      if (!fs.existsSync(HIDE_DOCK_DYLIB)) {
        fs.mkdirSync(path.dirname(HIDE_DOCK_DYLIB), { recursive: true });
        const src = HIDE_DOCK_DYLIB.replace(/\.dylib$/, '.m');
        fs.writeFileSync(src, HIDE_DOCK_SRC);
        await execFileP('clang', ['-dynamiclib', '-framework', 'Cocoa', '-arch', 'arm64', src, '-o', HIDE_DOCK_DYLIB]);
        fs.unlinkSync(src);
        console.log('[SearchBrowser] built hide-dock dylib → no Dock icon for CfT launches');
      }
      this._hideDylib = HIDE_DOCK_DYLIB;
    } catch (err) {
      console.warn('[SearchBrowser] hide-dock dylib build failed (non-fatal):', err.message);
      this._hideDylib = null;
    }
    return this._hideDylib;
  }

  async _doStart() {
    this._setStatus('starting');
    if (!this._forceCft && await this._userChromeRunning()) {
      console.warn('[SearchBrowser] user Chrome already running — launching bundled CfT (real Chrome would be absorbed)');
      this._forceCft = true;
    }
    const useCft = this._forceCft;
    const engine = useCft ? 'cft' : 'chrome';
    try {
      // channel:'chrome' = real Google Chrome (warm profile, least bot-like).
      // Fallback: bundled Chrome for Testing — macOS absorbs a second real-
      // Chrome launch into the user's running instance (see browser-engine.cjs
      // in command-service). If our context dies within 5s of launch, assume
      // absorption and retry once with CfT.
      const hideDylib = useCft ? await this._ensureHideDockDylib() : null;
      this.context = await chromium.launchPersistentContext(PROFILE_DIR + (useCft ? '-cft' : ''), {
        ...(useCft ? {} : { channel: 'chrome' }),
        ...(hideDylib ? { env: { ...process.env, DYLD_INSERT_LIBRARIES: hideDylib } } : {}),
        headless: false,
        viewport: { width: 1280, height: 800 },
        // --enable-unsafe-swiftshader makes WebGL report a software rasterizer
        // (SwiftShader) — a classic datacenter/bot tell. Real GPU instead.
        ignoreDefaultArgs: ['--enable-automation', '--enable-unsafe-swiftshader'],
        args: HIDDEN_ARGS,
      });
      this.engine = engine;
      this._launchedAt = Date.now();
      const browser = this.context.browser();
      if (browser) {
        browser.on('disconnected', () => {
          console.warn('[SearchBrowser] Chrome disconnected');
          this._cleanup('degraded');
          // macOS can absorb the hidden instance at ANY point (context returns
          // healthy, then the OS merges it into the running Chrome seconds
          // later) — a launch-timing heuristic misses it. Any real-Chrome
          // disconnect retries once on bundled CfT.
          if (this.engine === 'chrome' && !this._forceCft) {
            console.warn('[SearchBrowser] real Chrome disconnected — retrying with bundled CfT');
            this._forceCft = true;
            this._relaunchBlockedUntil = 0;
            this.start().catch(() => {});
          }
        });
      }
      this.page = this.context.pages()[0] || (await this.context.newPage());
      this.page.on('crash', () => {
        console.warn('[SearchBrowser] page crashed');
        this._cleanup('degraded');
      });
      this.page.on('close', () => {
        console.warn('[SearchBrowser] page closed');
        this._cleanup('degraded');
      });
      // Warm the profile with a plain google.com visit — seeds cookies and a
      // history entry so subsequent searches don't arrive as a day-zero
      // identity. If a consent interstitial renders, best-effort accept.
      try {
        await this.page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
        const consentBtn = this.page.locator(
          'button:has-text("Accept all"), button:has-text("I agree"), button:has-text("Accept"), ' +
          'button:has-text("Alle akzeptieren"), button:has-text("Tout accepter"), button:has-text("Aceptar todo"), ' +
          'button:has-text("接受"), button:has-text("同意")'
        ).first();
        if (await consentBtn.count()) {
          await consentBtn.click({ timeout: 2000 }).catch(() => {});
          console.log('[SearchBrowser] consent interstitial accepted');
        }
      } catch (err) {
        console.warn('[SearchBrowser] warmup nav failed (non-fatal):', err.message);
      }
      await this._hideWindow();
      this._setStatus('ready');
      console.log(`[SearchBrowser] Hidden Chrome search worker launched (engine: ${this.engine})`);
      return { ok: true, reused: false };
    } catch (err) {
      console.error('[SearchBrowser] launch failed:', err.message);
      this._cleanup('degraded');
      // Chrome not installed, OR launch threw "Opening in existing browser
      // session" / profile-lock (macOS absorption surfacing at launch time —
      // same pattern browser-engine.cjs:325 catches) → retry once on CfT.
      if (!useCft) {
        this._forceCft = true;
        this.starting = false;
        return this.start();
      }
      this._relaunchBlockedUntil = Date.now() + RELAUNCH_COOLDOWN_MS;
      return { ok: false, reason: err.message };
    } finally {
      this.starting = false;
    }
  }

  _cleanup(status = 'closed') {
    this.context = null;
    this.page = null;
    this._setStatus(status);
  }

  /**
   * Would navigating now exceed a human-plausible pace?
   * Returns true when the caller should fall back instead of hitting the engine.
   */
  paceExceeded(engine = 'google') {
    const now = Date.now();
    this._queryTimes = this._queryTimes.filter(t => now - t < 60000);
    return this._queryTimes.length >= MAX_QUERIES_PER_MINUTE;
  }

  /** Serialize + pace a navigation; returns the shared page for extraction. */
  async navigate(url, { waitUntil = 'domcontentloaded', expectHost = null } = {}) {
    const run = this._queue.then(async () => {
      if (!this.running) {
        const res = await this.start();
        if (!res.ok) throw new Error(`search browser unavailable: ${res.reason}`);
      }
      // Pace: wait out the minimum interval since last navigation.
      const elapsed = Date.now() - this._lastNavAt;
      const wait = MIN_INTERVAL_MS + Math.random() * INTERVAL_JITTER_MS - elapsed;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      this._lastNavAt = Date.now();
      this._queryTimes.push(this._lastNavAt);
      await this.page.goto(url, { waitUntil, timeout: NAV_TIMEOUT_MS });
      // Guard: a goto can resolve while the tab is actually on another site
      // (stuck sign-in flow, aborted redirect) — extractors would then scrape
      // junk and CACHE it under the wrong provider name.
      if (expectHost) {
        const landed = this.page.url();
        const host = new URL(landed).hostname;
        if (!host.endsWith(expectHost))
          throw new Error(`landed off-engine: expected ${expectHost}, got ${landed.slice(0, 140)}`);
      }
      await this._hideWindow(); // re-park in case window was restored
      return this.page;
    });
    this._queue = run.catch(() => {});
    return run;
  }

  async close() {
    try { if (this.context) await this.context.close(); } catch (_) {}
    this._cleanup('closed');
  }
}

export const searchBrowser = new SearchBrowserDriver();
export { PROFILE_DIR };
