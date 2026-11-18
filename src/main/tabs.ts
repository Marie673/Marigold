// Tab lifecycle: one WebContentsView per *awake* tab. Tabs that are asleep or
// archived are just records and cost no memory.
import { BrowserWindow, Menu, WebContentsView, app, clipboard, dialog, session, shell, type Session, type WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import type { ProfileData, TabData } from '../../sync/core/protocol.ts';
import { integrationFor } from '../shared/integrations.ts';
import { autoBudgetMb, orderBetween, resolveInput, tabsToArchive, viewsToRelieve, viewsToSleep } from '../shared/lifecycle.ts';
import type { ArchivedTab, MemoryReport, Rect, TabView } from '../shared/types.ts';
import { L, isJa, localize } from './l10n.ts';
import { newId, type Store } from './store.ts';

interface Live {
  view: WebContentsView;
  lastUsed: number;
  loading: boolean;
  audible: boolean;
  /** Keystrokes since the last navigation: a tab with typed input is not unloaded lightly. */
  typed: number;
}

const ASK_PERMISSIONS: Record<string, [en: string, ja: string]> = {
  media: ['use your camera or microphone', 'カメラ・マイクの使用'],
  geolocation: ['know your location', '位置情報の取得'],
  notifications: ['show notifications', '通知の表示'],
  'clipboard-read': ['read your clipboard', 'クリップボードの読み取り'],
  midi: ['use MIDI devices', 'MIDIデバイスの使用'],
  midiSysex: ['use MIDI devices', 'MIDIデバイスの使用'],
  'display-capture': ['capture your screen', '画面のキャプチャ'],
};
const ALLOW_PERMISSIONS = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'keyboardLock']);

export class TabManager {
  private readonly live = new Map<string, Live>();
  private readonly preparedSessions = new WeakSet<Session>();
  private readonly permissionMemory = new Map<string, boolean>();
  /** Scroll positions of tabs, kept across sleep so waking a tab lands where you left it. */
  private readonly scroll = new Map<string, { url: string; y: number }>();
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private overlay = false;
  private attached: string | null = null;
  private fullscreenTab: string | null = null;
  private readonly win: BrowserWindow;
  private readonly store: Store;
  private readonly onChange: () => void;
  onFound: (result: { matches: number; active: number }) => void = () => {};

  constructor(win: BrowserWindow, store: Store, onChange: () => void) {
    this.win = win;
    this.store = store;
    this.onChange = onChange;
  }

  // ---- queries ----

  get profileId(): string {
    return this.store.local.currentProfileId;
  }

  get activeId(): string | null {
    const id = this.store.local.activeTabByProfile[this.profileId] ?? null;
    const t = id ? this.store.tab(id) : null;
    return t && t.archivedAt === null && t.profileId === this.profileId ? id : null;
  }

  private openTabs(profileId = this.profileId): { key: string; data: TabData }[] {
    return this.store
      .list<TabData>('tab')
      .filter((t) => t.data.profileId === profileId && t.data.archivedAt === null)
      .sort((a, b) => Number(b.data.pinned) - Number(a.data.pinned) || a.data.order - b.data.order);
  }

  tabViews(): TabView[] {
    return this.openTabs().map(({ key, data }) => {
      const l = this.live.get(key);
      const wc = l?.view.webContents;
      return {
        ...data,
        id: key,
        loading: l?.loading ?? false,
        canGoBack: wc?.navigationHistory.canGoBack() ?? false,
        canGoForward: wc?.navigationHistory.canGoForward() ?? false,
        audible: l?.audible ?? false,
        asleep: !l,
        badge: integrationFor(data.url)?.badge?.(data.title) ?? null,
      };
    });
  }

  archived(profileId = this.profileId): ArchivedTab[] {
    return this.store
      .list<TabData>('tab')
      .filter((t) => t.data.profileId === profileId && t.data.archivedAt !== null)
      .sort((a, b) => b.data.archivedAt! - a.data.archivedAt!)
      .map(({ key, data }) => ({ ...data, id: key }));
  }

  webContents(id: string): WebContents | null {
    return this.live.get(id)?.view.webContents ?? null;
  }

  activeWebContents(): WebContents | null {
    return this.activeId ? this.webContents(this.activeId) : null;
  }

  // ---- mutations ----

