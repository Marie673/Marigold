// End-to-end test: drives the real app under Electron (run with `npm run test:e2e`).
// Set MARIGOLD_E2E_AI=1 to also exercise the assistant against the signed-in Claude CLI.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const electronPath = require('electron');
const out = join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });
const withAi = !!process.env.MARIGOLD_E2E_AI;

const pages = {
  '/a': '<title>Page A</title><h1>Alpha</h1><p>The secret codeword on this page is zanzibar-42.</p><a href="/b" target="_blank">open b</a>',
  '/b': '<title>Page B</title><h1>Beta</h1><p>Second page.</p>',
  '/c': '<title>Page C</title><h1>Gamma</h1>',
};
const site = createServer((req, res) => {
  const body = pages[req.url.split('?')[0]];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
  res.end(body ?? 'not found');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${site.address().port}`;

const syncPort = 18000 + Math.floor(Math.random() * 1000);
const syncProc = spawn(process.execPath, ['sync/server/server.ts'], {
  env: { ...process.env, PORT: String(syncPort), HOST: '127.0.0.1', MARIGOLD_DATA_DIR: mkdtempSync(join(tmpdir(), 'mg-sync-')) },
  stdio: 'inherit',
});
const syncUrl = `http://127.0.0.1:${syncPort}`;

async function launch(name) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['.', '--no-sandbox', '--lang=ja'],
    env: { ...process.env, MARIGOLD_USER_DATA: mkdtempSync(join(tmpdir(), `mg-${name}-`)), MARIGOLD_TEST: '1' },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.sidebar');
  return { app, ui };
}

const shot = (name) => {
  try {
    execFileSync('import', ['-window', 'root', join(out, `${name}.png`)], { stdio: 'ignore' });
  } catch {}
};
const step = (s) => console.log(`• ${s}`);
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

async function openTab(ui, input) {
  await ui.click('[data-testid=new-tab]');
  await ui.fill('[data-testid=command-input]', input);
  await ui.keyboard.press('Enter');
}
const titles = (ui, kind = 'tab') => ui.$$eval(`[data-testid=${kind}]`, (els) => els.map((e) => e.getAttribute('title')));

const a = await launch('a');
let b;
try {
  const { ui, app } = a;
  step('start page shows when there are no tabs');
  await ui.waitForSelector('[data-testid=start-page]');
  shot('01-start');

  step('command bar opens tabs');
  await openTab(ui, `${origin}/a`);
  await until(async () => (await titles(ui)).includes('Page A'), 'Page A tab');
  await openTab(ui, `${origin}/b`);
  await until(async () => (await titles(ui)).includes('Page B'), 'Page B tab');
  await openTab(ui, `${origin}/c`);
  await until(async () => (await titles(ui)).length === 3, 'three tabs');
  shot('02-tabs');

  step('new tab page offers quick actions and suggestions; Escape returns to the previous tab');
  await ui.click('[data-testid=new-tab]');
  await ui.fill('[data-testid=command-input]', 'gh electron');
  await ui.waitForSelector('[data-testid=cmd-act-gh-search]');
  shot('03-command-bar');
  await ui.fill('[data-testid=command-input]', 'Page A');
  await ui.waitForSelector('[data-testid=cmd-s-0]');
  shot('03b-suggestions');
  await ui.keyboard.press('Escape');
  await ui.waitForSelector('[data-testid=start-page]', { state: 'detached' });

  step('pinning moves a tab to the pinned group');
  const idOf = (title) => app.evaluate((_e, t) => globalThis.__marigold.tabs().tabViews().find((x) => x.title === t)?.id, title);
  const idA = await idOf('Page A');
  await app.evaluate((_e, id) => globalThis.__marigold.tabs().pin(id, true), idA);
  await until(async () => (await titles(ui, 'pinned-tab')).includes('Page A'), 'pinned Page A');
  assert.equal((await titles(ui)).length, 2);

  step('stale unpinned tabs are archived automatically; pinned and fresh ones stay');
  const idB = await idOf('Page B');
  const result = await app.evaluate((_e, [idA, idB]) => {
    const { store, tabs } = globalThis.__marigold;
    const old = Date.now() - 25 * 3600_000;
    store.patch(`tab:${idA}`, { lastActiveAt: old });
    store.patch(`tab:${idB}`, { lastActiveAt: old });
    return tabs().sweep();
  }, [idA, idB]);
  assert.deepEqual(result.archived, [idB]);
  await until(async () => (await titles(ui)).join() === 'Page C', 'only Page C left');
  assert.deepEqual(await titles(ui, 'pinned-tab'), ['Page A']);

  step('background tabs are unloaded from memory when idle');
  const slept = await app.evaluate(() => {
    const { tabs } = globalThis.__marigold;
    return tabs().sweep(Date.now() + 31 * 60_000).slept.length;
  });
  assert.equal(slept, 1, 'pinned Page A (background) sleeps; active Page C does not');
  await ui.waitForSelector('[data-testid=pinned-tab].asleep');

  step('archive lists the tab and restores it');
  await ui.click('button[title="アーカイブ"]');
  await ui.waitForSelector('[data-testid=archived-tab]');
  shot('04-archive');
  await ui.click('[data-testid=archived-tab] .list-main');
  await until(async () => (await titles(ui)).includes('Page B'), 'Page B restored');

  step('closing a tab archives it and reopen brings it back');
  await app.evaluate((_e, id) => globalThis.__marigold.tabs().close(id), idB);
  await until(async () => !(await titles(ui)).includes('Page B'), 'Page B closed');
  await app.evaluate(() => globalThis.__marigold.tabs().restoreLast());
  await until(async () => (await titles(ui)).includes('Page B'), 'Page B reopened');

  step('window.open from a page becomes a tab');
  await app.evaluate((_e, id) => {
    const t = globalThis.__marigold.tabs();
    t.activate(id);
    return new Promise((r) => setTimeout(r, 800)).then(() => t.webContents(id).executeJavaScript('document.querySelector("a").click()', true));
  }, idA);
  await until(async () => (await titles(ui)).filter((x) => x === 'Page B').length === 2, 'popup opened as tab');

  step('profiles have separate tabs and storage');
  await app.evaluate((_e, id) => globalThis.__marigold.tabs().webContents(id).executeJavaScript('localStorage.setItem("who", "personal")'), idA);
  await ui.click('button[title="設定"]');
  await ui.click('[data-testid=settings-profiles]');
  await ui.click('[data-testid=add-profile]');
  await until(async () => (await ui.$$('[data-testid=profile-row]')).length === 2, 'second profile');
  shot('05-settings-profiles');
  await ui.keyboard.press('Escape');
  await ui.waitForSelector('[data-testid=start-page]');
  assert.equal((await titles(ui)).length + (await titles(ui, 'pinned-tab')).length, 0, 'new profile starts empty');
  await openTab(ui, `${origin}/a`);
  await until(async () => (await titles(ui)).includes('Page A'), 'Page A in work profile');
  const who = await app.evaluate(async () => {
    const t = globalThis.__marigold.tabs();
    await new Promise((r) => setTimeout(r, 500));
    return t.activeWebContents().executeJavaScript('localStorage.getItem("who")');
  });
  assert.equal(who, null, 'storage is not shared between profiles');
  await ui.click('[data-testid=profile-button]');
  await ui.waitForSelector('[data-testid=profile-menu]');
  shot('06-profile-menu');
  await ui.click('[data-testid=profile-menu] button:first-child');
  await until(async () => (await titles(ui, 'pinned-tab')).includes('Page A'), 'back on first profile');

  step('assistant panel detects the signed-in CLI');
  await ui.click('[data-testid=ai-toggle]');
  await ui.waitForSelector('[data-testid=ai-panel]');
  const providers = await app.evaluate(() => globalThis.__marigold.assistant.detect());
  console.log('  providers:', providers.map((p) => `${p.id}=${p.available}`).join(' '));
  if (withAi) {
    step('assistant answers from the page content (real CLI call)');
    await app.evaluate((_e, id) => globalThis.__marigold.tabs().activate(id), idA);
    await until(async () => (await ui.$$eval('.tab.active', (e) => e.map((x) => x.title))).join() === 'Page A', 'Page A active in the UI');
    await ui.fill('[data-testid=ai-input]', 'What is the secret codeword on this page? Reply with just the codeword.');
    await ui.keyboard.press('Enter');
    await until(async () => (await ui.textContent('.msg.assistant:not([data-testid])').catch(() => '')) || (await ui.$('[data-testid=ai-error]')), 'assistant reply', 90000);
    const reply = await ui.textContent('.ai-scroll');
    assert.match(reply, /zanzibar-42/);
    shot('07-assistant');
  }

  step('sync: create account, pair a second device, tabs and pins arrive');
  await ui.click('button[title="設定"]');
  await ui.click('[data-testid=settings-sync]');
  await ui.fill('[data-testid=sync-server]', syncUrl);
  await ui.click('[data-testid=sync-create]');
  await until(async () => (await ui.textContent('[data-testid=sync-state]').catch(() => '')) === '同期中', 'sync ok');
  await ui.waitForSelector('.qr');
  await new Promise((r) => setTimeout(r, 300));
  shot('08-sync');
  await ui.keyboard.press('Escape');
  const link = await app.evaluate(() => globalThis.__marigold.sync.link());
  b = await launch('b');
  await b.ui.click('button[title="設定"]');
  await b.ui.click('[data-testid=settings-sync]');
  await b.ui.fill('[data-testid=sync-link]', link);
  await b.ui.click('[data-testid=sync-join]');
  await b.ui.keyboard.press('Escape');
  await until(async () => (await titles(b.ui, 'pinned-tab')).includes('Page A'), 'pinned tab synced to device B');
  assert.equal(await b.app.evaluate(() => globalThis.__marigold.store.list('profile').length), 2, 'pristine default profile was replaced by the synced ones');

  step('sync: a change on device B reaches device A live');
  await openTab(b.ui, `${origin}/c?from=b`);
  await until(async () => (await app.evaluate(() => globalThis.__marigold.store.list('tab').some((t) => t.data.url.endsWith('from=b')))), 'tab from B on A');

  if (withAi) {
    step('AI relay: device B asks, device A answers with its subscription');
    const devA = await app.evaluate(() => globalThis.__marigold.store.local.deviceId);
    await b.app.evaluate((_e, devA) => {
      globalThis.__marigold.store.put('aireq', 'relaytest1', { targetDeviceId: devA, provider: 'claude', messages: [{ role: 'user', content: 'Reply with exactly: pong' }], context: [] }, { expiresAt: Date.now() + 600_000 });
    }, devA);
    const res = await until(() => b.app.evaluate(() => {
      const r = globalThis.__marigold.store.get('aires:relaytest1');
      return r?.done ? r : null;
    }), 'relayed answer', 90000);
    assert.equal(res.error, null);
    assert.match(res.text, /pong/i);
  }
  console.log('\nE2E OK');
} finally {
  await a.app.close().catch(() => {});
  await b?.app.close().catch(() => {});
  syncProc.kill();
  site.close();
}
