import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import type { AiRequestData, AiResponseData, ChatMessage, PageContext, ProfileData, SettingsData, SyncRecord } from '../../sync/core/protocol.ts';
import type { AiEvent, LocalSettings, Profile, Rect, Suggestion, UiCommand, UiState } from '../shared/types.ts';
import { Assistant, extractPage } from './ai.ts';
import { L, isJa, localize } from './l10n.ts';
import { Store, newId } from './store.ts';
import { SyncClient } from './sync.ts';
import { TabManager } from './tabs.ts';

const isMac = process.platform === 'darwin';
if (process.env.MARIGOLD_USER_DATA) app.setPath('userData', process.env.MARIGOLD_USER_DATA);

// Sites sniff for "Electron" and serve degraded pages or block sign-in; present as plain Chrome.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|marigold|Marigold)\/[^\s]+/g, '');

let win: BrowserWindow | null = null;
let store: Store;
let tabs: TabManager;
let sync: SyncClient;
let assistant: Assistant;
let pendingLink: string | null = null;
let providers: UiState['providers'] = [];

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function uiState(): UiState {
  return {
    platform: process.platform,
    locale: app.getLocale(),
    profiles: store
      .list<ProfileData>('profile')
      .sort((a, b) => a.data.order - b.data.order)
      .map((p): Profile => ({ id: p.key, ...p.data })),
    currentProfileId: store.local.currentProfileId,
    tabs: tabs.tabViews(),
    activeTabId: tabs.activeId,
    settings: store.settings(),
    local: {
      sleepAfterMs: store.local.sleepAfterMs,
      aiProvider: store.local.aiProvider,
      aiModels: store.local.aiModels,
      aiPanelOpen: store.local.aiPanelOpen,
      deviceName: store.local.deviceName,
      cliPaths: store.local.cliPaths,
    },
    sync: sync.status(),
    providers,
  };
}

let broadcastQueued = false;
function broadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(() => {
    broadcastQueued = false;
    if (win && !win.isDestroyed()) win.webContents.send('state', uiState());
  }, 16);
}

function command(c: UiCommand) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.webContents.send('command', c);
}