  create(input: string, opts: { pinned?: boolean; activate?: boolean; after?: string | null; profileId?: string } = {}): string {
    const profileId = opts.profileId ?? this.profileId;
    const url = resolveInput(input, this.store.settings().searchEngine);
    const pinned = opts.pinned ?? false;
    const peers = this.openTabs(profileId).filter((t) => t.data.pinned === pinned);
    let order = orderBetween(peers.at(-1)?.data.order, undefined);
    if (opts.after) {
      const i = peers.findIndex((t) => t.key === opts.after);
      if (i >= 0) order = orderBetween(peers[i].data.order, peers[i + 1]?.data.order);
    }
    const id = newId();
    const now = Date.now();
    this.store.put<TabData>('tab', id, { profileId, url, title: '', faviconUrl: null, pinned, order, createdAt: now, lastActiveAt: now, archivedAt: null });
    if (opts.activate ?? true) this.activate(id);
    else this.onChange();
    return id;
  }

  activate(id: string | null) {
    const tab = id ? this.store.tab(id) : null;
    const prev = this.activeId;
    if (prev && prev !== id) this.rememberScroll(prev);
    if (id && tab) {
      if (tab.profileId !== this.profileId) this.store.setLocal({ currentProfileId: tab.profileId });
      const patch: Partial<TabData> = { lastActiveAt: Date.now() };
      if (tab.archivedAt !== null) patch.archivedAt = null;
      this.store.patch<TabData>(`tab:${id}`, patch);
      this.ensureLive(id).lastUsed = Date.now();
    }
    this.store.setLocal({ activeTabByProfile: { ...this.store.local.activeTabByProfile, [this.profileId]: tab ? id : null } });
    this.layout();
    if (tab && !this.overlay) this.webContents(id!)?.focus();
    this.onChange();
  }

  /** Closing an unpinned tab archives it; closing a pinned tab only unloads it. */
  close(id: string) {
    const tab = this.store.tab(id);
    if (!tab) return;
    const wasActive = this.activeId === id;
    const siblings = this.openTabs(tab.profileId);
    const idx = siblings.findIndex((t) => t.key === id);
    this.sleep(id);
    if (!tab.pinned) {
      if (tab.url) this.store.patch<TabData>(`tab:${id}`, { archivedAt: Date.now() });
      else this.store.remove(`tab:${id}`);
    }
    if (wasActive) {
      const rest = siblings.filter((t) => t.key !== id && !t.data.pinned);
      const next = rest.find((_, i, a) => siblings.indexOf(a[i]) > idx) ?? rest.at(-1) ?? null;
      this.activate(next?.key ?? null);
    } else this.onChange();
  }

  restore(id: string) {
    if (this.store.tab(id)) this.activate(id);
  }

  /** Reopens the most recently archived tab of the current profile. */
  restoreLast() {
    const last = this.archived()[0];
    if (last) this.restore(last.id);
  }

  delete(id: string) {
    this.sleep(id);
    this.store.remove(`tab:${id}`);
    if (this.activeId === null) this.layout();
    this.onChange();
  }

  clearArchive() {
    for (const t of this.archived()) this.store.remove(`tab:${t.id}`);
    this.onChange();
  }

  pin(id: string, pinned: boolean) {
    const tab = this.store.tab(id);
    if (!tab || tab.pinned === pinned) return;
    const peers = this.openTabs(tab.profileId).filter((t) => t.data.pinned === pinned);
    const order = pinned ? orderBetween(peers.at(-1)?.data.order, undefined) : orderBetween(undefined, peers[0]?.data.order);
    this.store.patch<TabData>(`tab:${id}`, { pinned, order, lastActiveAt: Date.now() });
    this.onChange();
  }

  /** Moves a tab before `beforeId` (or to the end of its group when null). */
  move(id: string, beforeId: string | null) {
    const tab = this.store.tab(id);
    if (!tab || id === beforeId) return;
    const peers = this.openTabs(tab.profileId).filter((t) => t.data.pinned === tab.pinned && t.key !== id);
    const i = beforeId ? peers.findIndex((t) => t.key === beforeId) : -1;
    const order = i < 0 ? orderBetween(peers.at(-1)?.data.order, undefined) : orderBetween(peers[i - 1]?.data.order, peers[i].data.order);
    this.store.patch<TabData>(`tab:${id}`, { order });
    this.onChange();
  }

  navigate(id: string, input: string) {
    const url = resolveInput(input, this.store.settings().searchEngine);
    if (!url || !this.store.tab(id)) return;
    this.store.patch<TabData>(`tab:${id}`, { url, lastActiveAt: Date.now() });
    const wc = this.ensureLive(id).view.webContents;
    wc.loadURL(url).catch(() => {});
    if (id === this.activeId && !this.overlay) wc.focus();
    this.onChange();
  }

