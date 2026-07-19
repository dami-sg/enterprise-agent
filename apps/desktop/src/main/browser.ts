/**
 * Embedded browser (desktop-app §browser): tabbed `WebContentsView`s composited
 * over the main window, on a PERSISTENT session partition so manual logins /
 * cookies survive restarts and stay isolated from the app's default session.
 *
 * A `WebContentsView` is a native layer the main process paints OVER the React
 * DOM — the renderer only draws the chrome and reports the content-region bounds
 * (`setBounds`) + when to `show`/`hide`. The automation primitives (read → refs →
 * act, screenshot) are centralized here so all `webContents`/CDP access lives in
 * one place; the MCP server (browser-mcp.ts) is a thin front over these.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebContentsView, session, type BaseWindow, type WebContents } from 'electron';
import type { BrowserState, BrowserTab, OverlayItem, Rect } from '../shared/ipc.js';

/** `persist:` prefix → on-disk cookie/localStorage persistence. */
const PARTITION = 'persist:browser';
const BLANK = 'about:blank';

/** Self-contained page for the floating activity overlay view. `window.__eaOverlay`
 *  re-renders it from (title, items, notice) pushed via executeJavaScript. The
 *  optional notice is a prominent amber banner used to tell the user an approval
 *  is waiting back in the main chat window (else they'd never see it here and the
 *  turn would appear stuck). Transparent body so only the rounded card paints. */
