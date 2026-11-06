import { zipSync, unzipSync } from 'fflate';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validatePackage } from './validate-package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
await validatePackage(output, manifest);
const files = {};
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be packaged: ${relative}`);
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), `${relative}/`);
    else files[relative] = new Uint8Array(await readFile(path.join(directory, entry.name)));
  }
}
await collect(output);
const zip = zipSync(files, { level: 9 });
const restored = unzipSync(zip);
if (!restored['manifest.json'] || Object.keys(restored).length !== Object.keys(files).length) {
  throw new Error('ZIP verification failed.');
}
const release = path.join(root, 'release');
await mkdir(release, { recursive: true });
const target = path.join(release, `twitter-download-${manifest.version}.zip`);
await writeFile(target, zip);
console.log(`Packaged ${Object.keys(files).length} files → ${target} (${zip.length} bytes)`);
