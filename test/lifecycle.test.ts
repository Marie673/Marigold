import assert from 'node:assert/strict';
import { test } from 'node:test';
import { integrationFor, matchActions } from '../src/shared/integrations.ts';
import { autoBudgetMb, orderBetween, resolveInput, tabsToArchive, viewsToRelieve, viewsToSleep } from '../src/shared/lifecycle.ts';

const H = 3600_000;
const tab = (id: string, hoursIdle: number, o: Partial<{ pinned: boolean; archivedAt: number | null }> = {}) => ({
  id, pinned: false, archivedAt: null, lastActiveAt: 100 * H - hoursIdle * H, ...o,
});

test('only stale, unpinned, unarchived tabs are archived', () => {
  const tabs = [tab('fresh', 1), tab('stale', 13), tab('pinned', 500, { pinned: true }), tab('gone', 50, { archivedAt: 1 }), tab('kept', 30)];
  assert.deepEqual(tabsToArchive(tabs, 100 * H, 12 * H, new Set(['kept'])), ['stale']);
  assert.deepEqual(tabsToArchive(tabs, 100 * H, 0), [], '0 means never');
  assert.deepEqual(tabsToArchive([tab('edge', 12)], 100 * H, 12 * H), ['edge']);
});

test('background views sleep, active and audible ones do not', () => {
  const views = [
    { id: 'active', lastUsed: 0, audible: false },
    { id: 'music', lastUsed: 0, audible: true },
    { id: 'idle', lastUsed: 0, audible: false },
    { id: 'recent', lastUsed: 59 * 60_000, audible: false },
  ];
  assert.deepEqual(viewsToSleep(views, H, 30 * 60_000, 'active'), ['idle']);
  assert.deepEqual(viewsToSleep(views, H, 0, 'active'), []);
});

test('address bar input resolves to URLs or searches', () => {
  assert.equal(resolveInput('https://example.com/a b'), 'https://example.com/a b');
  assert.equal(resolveInput('example.com'), 'https://example.com');
  assert.equal(resolveInput('github.com/electron/electron'), 'https://github.com/electron/electron');
  assert.equal(resolveInput('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(resolveInput('192.168.1.5'), 'http://192.168.1.5');
  assert.equal(resolveInput('hello world'), 'https://www.google.com/search?q=hello%20world');
  assert.equal(resolveInput('node.js とは', 'duckduckgo'), 'https://duckduckgo.com/?q=node.js%20%E3%81%A8%E3%81%AF');
  assert.equal(resolveInput('what is a readme.md'), 'https://www.google.com/search?q=what%20is%20a%20readme.md');
  assert.equal(resolveInput('  '), '');
});

test('orderBetween places items between neighbours', () => {
  assert.equal(orderBetween(undefined, undefined), 1);
  assert.equal(orderBetween(1, 2), 1.5);
  assert.equal(orderBetween(3, undefined), 4);
  assert.equal(orderBetween(undefined, 3), 2);
});

test('integrations match hosts, badges and quick actions', () => {
  assert.equal(integrationFor('https://github.com/a/b/pull/1')?.id, 'github');
  assert.equal(integrationFor('https://mail.google.com/mail/u/0/')?.id, 'gmail');
  assert.equal(integrationFor('https://notgithub.com/'), null);
  assert.equal(integrationFor('nonsense'), null);
  const gmail = integrationFor('https://mail.google.com/')!;
  assert.equal(gmail.badge!('Inbox (12) - me@example.com - Gmail'), '12');
  assert.equal(gmail.badge!('Inbox - me@example.com - Gmail'), null);
  const hits = matchActions('gh electron fiddle', 'en');
  assert.equal(hits[0].url, 'https://github.com/search?q=electron%20fiddle');
  assert.equal(hits[0].label, 'Search GitHub: electron fiddle');
  assert.ok(matchActions('mail', 'ja').some((h) => h.action.id === 'gm-compose'));
  assert.deepEqual(matchActions('zzz', 'en'), []);
});

test('over budget: least recently used tabs go first, protected ones last, active never', () => {
  const v = (id: string, mb: number, lastUsed: number, isProtected = false) => ({ id, mb, lastUsed, protected: isProtected });
  const views = [v('active', 500, 9), v('old', 300, 1), v('typing', 400, 0, true), v('mid', 200, 2), v('new', 100, 3)];
  assert.deepEqual(viewsToRelieve(views, 1800, 2000, 'active'), [], 'under budget');
  assert.deepEqual(viewsToRelieve(views, 1800, 1400, 'active'), ['old', 'mid']);
  assert.deepEqual(viewsToRelieve(views, 1800, 600, 'active'), ['old', 'mid', 'new', 'typing']);
  assert.deepEqual(viewsToRelieve(views, 1800, 0, 'active'), [], '0 disables the budget');
  assert.equal(autoBudgetMb(8192), 2048);
  assert.equal(autoBudgetMb(2048), 1536);
  assert.equal(autoBudgetMb(65536), 6144);
});