const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}
html,body{height:100%;background:transparent}
body{font:12px -apple-system,system-ui,"PingFang SC",sans-serif;color:#e5e7eb;overflow:hidden}
#c{height:100%;display:flex;flex-direction:column;background:rgba(24,24,27,.97);border:1px solid rgba(255,255,255,.10);border-radius:12px;overflow:hidden}
.nz{display:none;gap:8px;align-items:center;padding:9px 12px;background:rgba(245,158,11,.16);border-bottom:1px solid rgba(245,158,11,.35);color:#fcd34d;font-weight:600;line-height:1.35;animation:pulse 1.6s ease-in-out infinite}
.nz b{flex:none}
@keyframes pulse{0%,100%{background:rgba(245,158,11,.16)}50%{background:rgba(245,158,11,.30)}}
.h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.08);font-weight:600}
.sp{width:12px;height:12px;flex:none;border:2px solid #a1a1aa;border-top-color:transparent;border-radius:50%;animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
ul{list-style:none;padding:5px 8px;overflow:auto;flex:1}
li{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:6px;line-height:1.4}
.i{width:12px;flex:none;text-align:center}
.ok{color:#4ade80}.err{color:#f87171}.run{color:#a1a1aa}
.n{font-weight:600;flex:none}
.d{color:#a1a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
</style></head><body><div id="c"><div id="nz" class="nz"><b>⚠</b><span id="nzt"></span></div><div class="h"><span class="sp"></span><span id="t"></span></div><ul id="l"></ul></div>
<script>window.__eaOverlay=function(title,items,notice){
document.getElementById('t').textContent=title;
var nz=document.getElementById('nz');
if(notice){document.getElementById('nzt').textContent=notice;nz.style.display='flex';}else{nz.style.display='none';}
var l=document.getElementById('l');l.textContent='';
items.forEach(function(a){
var li=document.createElement('li');
var i=document.createElement('span');i.className='i '+(a.status==='done'?'ok':a.status==='error'?'err':'run');
i.textContent=a.status==='done'?'✓':a.status==='error'?'!':'…';li.appendChild(i);
var n=document.createElement('span');n.className='n';n.textContent=a.name;li.appendChild(n);
if(a.detail){var d=document.createElement('span');d.className='d';d.title=a.detail;d.textContent=a.detail;li.appendChild(d);}
l.appendChild(li);});};</script></body></html>`;

/** Injected into a tab's main world: assigns integer refs to visible interactive
 *  elements (stored on `window.__eaRefs`), returns an accessibility-style list,
 *  and installs `window.__eaFind`. The read→refs→act loop references these. */
const REF_WALKER = String.raw`(() => {
  const refs = {}; let n = 0; const out = [];
  const interactive = (el) => {
    const t = el.tagName.toLowerCase();
    if (['a','button','input','textarea','select'].includes(t)) return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (role && ['button','link','checkbox','tab','menuitem','textbox','switch','radio'].includes(role)) return true;
    return !!(el.hasAttribute && el.hasAttribute('onclick'));
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const label = (el) => {
    const t = el.tagName.toLowerCase();
    const base = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title'));
    const text = (base || el.innerText || el.value || (t === 'input' ? el.type : '') || '').toString();
    return text.replace(/\s+/g, ' ').trim().slice(0, 120);
  };
  const walk = (el) => {
    if (!(el instanceof Element)) return;
    if (visible(el) && interactive(el)) {
      const ref = ++n; refs[ref] = el;
      out.push('[ref_' + ref + '] ' + el.tagName.toLowerCase() + (el.type ? ('#' + el.type) : '') + ' "' + label(el) + '"');
    }
    for (const c of el.children) walk(c);
  };
  try { walk(document.body); } catch (e) {}
  window.__eaRefs = refs;
  window.__eaFind = (q) => {
    q = String(q).toLowerCase(); const hits = [];
    for (const k of Object.keys(refs)) { const l = label(refs[k]); if (l.toLowerCase().includes(q)) hits.push('[ref_' + k + '] ' + l); }
    return hits.join('\n') || '(no matches)';
  };
  return 'URL: ' + location.href + '\nTITLE: ' + document.title + '\n\nInteractive elements (act on a [ref_N] with click/type):\n' + (out.join('\n') || '(none found)');
})()`;

interface Tab {
  id: string;
  view: WebContentsView;
  title: string;
  url: string;
  favicon?: string;
  loading: boolean;
  cdp: boolean;
  /** Trusted local-file tab (artifact preview) — allowed to load `file://`,
   *  which is otherwise blocked for model/page navigation. */
  trustFile?: boolean;
}

export interface BrowserDeps {
  /** The current main window (re-created on activate) — resolved lazily so the
   *  browser re-attaches to whichever window is live. */
  getWindow: () => BaseWindow | undefined;
  send: (channel: string, payload: unknown) => void;
}

export class BrowserManager {
  private readonly tabs = new Map<string, Tab>();
  private order: string[] = [];
  private activeId?: string;
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  private readonly ses = session.fromPartition(PARTITION);
  private stateTimer?: ReturnType<typeof setTimeout>;
  // Floating activity overlay — a SEPARATE WebContentsView stacked on top of the
  // page view (a plain DOM element can't float over a native view), sized to just
  // the card at the bottom-right corner so it doesn't reserve a band.
  private overlay?: WebContentsView;
  private overlayLoaded = false;
  private overlayVisible = false;
  private overlayTitle = '';
  private overlayItems: OverlayItem[] = [];
  private overlayNotice = '';

  constructor(private readonly deps: BrowserDeps) {
    // Untrusted pages render on this session — powerful permissions (camera,
    // mic, geolocation, notifications…) are denied outright; Electron has no
    // built-in prompt UI, so the default would be silently permissive.
    const benign = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);
    this.ses.setPermissionRequestHandler((_wc, permission, callback) => callback(benign.has(permission)));
  }

  // -- state ---------------------------------------------------------------

  state(): BrowserState {
    return { tabs: this.order.map((id) => this.toTab(this.tabs.get(id)!)), activeTabId: this.activeId };
  }

  private toTab(t: Tab): BrowserTab {
    const wc = t.view.webContents;
    return {
      id: t.id,
      title: t.title || t.url || 'New Tab',
      url: t.url,
      favicon: t.favicon,
      loading: t.loading,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  private pushState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.deps.send('browser:state', this.state());
    }, 40);
  }

  // -- tab lifecycle -------------------------------------------------------

  private spawn(trustFile: boolean): Tab {
    const id = randomUUID();
    const view = new WebContentsView({
      webPreferences: { session: this.ses, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    // Keep rendering while parked off-screen (hidden) so capturePage works and
    // background automation isn't throttled to a crawl.
    view.webContents.setBackgroundThrottling(false);
    const tab: Tab = { id, view, title: '', url: '', loading: false, cdp: false, trustFile };
    this.tabs.set(id, tab);
    this.order.push(id);
    this.wire(tab);
    this.activeId = id;
    this.layout();
    return tab;
  }

  newTab(url?: string): string {
    const tab = this.spawn(false);
    tab.url = url ?? '';
    void tab.view.webContents.loadURL(this.normalize(url) ?? BLANK).catch(() => {});
    this.pushState();
    return tab.id;
  }

  /** Open a trusted local file (an artifact) in a new tab — file:// is otherwise
   *  blocked. Chromium renders HTML / PDF / images natively. */
  previewFile(absPath: string): string {
    const tab = this.spawn(true);
    const url = absPath.startsWith('file:') ? absPath : pathToFileURL(absPath).href;
    void tab.view.webContents.loadURL(url).catch(() => {});
    this.pushState();
    return tab.id;
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    const sync = (): void => {
      tab.url = wc.getURL();
      this.pushState();
    };
    wc.on('did-navigate', sync);
    wc.on('did-navigate-in-page', sync);
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this.pushState();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons[0];
      this.pushState();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.pushState();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      sync();
    });
    // Navigation policy: only http(s)/about; block file:// and other schemes —
    // except a trusted artifact-preview tab, which may load file://.
    wc.on('will-navigate', (e, url) => {
      if (!this.allowed(url) && !(tab.trustFile && url.startsWith('file:'))) e.preventDefault();
    });
    // Popups never open native windows — they become tabs.
    wc.setWindowOpenHandler(({ url }) => {
      if (this.allowed(url)) this.newTab(url);
      return { action: 'deny' };
    });
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const win = this.deps.getWindow();
    if (win?.contentView.children.includes(tab.view)) win.contentView.removeChildView(tab.view);
    if (tab.cdp) {
      try {
        tab.view.webContents.debugger.detach();
      } catch {
        /* already gone */
      }
    }
    tab.view.webContents.close();
    this.tabs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.activeId === id) {
      this.activeId = undefined;
      const next = this.order[this.order.length - 1];
      if (next) this.selectTab(next);
      else this.pushState();
    } else {
      this.pushState();
    }
  }

  selectTab(id: string): void {
    if (!this.tabs.has(id) || this.activeId === id) return;
    this.activeId = id;
    this.layout();
    this.pushState();
  }

  // -- bounds / show / hide ------------------------------------------------

  setBounds(rect: Rect): void {
    this.bounds = rect;
    this.layout();
  }

  show(): void {
    this.visible = true;
    if (this.tabs.size === 0) this.newTab(BLANK);
    else this.layout();
    this.pushState();
  }

  hide(): void {
    this.visible = false;
    this.layout();
  }

  /**
   * Keep EVERY tab attached to the window and sized so its page keeps rendering.
   * A detached / zero-size WebContentsView paints nothing, so `capturePage` would
   * return an EMPTY image — which is exactly why a model screenshot failed while
   * the user was on another tab. The active tab shows at the content rect when the
   * Browser UI is visible; otherwise it (and every inactive tab) is parked
   * off-screen but still rendering, so the model can drive/screenshot any tab in
   * the background.
   */
  private layout(): void {
    const win = this.deps.getWindow();
    if (!win) return;
    const off = this.offscreen();
    for (const [id, tab] of this.tabs) {
      if (!win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view);
      const onScreen = id === this.activeId && this.visible && this.bounds.width > 0 && this.bounds.height > 0;
      tab.view.setBounds(onScreen ? this.bounds : off);
    }
    // Bring the active tab to the front so it isn't occluded when visible.
    const active = this.active();
    if (active) {
      win.contentView.removeChildView(active.view);
      win.contentView.addChildView(active.view);
    }
    this.layoutOverlay(win);
  }

  /** Off-screen but non-zero bounds (parked left of the window) — keeps the page
   *  rendering so `capturePage` works while the tab is hidden. */
  private offscreen(): Rect {
    const w = Math.max(this.bounds.width || 0, 1280);
    const h = Math.max(this.bounds.height || 0, 800);
    return { x: -(w + 400), y: 0, width: w, height: h };
  }

  // -- activity overlay ----------------------------------------------------

  /** Push the current model-driven action list plus an optional attention notice
   *  (approval waiting in the main window). Empty list AND no notice hides it. */
  setOverlay(title: string, items: OverlayItem[], notice?: string): void {
    if (items.length === 0 && !notice) {
      this.overlayVisible = false;
      this.layout();
      return;
    }
    this.overlayTitle = title;
    this.overlayItems = items;
    this.overlayNotice = notice ?? '';
    this.overlayVisible = true;
    this.ensureOverlay();
    this.layout();
    this.renderOverlay();
  }

  private ensureOverlay(): void {
    if (this.overlay) return;
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    view.setBackgroundColor('#00000000'); // transparent, so the card's rounded corners show the page
    const withRadius = view as unknown as { setBorderRadius?: (r: number) => void };
    withRadius.setBorderRadius?.(12);
    view.webContents.on('did-finish-load', () => {
      this.overlayLoaded = true;
      this.renderOverlay();
    });
    void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`);
    this.overlay = view;
  }

  private renderOverlay(): void {
    if (!this.overlay || !this.overlayLoaded) return;
    const payload = `${JSON.stringify(this.overlayTitle)},${JSON.stringify(this.overlayItems)},${JSON.stringify(this.overlayNotice)}`;
    void this.overlay.webContents.executeJavaScript(`window.__eaOverlay(${payload})`).catch(() => {});
  }

  /** Position the overlay at the content region's bottom-right, sized to fit the
   *  rows, and keep it on top; detach it when hidden. */
  private layoutOverlay(win: BaseWindow): void {
    if (!this.overlay) return;
    const show = this.overlayVisible && this.visible && this.bounds.width > 0 && this.bounds.height > 0;
    const attached = win.contentView.children.includes(this.overlay);
    if (!show) {
      if (attached) win.contentView.removeChildView(this.overlay);
      return;
    }
    const W = 300;
    const margin = 12;
    const rows = Math.min(this.overlayItems.length, 4);
    const H = 38 + rows * 24 + 12 + (this.overlayNotice ? 40 : 0);
    this.overlay.setBounds({
      x: this.bounds.x + this.bounds.width - W - margin,
      y: this.bounds.y + this.bounds.height - H - margin,
      width: W,
      height: H,
    });
    // Re-add so it sits above the active tab view.
    if (attached) win.contentView.removeChildView(this.overlay);
    win.contentView.addChildView(this.overlay);
  }

  // -- navigation ----------------------------------------------------------

  navigate(id: string | undefined, url: string): void {
    const tab = this.resolve(id);
    const target = this.normalize(url);
    if (tab && target) void tab.view.webContents.loadURL(target).catch(() => {});
  }
  goBack(id?: string): void {
    this.resolve(id)?.view.webContents.navigationHistory.goBack();
  }
  goForward(id?: string): void {
    this.resolve(id)?.view.webContents.navigationHistory.goForward();
  }
  reload(id?: string): void {
    this.resolve(id)?.view.webContents.reload();
  }

  // -- automation primitives (consumed by BrowserMcpServer) ----------------

  listTabs(): BrowserTab[] {
    return this.state().tabs;
  }
  getActiveTab(): BrowserTab | undefined {
    const t = this.active();
    return t ? this.toTab(t) : undefined;
  }

  async screenshot(id?: string): Promise<string | undefined> {
    const tab = this.resolve(id);
    if (!tab) return undefined;
    const wc = tab.view.webContents;
    // capturePage() only yields a frame when the view is actually painting AND has
    // a live compositor surface. Two failure modes bite here: (1) a fresh/heavy
    // page hasn't painted its first frame yet → empty buffer; (2) a parked
    // off-screen view (Browser tab isn't the foreground app tab) has no Viz frame
    // to copy → capturePage REJECTS ("UnknownVizError"). So wait for load to
    // settle, keep the view laid out, and poll with backoff — treating both an
    // empty buffer and a rejection as "not ready yet, retry".
    this.layout();
    await this.waitForLoad(wc);
    for (let attempt = 0; attempt < 8; attempt++) {
      this.layout();
      try {
        const png = (await wc.capturePage()).toPNG();
        if (png.length > 0) return png.toString('base64');
      } catch {
        /* Viz compositor has no frame yet — fall through to retry. */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return undefined;
  }

  /** Resolve once the page has stopped loading (bounded), so the first capture
   *  attempt isn't racing an in-flight navigation. */
  private waitForLoad(wc: WebContents, timeoutMs = 3000): Promise<void> {
    if (!wc.isLoading()) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.removeListener('did-stop-loading', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      wc.once('did-stop-loading', finish);
    });
  }

  async pageText(id: string | undefined, maxChars = 20000): Promise<string> {
    const tab = this.resolve(id);
    if (!tab) return '';
    const text = await tab.view.webContents
      .executeJavaScript(`(()=>{const a=document.querySelector('article')||document.body;return a?a.innerText:''})()`, true)
      .catch(() => '');
    return String(text).slice(0, maxChars);
  }

  async readPage(id: string | undefined, maxChars = 20000): Promise<string> {
    const tab = this.resolve(id);
    if (!tab) return '';
    const tree = await tab.view.webContents.executeJavaScript(REF_WALKER, true).catch((e) => `read error: ${e}`);
    return String(tree).slice(0, maxChars);
  }

  async find(id: string | undefined, query: string): Promise<string> {
    const tab = this.resolve(id);
    if (!tab) return '';
    const res = await tab.view.webContents
      .executeJavaScript(`window.__eaFind ? window.__eaFind(${JSON.stringify(query)}) : 'call read_page first'`, true)
      .catch(() => 'call read_page first');
    return String(res);
  }

  async click(id: string | undefined, ref: number): Promise<boolean> {
    const tab = this.resolve(id);
    if (!tab) return false;
    const pt = await this.refPoint(tab, ref);
    if (!pt) return false;
    const dbg = this.attachCdp(tab);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    return true;
  }

  async type(id: string | undefined, ref: number | undefined, text: string, submit?: boolean): Promise<boolean> {
    const tab = this.resolve(id);
    if (!tab) return false;
    if (ref != null && !(await this.click(id, ref))) return false;
    const dbg = this.attachCdp(tab);
    await dbg.sendCommand('Input.insertText', { text });
    if (submit) await this.pressEnter(dbg);
    return true;
  }

  async key(id: string | undefined, key: string): Promise<boolean> {
    const tab = this.resolve(id);
    if (!tab) return false;
    const dbg = this.attachCdp(tab);
    if (key === 'Enter') await this.pressEnter(dbg);
    else {
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key });
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key });
    }
    return true;
  }

  async scroll(id: string | undefined, direction: 'up' | 'down', amount = 500): Promise<boolean> {
    const tab = this.resolve(id);
    if (!tab) return false;
    await tab.view.webContents
      .executeJavaScript(`window.scrollBy(0, ${direction === 'down' ? amount : -amount})`, true)
      .catch(() => {});
    return true;
  }

  async selectOption(id: string | undefined, ref: number, value: string): Promise<boolean> {
    const tab = this.resolve(id);
    if (!tab) return false;
    const ok = await tab.view.webContents
      .executeJavaScript(
        `(()=>{const el=window.__eaRefs&&window.__eaRefs[${ref}];if(!el)return false;el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
        true,
      )
      .catch(() => false);
    return Boolean(ok);
  }

  dispose(): void {
    for (const t of this.tabs.values()) {
      if (t.cdp) {
        try {
          t.view.webContents.debugger.detach();
        } catch {
          /* ignore */
        }
      }
      t.view.webContents.close();
    }
    this.tabs.clear();
    this.order = [];
    this.activeId = undefined;
    this.overlay?.webContents.close();
    this.overlay = undefined;
  }

  // -- helpers -------------------------------------------------------------

  private active(): Tab | undefined {
    return this.activeId ? this.tabs.get(this.activeId) : undefined;
  }
  private resolve(id?: string): Tab | undefined {
    return id ? this.tabs.get(id) : this.active();
  }
  private allowed(url: string): boolean {
    return /^https?:\/\//i.test(url) || url.startsWith('about:');
  }
  private normalize(url?: string): string | undefined {
    if (!url) return undefined;
    const u = url.trim();
    if (!u) return undefined;
    if (this.allowed(u)) return u;
    return `https://${u}`;
  }
  private attachCdp(tab: Tab): Electron.Debugger {
    if (!tab.cdp) {
      tab.view.webContents.debugger.attach('1.3');
      tab.cdp = true;
    }
    return tab.view.webContents.debugger;
  }
  private async pressEnter(dbg: Electron.Debugger): Promise<void> {
    const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  }
  private async refPoint(tab: Tab, ref: number): Promise<{ x: number; y: number } | undefined> {
    const pt = await tab.view.webContents
      .executeJavaScript(
        `(()=>{const el=window.__eaRefs&&window.__eaRefs[${ref}];if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
        true,
      )
      .catch(() => null);
    return pt ?? undefined;
  }
}
