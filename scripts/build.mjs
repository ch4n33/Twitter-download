import { build } from 'esbuild';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validatePackage } from './validate-package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  target: 'chrome123',
  legalComments: 'eof',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
};

await Promise.all([
  build({ ...common, entryPoints: ['src/content/index.ts'], outfile: 'dist/content/index.js', format: 'iife' }),
  build({ ...common, entryPoints: ['src/content/page-media.ts'], outfile: 'dist/content/page-media.js', format: 'iife' }),
  build({ ...common, entryPoints: ['src/background/index.ts'], outfile: 'dist/background/index.js', format: 'esm' }),
  build({ ...common, entryPoints: ['src/popup/index.ts'], outfile: 'dist/popup/index.js', format: 'esm' }),
  build({ ...common, entryPoints: ['src/offscreen/index.ts'], outfile: 'dist/offscreen/index.js', format: 'esm' }),
  build({ ...common, entryPoints: ['src/conversion/gif-worker.ts'], outfile: 'dist/conversion/gif-worker.js', format: 'esm' }),
]);
await cp(path.join(root, 'manifest.json'), path.join(output, 'manifest.json'));
await cp(path.join(root, 'assets'), path.join(output, 'assets'), { recursive: true });
await cp(path.join(root, 'licenses'), path.join(output, 'licenses'), { recursive: true });
await cp(path.join(root, 'THIRD_PARTY_NOTICES.txt'), path.join(output, 'THIRD_PARTY_NOTICES.txt'));
await cp(path.join(root, 'src/content/content.css'), path.join(output, 'content/content.css'));
await cp(path.join(root, 'src/popup/popup.html'), path.join(output, 'popup/popup.html'));
await cp(path.join(root, 'src/popup/popup.css'), path.join(output, 'popup/popup.css'));
await cp(path.join(root, 'src/offscreen/index.html'), path.join(output, 'offscreen/index.html'));
const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== metadata.version) throw new Error('Manifest and package versions must match.');
await validatePackage(output, manifest);
console.log(`Built ${manifest.name} ${manifest.version} → ${output}`);
