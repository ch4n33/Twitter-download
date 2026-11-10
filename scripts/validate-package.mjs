import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export async function validatePackage(directory, manifest) {
  if (manifest.manifest_version !== 3) throw new Error('Manifest V3 is required.');
  if (manifest.background?.type !== 'module') throw new Error('Background entry must be a module.');
  const files = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action.default_icon ?? {}),
    ...(manifest.content_scripts ?? []).flatMap(script => [...(script.js ?? []), ...(script.css ?? [])]),
    'THIRD_PARTY_NOTICES.txt',
    'licenses/material-symbols-Apache-2.0.txt',
    'licenses/mp4box-BSD-3-Clause.txt',
    'licenses/gifenc-MIT.txt',
    'offscreen/index.html',
    'offscreen/index.js',
    'conversion/gif-worker.js',
  ]);
  for (const relative of files) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      throw new Error(`Invalid package path: ${relative}`);
    }
    const info = await stat(path.join(directory, relative));
    if (!info.isFile() || info.size === 0) throw new Error(`Missing package file: ${relative}`);
  }
  const popupPath = manifest.action.default_popup;
  const popup = await readFile(path.join(directory, popupPath), 'utf8');
  if (/<script\b[^>]*\bsrc=["']https?:/i.test(popup) || /\son[a-z]+\s*=/i.test(popup)) {
    throw new Error('Popup scripts must be packaged locally and cannot use inline event handlers.');
  }
  for (const match of popup.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const relative = match[1];
    if (/^(?:https?:|data:|#)/i.test(relative)) continue;
    const target = path.resolve(directory, path.dirname(popupPath), relative);
    if (!target.startsWith(path.resolve(directory) + path.sep)) throw new Error('Popup reference escapes package.');
    if (!(await stat(target)).isFile()) throw new Error(`Missing popup resource: ${relative}`);
  }
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(['downloads', 'storage', 'offscreen'])) {
    throw new Error('Unexpected permissions in media-download PoC.');
  }
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://video.twimg.com/*'])) {
    throw new Error('GIF conversion must request only the exact X video host.');
  }
  const mainScript = manifest.content_scripts.find(script => script.world === 'MAIN');
  if (!mainScript || mainScript.run_at !== 'document_start'
    || JSON.stringify(mainScript.matches) !== JSON.stringify(['https://x.com/*'])) {
    throw new Error('The media bridge must run early and only on x.com.');
  }
}