  cycle(delta: number) {
    const tabs = this.openTabs();
    if (!tabs.length) return;
    const i = tabs.findIndex((t) => t.key === this.activeId);
    this.activate(tabs[(i + delta + tabs.length) % tabs.length].key);
  }

  activateIndex(n: number) {
    const tabs = this.openTabs();
    const t = n >= 8 ? tabs.at(-1) : tabs[n];
    if (t) this.activate(t.key);
  }

  switchProfile(profileId: string) {
    if (!this.store.get<ProfileData>(`profile:${profileId}`)) return;
    this.store.setLocal({ currentProfileId: profileId });
    const id = this.activeId;
    if (id) this.ensureLive(id).lastUsed = Date.now();
    this.layout();
    this.onChange();
  }

  /** Deletes a profile with its tabs, cookies and storage. */
  async deleteProfile(profileId: string) {
    for (const t of this.store.list<TabData>('tab')) {
      if (t.data.profileId !== profileId) continue;
      this.sleep(t.key);
      this.store.remove(`tab:${t.key}`);
    }
    this.store.remove(`profile:${profileId}`);
    this.store.clearHistory(profileId);
    await session.fromPartition(`persist:profile-${profileId}`).clearStorageData().catch(() => {});
    this.onChange();
  }

  // ---- layout ----

  setBounds(r: Rect) {
    this.bounds = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    this.layout();
  }

  /**
   * The chrome UI draws popovers (command bar, menus) in the window's own web
   * contents, which sits *below* tab views. While one is open we swap the live
   * page for a screenshot the chrome can draw behind the popover.
   */
  async setOverlay(on: boolean): Promise<string | null> {
    if (on === this.overlay) return null;
    let shot: string | null = null;
    if (on) {
      const wc = this.activeWebContents();
      if (wc && this.attached) {
        try {
          // A small JPEG is plenty for a blurred backdrop and keeps the UI process lean.
          const img = await wc.capturePage();
          if (!img.isEmpty()) {
            const { width } = img.getSize();
            shot = `data:image/jpeg;base64,${img.resize({ width: Math.min(width, 800), quality: 'good' }).toJPEG(60).toString('base64')}`;
          }
        } catch {}
      }
    }
    this.overlay = on;
    this.layout();
    if (on) this.win.webContents.focus();
    else this.activeWebContents()?.focus();
    return shot;
  }

