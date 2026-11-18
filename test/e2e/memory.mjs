// Memory benchmark: `npm run bench:memory` (Linux; reads PSS from /proc).
// Reports the app's total memory idle, with heavy tabs awake, and after they sleep.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const TABS = Number(process.env.TABS) || 6;

// Each page holds ~40 MB of JS heap and a large DOM, like a typical web app.
const page = (n) => `<title>Heavy ${n}</title><body><script>
  window.keep = Array.from({ length: 40 }, () => new Uint8Array(1024 * 1024).fill(${n}));
  document.body.innerHTML = Array.from({ length: 4000 }, (_, i) => '<p>row ' + i + ' of page ${n}</p>').join('');
</script>`;
const site = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page(req.url.replace(/\D/g, '') || 0));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
// Different ports of 127.0.0.1 are different sites, so each tab gets its own process as on the real web.
const origin = `http://127.0.0.1:${site.address().port}`;

function tree(pid) {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const all = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, pp] of out) if (all.has(pp) && !all.has(p)) (all.add(p), (grew = true));
  }
  return [...all];
}
function pssMb(pid) {
  let kb = 0;
  let n = 0;
  for (const p of tree(pid)) {
    try {
      kb += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${p}/smaps_rollup`, 'utf8'))[1]);
      n++;
    } catch {}
  }
  return { mb: Math.round(kb / 1024), processes: n };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', '--no-sandbox', ...(process.env.MARIGOLD_FLAGS?.split(' ').filter(Boolean) ?? [])],
  env: { ...process.env, MARIGOLD_USER_DATA: mkdtempSync(join(tmpdir(), 'mg-mem-')), MARIGOLD_TEST: '1' },
});
const ui = await app.firstWindow();
await ui.waitForSelector('.sidebar');
const pid = app.process().pid;
await wait(4000);
const report = { idle: pssMb(pid) };

for (let i = 1; i <= TABS; i++) {
  await app.evaluate((_e, url) => globalThis.__marigold.tabs().create(url), `${origin}/${i}`);
  await wait(1200);
}
await wait(3000);
report[`${TABS} tabs awake`] = pssMb(pid);

// Memory limit: with a 550 MB budget the least recently used tabs are unloaded until the app fits.
const relieved = await app.evaluate(() => {
  const { store, tabs } = globalThis.__marigold;
  store.setLocal({ memoryBudgetMb: 550 });
  const before = tabs().memory().totalMb;
  const slept = tabs().sweep().slept.length;
  store.setLocal({ memoryBudgetMb: 0 });
  return { reportedBefore: before, slept };
});
await wait(4000);
report['550 MB limit'] = { ...pssMb(pid), ...relieved };

await app.evaluate(() => globalThis.__marigold.tabs().sweep(Date.now() + 3 * 3600_000));
await wait(4000);
report['idle tabs unloaded (1 awake)'] = pssMb(pid);

await app.evaluate(() => globalThis.__marigold.tabs().activate(null));
await app.evaluate(() => globalThis.__marigold.tabs().sweep(Date.now() + 6 * 3600_000));
await wait(4000);
report['all asleep'] = pssMb(pid);
console.log(JSON.stringify(report, null, 1));
await app.close();
site.close();