function suggest(query: string): Suggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const hit = (title: string, url: string) => words.every((w) => title.toLowerCase().includes(w) || url.toLowerCase().includes(w));
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const t of tabs.tabViews()) {
    if (t.url && hit(t.title, t.url) && !seen.has(t.url)) {
      seen.add(t.url);
      out.push({ kind: 'tab', id: t.id, url: t.url, title: t.title || t.url, faviconUrl: t.faviconUrl });
    }
  }
  const now = Date.now();
  const scored = store.history
    .filter((h) => h.profileId === store.local.currentProfileId && !seen.has(h.url) && hit(h.title, h.url))
    .map((h) => ({ h, score: h.visits * 2 + 10 / (1 + (now - h.last) / 86400_000) + (h.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').startsWith(q) ? 20 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  for (const { h } of scored) out.push({ kind: 'history', url: h.url, title: h.title || h.url });
  return out.slice(0, 8);
}

// ---- assistant ----

async function contextFor(tabIds: string[]): Promise<PageContext[]> {
  const out: PageContext[] = [];
  for (const id of tabIds.slice(0, 6)) {
    const tab = store.tab(id);
    if (!tab) continue;
    const wc = tabs.webContents(id);
    out.push(wc ? await extractPage(wc) : { title: tab.title, url: tab.url, text: '[This tab is asleep; only its title and address are known.]' });
  }
  return out;
}

async function aiSend(p: { chatId: string; messages: ChatMessage[]; tabIds: string[] }) {
  const send = (e: AiEvent) => win && !win.isDestroyed() && win.webContents.send('ai', e);
  let last = 0;
  let latest = '';
  try {
    const context = await contextFor(p.tabIds);
    const provider = store.local.aiProvider;
    const text = await assistant.chat(p.chatId, provider, store.local.aiModels[provider] ?? '', p.messages, context, (t) => {
      latest = t;
      if (Date.now() - last > 40) {
        last = Date.now();
        send({ chatId: p.chatId, text: t, done: false, error: null });
      }
    });
    send({ chatId: p.chatId, text, done: true, error: null });
  } catch (e) {
    send({ chatId: p.chatId, text: latest, done: true, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Runs AI requests that a paired phone addressed to this computer. */
function handleRelay(id: string) {
  const rec = store.records.get(id) as SyncRecord<AiRequestData> | undefined;
  if (!rec || rec.data?.targetDeviceId !== store.local.deviceId) return;
  const key = id.slice('aireq:'.length);
  if (rec.deleted) return assistant.stop(`relay:${key}`);
  if (store.records.has(`aires:${key}`) || Date.now() - rec.updatedAt > 10 * 60_000) return;
  const expiresAt = Date.now() + 30 * 60_000;
  const write = (d: AiResponseData) => store.put<AiResponseData>('aires', key, d, { expiresAt });
  write({ text: '', done: false, error: null });
  let last = 0;
  const { provider, messages, context } = rec.data;
  assistant
    .chat(`relay:${key}`, provider, store.local.aiModels[provider] ?? '', messages ?? [], context ?? [], (text) => {
      if (Date.now() - last > 500) {
        last = Date.now();
        write({ text, done: false, error: null });
      }
    })
    .then((text) => write({ text, done: true, error: null }))
    .catch((e) => write({ text: '', done: true, error: e instanceof Error ? e.message : String(e) }));
}

async function refreshProviders(force = false) {
  providers = await assistant.detect(force);
  sync.publishDevice();
  broadcast();
}

// ---- IPC ----

type Handler = (payload: any) => unknown;

function handlers(): Record<string, Handler> {
  const activeWc = () => tabs.activeWebContents();
  return {
    'state.get': () => uiState(),
    'tab.new': (p: { input: string; pinned?: boolean; activate?: boolean }) => tabs.create(p.input, { pinned: p.pinned, activate: p.activate }),
    'tab.activate': (id: string) => tabs.activate(id),
    'tab.close': (id: string) => tabs.close(id),
    'tab.pin': (p: { id: string; pinned: boolean }) => tabs.pin(p.id, p.pinned),
    'tab.move': (p: { id: string; before: string | null }) => tabs.move(p.id, p.before),
    'tab.restore': (id: string) => tabs.restore(id),
    'tab.menu': (id: string) => {
      const tab = store.tab(id);
      if (!tab || !win) return;
      const others = tabs.tabViews().filter((x) => !x.pinned && x.id !== id);
      Menu.buildFromTemplate(
        localize([
          { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', click: () => tabs.pin(id, !tab.pinned) },
          { label: 'Duplicate', enabled: !!tab.url, click: () => tabs.create(tab.url, { after: id }) },
          { label: 'Reload', click: () => tabs.webContents(id)?.reload() },
          { label: 'Unload from Memory', enabled: !!tabs.webContents(id) && id !== tabs.activeId, click: () => (tabs.sleep(id), broadcast()) },
          { type: 'separator' },
          { label: 'Close Tab', click: () => tabs.close(id) },
          { label: 'Close Other Tabs', enabled: others.length > 0, click: () => others.forEach((x) => tabs.close(x.id)) },
        ]),
      ).popup({ window: win });
    },
    'tab.delete': (id: string) => tabs.delete(id),
    'nav.go': (p: { id: string | null; input: string }) => (p.id && store.tab(p.id) ? tabs.navigate(p.id, p.input) : tabs.create(p.input)),
    'nav.back': () => activeWc()?.navigationHistory.goBack(),
    'nav.forward': () => activeWc()?.navigationHistory.goForward(),
    'nav.reload': () => (activeWc() ? activeWc()!.reload() : tabs.activeId && tabs.activate(tabs.activeId)),
    'nav.stop': () => activeWc()?.stop(),
    'archive.list': () => tabs.archived(),
    'archive.clear': () => tabs.clearArchive(),
    suggest: (q: string) => suggest(String(q)),
    'profile.switch': (id: string) => tabs.switchProfile(id),
    'profile.create': (p: ProfileData) => {
      const id = newId();
      const order = Math.max(0, ...store.list<ProfileData>('profile').map((x) => x.data.order)) + 1;
      store.put<ProfileData>('profile', id, { name: String(p.name).slice(0, 40) || 'Profile', color: p.color, icon: p.icon, order });
      tabs.switchProfile(id);
      return id;
    },
    'profile.update': (p: { id: string } & Partial<ProfileData>) => {
      const { id, ...rest } = p;
      store.patch<ProfileData>(`profile:${id}`, rest);
      broadcast();
    },
    'profile.delete': async (id: string) => {
      const profiles = store.list<ProfileData>('profile');
      const target = profiles.find((x) => x.key === id);
      if (!target || profiles.length < 2) return false;
      const { response } = await dialog.showMessageBox(win!, {
        type: 'warning',
        message: isJa() ? `プロファイル「${target.data.name}」を削除しますか？` : `Delete the profile “${target.data.name}”?`,
        detail: isJa()
          ? 'このプロファイルのタブ・ピン留め・履歴・Cookie・ログイン状態がこの端末から削除され、同期中の他の端末からもタブが消えます。'
          : 'Its tabs, pinned tabs, history, cookies and sign-ins will be removed from this device, and its tabs from synced devices.',
        buttons: [L('Delete'), L('Cancel')],
        cancelId: 1,
        defaultId: 1,
      });
      if (response !== 0) return false;
      if (store.local.currentProfileId === id) tabs.switchProfile(profiles.find((x) => x.key !== id)!.key);
      await tabs.deleteProfile(id);
      return true;
    },
    'settings.update': (p: Partial<SettingsData>) => {
      store.put<SettingsData>('settings', 'global', { ...store.settings(), ...p });
      tabs.sweep();
      broadcast();
    },
    'local.update': (p: Partial<LocalSettings>) => {
      const allowed: (keyof LocalSettings)[] = ['sleepAfterMs', 'aiProvider', 'aiModels', 'aiPanelOpen', 'deviceName', 'cliPaths'];
      const patch: Partial<LocalSettings> = {};
      for (const k of allowed) if (k in p) (patch as any)[k] = p[k];
      store.setLocal(patch);
      if ('deviceName' in patch) sync.publishDevice();
      if ('cliPaths' in patch) void refreshProviders(true);
      broadcast();
    },
    'layout.bounds': (r: Rect) => tabs.setBounds(r),
    'overlay.set': (on: boolean) => tabs.setOverlay(!!on),
    'find.start': (p: { text: string; forward?: boolean; next?: boolean }) => {
      if (p.text) activeWc()?.findInPage(p.text, { forward: p.forward ?? true, findNext: p.next ?? false });
      else activeWc()?.stopFindInPage('clearSelection');
    },
    'find.stop': () => activeWc()?.stopFindInPage('clearSelection'),
    'ai.send': (p) => void aiSend(p),
    'ai.stop': (chatId: string) => assistant.stop(chatId),
    'ai.detect': () => refreshProviders(true),
    'sync.create': (server: string) => sync.create(server),
    'sync.join': (link: string) => sync.join(link),
    'sync.disconnect': () => sync.disconnect(),
    'sync.link': () => sync.link(),
    'history.clear': () => store.clearHistory(store.local.currentProfileId),
    'app.openExternal': (url: string) => /^https?:/.test(url) && shell.openExternal(url),
    'ui.ready': () => {
      if (pendingLink) command({ pairingLink: pendingLink });
      pendingLink = null;
    },
  };
}

// ---- window & menu ----

function buildMenu() {
  const wc = () => tabs.activeWebContents();
  const tabIndex: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Tab ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`, visible: false, click: () => tabs.activateIndex(i),
  }));
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => command('command-bar') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => (tabs.activeId ? tabs.close(tabs.activeId) : isMac ? win?.hide() : undefined) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => tabs.restoreLast() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => command('settings') },
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'quit' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' },
        { label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', click: () => command('find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: () => command('focus-url') },
        { label: 'Toggle Assistant', accelerator: 'CmdOrCtrl+E', click: () => command('toggle-ai') },
        { label: 'Archived Tabs', accelerator: 'CmdOrCtrl+Y', click: () => command('archive') },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => wc()?.reload() },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => wc()?.reloadIgnoringCache() },
        { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: () => wc()?.navigationHistory.goBack() },
        { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: () => wc()?.navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => wc()?.setZoomLevel(wc()!.getZoomLevel() + 0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => wc()?.setZoomLevel(wc()!.getZoomLevel() - 0.5) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => wc()?.setZoomLevel(0) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => wc()?.toggleDevTools() },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Pin / Unpin Tab', accelerator: 'CmdOrCtrl+D', click: () => { const id = tabs.activeId; if (id) tabs.pin(id, !store.tab(id)!.pinned); } },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => tabs.cycle(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => tabs.cycle(-1) },
        ...tabIndex,
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(localize(template)));
}

function createWindow() {
  const b = store.local.windowBounds;
  win = new BrowserWindow({
    width: b?.width ?? 1280,
    height: b?.height ?? 860,
    x: b?.x,
    y: b?.y,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Marigold',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 13 },
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1a17' : '#f4f1ea',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  tabs = new TabManager(win, store, broadcast);
  tabs.onFound = (r) => win?.webContents.send('found', r);
  // The chrome UI is a fixed local page: it never navigates or opens windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win?.show());
  const saveBounds = () => win && !win.isDestroyed() && !win.isFullScreen() && store.setLocal({ windowBounds: win.getNormalBounds() });
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('focus', () => tabs.sweep());
  win.on('enter-full-screen', broadcast);
  win.on('leave-full-screen', broadcast);
  win.on('closed', () => {
    tabs.destroyAll();
    win = null;
  });
  if (tabs.activeId) tabs.activate(tabs.activeId);
}

function openFromArgs(argv: string[]) {
  for (const a of argv) {
    if (a.startsWith('marigold://')) {
      if (win) command({ pairingLink: a });
      else pendingLink = a;
    } else if (/^https?:\/\//.test(a) && tabs) tabs.create(a);
  }
}

app.on('second-instance', (_e, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  openFromArgs(argv.slice(1));
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  openFromArgs([url]);
});

app.whenReady().then(() => {
  if (!gotLock) return;
  store = new Store(app.getPath('userData'));
  assistant = new Assistant(() => store.local.cliPaths);
  sync = new SyncClient(store, broadcast);
  sync.aiProviders = () => providers.filter((p) => p.available).map((p) => ({ id: p.id, label: p.label }));
  app.setAsDefaultProtocolClient('marigold');

  const table = handlers();
  ipcMain.handle('invoke', async (e, name: string, payload: unknown) => {
    if (!win || e.sender !== win.webContents) throw new Error('forbidden');
    const h = Object.hasOwn(table, name) ? table[name] : null;
    if (!h) throw new Error(`unknown action ${name}`);
    return h(payload);
  });

  store.on('change', (id: string, origin: string) => {
    if (origin === 'remote') {
      if (id.startsWith('aireq:')) handleRelay(id);
      broadcast();
    }
  });
  store.on('remote-tabs', () => {
    if (!store.get<ProfileData>(`profile:${store.local.currentProfileId}`)) {
      const first = store.list<ProfileData>('profile').sort((a, b) => a.data.order - b.data.order)[0];
      if (first) store.setLocal({ currentProfileId: first.key });
    }
    tabs?.reconcile();
    broadcast();
  });

  buildMenu();
  createWindow();
  // End-to-end tests drive the main process through this handle.
  if (process.env.MARIGOLD_TEST) (globalThis as any).__marigold = { store, tabs: () => tabs, sync, assistant };
  openFromArgs(process.argv.slice(1));
  sync.start();
  void refreshProviders();

  setTimeout(() => tabs?.sweep(), 3000);
  setInterval(() => win && tabs.sweep(), 60_000);
  setInterval(() => sync.publishDevice(), 15 * 60_000);

  app.on('activate', () => {
    if (!win) createWindow();
    else win.show();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
app.on('before-quit', () => {
  assistant?.stopAll();
  store?.flush();
});

// Tabs that hold no page are plain records; nothing here may create windows on its own.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