  private layout() {
    if (this.win.isDestroyed()) return;
    const want = this.overlay ? null : this.activeId && this.live.has(this.activeId) ? this.activeId : null;
    if (this.attached && this.attached !== want) {
      const old = this.live.get(this.attached);
      if (old) this.win.contentView.removeChildView(old.view);
      this.attached = null;
    }
    if (!want) return;
    const { view } = this.live.get(want)!;
    if (this.attached !== want) {
      this.win.contentView.addChildView(view);
      this.attached = want;
    }
    if (this.fullscreenTab === want) {
      const [width, height] = this.win.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height });
    } else view.setBounds(this.bounds);
  }

  // ---- lifecycle ----

  private rememberScroll(id: string) {
    const wc = this.webContents(id);
    if (!wc || wc.isLoading()) return;
    const url = wc.getURL();
    wc.executeJavaScript('window.scrollY', false)
      .then((y) => typeof y === 'number' && this.scroll.set(id, { url, y }))
      .catch(() => {});
  }

  private budgetMb(): number {
    const b = this.store.local.memoryBudgetMb;
    return b === 0 ? autoBudgetMb(totalmem() / 1048576) : b;
  }

  /** Memory per awake tab, from the OS's view of each tab's renderer process. */
  memory(): MemoryReport {
    const metrics = app.getAppMetrics();
    const byPid = new Map(metrics.map((m) => [m.pid, processMb(m.pid, m.memory.workingSetSize)]));
    const totalMb = Math.round([...byPid.values()].reduce((n, mb) => n + mb, 0));
    const active = this.activeId;
    const tabs: MemoryReport['tabs'] = [];
    const seen = new Set<number>();
    for (const [id, l] of this.live) {
      const tab = this.store.tab(id);
      if (!tab || l.view.webContents.isDestroyed()) continue;
      const pid = l.view.webContents.getOSProcessId();
      // Tabs of the same site can share a process: count it once.
      const mb = seen.has(pid) ? 0 : Math.round(byPid.get(pid) ?? 0);
      seen.add(pid);
      tabs.push({ id, title: tab.title || tab.url, faviconUrl: tab.faviconUrl, url: tab.url, mb, active: id === active });
    }
    tabs.sort((a, b) => b.mb - a.mb);
    const open = this.store.list<TabData>('tab').filter((t) => t.data.archivedAt === null).length;
    return {
      totalMb, budgetMb: this.budgetMb(), systemMb: Math.round(totalmem() / 1048576),
      baseMb: Math.max(0, totalMb - tabs.reduce((n, t) => n + t.mb, 0)), tabs, asleep: open - tabs.length,
    };
  }

  /** Runs every minute: archive stale tabs, unload idle ones. */
  sweep(now = Date.now()) {
    const active = this.activeId;
    // A tab the user is looking at right now is not idle.
    if (active && this.win.isFocused() && !this.win.isMinimized()) {
      const t = this.store.tab(active);
      if (t && now - t.lastActiveAt > 5 * 60_000) this.store.patch<TabData>(`tab:${active}`, { lastActiveAt: now });
    }
    const all = this.store.list<TabData>('tab').map((t) => ({ id: t.key, ...t.data }));
    const keep = new Set([...this.live].filter(([, l]) => l.audible).map(([id]) => id));
    const stale = tabsToArchive(all, now, this.store.settings().archiveAfterMs, keep);
    for (const id of stale) {
      this.sleep(id);
      this.store.patch<TabData>(`tab:${id}`, { archivedAt: now });
    }
    const isProtected = (l: Live) => l.audible || l.typed >= 8 || l.view.webContents.isDevToolsOpened();
    const views = [...this.live].map(([id, l]) => ({ id, lastUsed: l.lastUsed, audible: isProtected(l) }));
    const idle = viewsToSleep(views, now, this.store.local.sleepAfterMs, active);
    for (const id of idle) this.sleep(id);
    // Memory pressure: over budget, or the machine itself is nearly out of memory.
    if (this.live.size > 1) {
      const report = this.memory();
      const mbOf = new Map(report.tabs.map((t) => [t.id, t.mb]));
      const mem = [...this.live].map(([id, l]) => ({ id, mb: mbOf.get(id) ?? 0, lastUsed: l.lastUsed, protected: isProtected(l) }));
      // macOS keeps free memory near zero by design, so the system check only applies elsewhere.
      const starved = process.platform !== 'darwin' && freemem() / totalmem() < 0.06;
      const budget = starved ? Math.min(report.budgetMb > 0 ? report.budgetMb : Infinity, report.totalMb - 1) : report.budgetMb;
      const relieve = viewsToRelieve(mem, report.totalMb, budget, active).slice(0, starved ? 2 : undefined);
      for (const id of relieve) this.sleep(id);
      idle.push(...relieve);
    }
    if (stale.length || idle.length) {
      if (active && stale.includes(active)) this.activate(null);
      this.layout();
      this.onChange();
    }
    return { archived: stale, slept: idle };
  }

  /** Reacts to tabs changed by another device. */
  reconcile() {
    for (const id of [...this.live.keys()]) {
      const t = this.store.tab(id);
      if (!t || t.archivedAt !== null) this.sleep(id);
    }
    this.layout();
  }

  sleep(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    if (this.attached === id) {
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(l.view);
      this.attached = null;
    }
    if (this.fullscreenTab === id) this.fullscreenTab = null;
    this.live.delete(id);
    if (!this.store.tab(id)) this.scroll.delete(id);
    if (!l.view.webContents.isDestroyed()) l.view.webContents.close();
  }

  destroyAll() {
    for (const id of [...this.live.keys()]) this.sleep(id);
  }

  private ensureLive(id: string): Live {
    const existing = this.live.get(id);
    if (existing) return existing;
    const tab = this.store.tab(id)!;
    const ses = session.fromPartition(`persist:profile-${tab.profileId}`);
    this.prepareSession(ses);
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const l: Live = { view, lastUsed: Date.now(), loading: false, audible: false, typed: 0 };
    view.setBorderRadius?.(10);
    this.live.set(id, l);
    this.wire(id, l);
    if (tab.url) {
      const saved = this.scroll.get(id);
      if (saved && saved.y > 0 && saved.url === tab.url) {
        view.webContents.once('did-finish-load', () => {
          view.webContents.executeJavaScript(`window.scrollTo(0, ${Number(saved.y) || 0})`, false).catch(() => {});
        });
      }
      view.webContents.loadURL(tab.url).catch(() => {});
    }
    return l;
  }

  private wire(id: string, l: Live) {
    const wc = l.view.webContents;
    const rec = `tab:${id}`;
    const changed = () => this.onChange();
    wc.on('did-start-loading', () => ((l.loading = true), changed()));
    wc.on('did-stop-loading', () => ((l.loading = false), changed()));
    wc.on('page-title-updated', (_e, title) => {
      this.store.patch<TabData>(rec, { title });
      this.store.setHistoryTitle(wc.getURL(), title, this.store.tab(id)?.profileId ?? '');
      changed();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      const icon = icons.find((u) => /^https?:/.test(u)) ?? null;
      this.store.patch<TabData>(rec, { faviconUrl: icon });
      changed();
    });
    const navigated = (url: string, isNew: boolean) => {
      const tab = this.store.tab(id);
      if (!tab) return;
      const patch: Partial<TabData> = { url };
      if (isNew && new URL(url).origin !== safeOrigin(tab.url)) patch.faviconUrl = null;
      this.store.patch<TabData>(rec, patch);
      this.store.addHistory(url, wc.getTitle(), tab.profileId);
      changed();
    };
    wc.on('did-navigate', (_e, url) => ((l.typed = 0), navigated(url, true)));
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key.length === 1 && !input.control && !input.meta) l.typed++;
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => isMainFrame && navigated(url, false));
    wc.on('audio-state-changed', (e) => ((l.audible = e.audible), changed()));
    wc.on('enter-html-full-screen', () => ((this.fullscreenTab = id), this.layout()));
    wc.on('leave-html-full-screen', () => ((this.fullscreenTab = null), this.layout()));
    wc.on('found-in-page', (_e, r) => this.onFound({ matches: r.matches, active: r.activeMatchOrdinal }));
    wc.on('render-process-gone', () => ((l.loading = false), changed()));
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:/.test(url)) this.create(url, { activate: disposition !== 'background-tab', after: id });
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      // Hand non-web schemes (mailto:, zoommtg: …) to the OS after asking.
      if (!/^(https?|about|blob|data|file|view-source):/i.test(url)) {
        e.preventDefault();
        this.openExternal(url);
      }
    });
    wc.on('context-menu', (_e, p) => {
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (p.linkURL) {
        items.push(
          { label: 'Open Link in New Tab', click: () => this.create(p.linkURL, { activate: false, after: id }) },
          { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
          { type: 'separator' },
        );
      }
      if (p.mediaType === 'image' && p.srcURL) {
        items.push(
          { label: 'Open Image in New Tab', click: () => this.create(p.srcURL, { after: id }) },
          { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
          { type: 'separator' },
        );
      }
      if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
      else if (p.selectionText) {
        const q = p.selectionText.trim().slice(0, 60);
        items.push({ role: 'copy' }, { label: isJa() ? `「${q}」を検索` : `Search for “${q}”`, click: () => this.create(p.selectionText, { after: id }) }, { type: 'separator' });
      }
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) },
      );
      Menu.buildFromTemplate(localize(items)).popup({ window: this.win });
    });
  }

  private async openExternal(url: string) {
    const scheme = url.split(':')[0];
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'question',
      message: isJa() ? `この ${scheme}: リンクを別のアプリで開きますか？` : `Open this ${scheme}: link in another app?`,
      detail: url.slice(0, 300),
      buttons: [L('Open'), L('Cancel')],
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(url).catch(() => {});
  }

  private prepareSession(ses: Session) {
    if (this.preparedSessions.has(ses)) return;
    this.preparedSessions.add(ses);
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (ALLOW_PERMISSIONS.has(permission)) return callback(true);
      const what = ASK_PERMISSIONS[permission];
      const origin = safeOrigin(details.requestingUrl || wc.getURL());
      if (!what || !origin) return callback(false);
      const key = `${origin} ${permission}`;
      const known = this.permissionMemory.get(key);
      if (known !== undefined) return callback(known);
      dialog
        .showMessageBox(this.win, {
          type: 'question',
          message: isJa() ? `${new URL(origin).host} に${what[1]}を許可しますか？` : `Allow ${new URL(origin).host} to ${what[0]}?`,
          buttons: [L('Allow'), L('Block')],
          cancelId: 1,
          defaultId: 1,
        })
        .then(({ response }) => {
          this.permissionMemory.set(key, response === 0);
          callback(response === 0);
        });
    });
    ses.setPermissionCheckHandler((_wc, permission, origin) => {
      if (ALLOW_PERMISSIONS.has(permission)) return true;
      return this.permissionMemory.get(`${safeOrigin(origin)} ${permission}`) === true;
    });
  }
}

/**
 * Memory of one process in MB. Electron reports resident size, which on Linux
 * counts pages shared between processes once per process; the kernel's
 * proportional figure (PSS) is the honest number there.
 */
function processMb(pid: number, workingSetKb: number): number {
  if (process.platform === 'linux') {
    try {
      const m = /^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      if (m) return Number(m[1]) / 1024;
    } catch {}
  }
  return workingSetKb / 1024;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
