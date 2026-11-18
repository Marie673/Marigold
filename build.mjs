import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'chrome130' };

const targets = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' },
  {
    ...common, entryPoints: ['src/renderer/app.tsx'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife',
    jsx: 'automatic', jsxImportSource: 'preact', minify: !watch,
  },
];

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });
const copyStatic = () => {
  cpSync('src/renderer/index.html', 'dist/renderer/index.html');
  cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
};
copyStatic();

if (watch) {
  for (const t of targets) (await context(t)).watch();
} else {
  await Promise.all(targets.map((t) => build(t)));
}
