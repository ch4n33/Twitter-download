// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createContentController } from '../../src/content/controller';
import { createBackgroundDownloadService } from '../../src/background/download-service';
import type { DownloadJob, FileDownload, TransportDownload } from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { parseXPostMediaMetadata } from '../../src/x/media-metadata';
import { readPostSnapshot } from '../../src/x/post-reader';

const html = readFileSync(resolve('tests/fixtures/x/mixed-media.html'), 'utf8');
const payload = JSON.parse(readFileSync(resolve('tests/fixtures/x/mixed-media.json'), 'utf8'));

describe('mixed media PoC end to end', () => {
  it('shows GIF conversion before downloading the actual GIF output when the new default is enabled', async () => {
    document.body.innerHTML = html;
    const metadata = parseXPostMediaMetadata(payload);
    const lookup = (postId: string) => metadata.find(item => item.postId === postId) ?? null;
    const post = document.querySelector<HTMLElement>('article')!;
    const storage: Record<string, unknown> = {};
    const starts: FileDownload[] = [];
    const records = new Map<number, TransportDownload>();
    const released = vi.fn(async () => undefined);
    let notify: ((job: DownloadJob) => void) | null = null;
    let progress: ((value: number) => void) | null = null;
    let finish: ((value: { url: string }) => void) | null = null;
    const prepare = vi.fn((_id: string, _url: string, onProgress: (value: number) => void) => {
      progress = onProgress;
      return new Promise<{ url: string }>(resolve => { finish = resolve; });
    });
    const service = createBackgroundDownloadService({
      extensionId: 'gif-poc',
      storage: { async get() { return structuredClone(storage); }, async set(items) { Object.assign(storage, structuredClone(items)); } },
      transport: {
        async start(file) { starts.push(file); records.set(1, { id: 1, state: 'in_progress' }); return 1; },
        async get(id) { return records.get(id) ?? null; },
      },
      converter: { prepare, reconnect: async () => { throw new Error('No prior conversion'); }, release: released },
      loadSettings: async () => ({ ...DEFAULT_SETTINGS, filename: 'post' }),
      notify: job => { notify?.(job); },
    });
    const sender = { id: 'gif-poc', tab: { id: 77 }, frameId: 0, url: 'https://x.com/poc_author/status/883004' };
    const controller = createContentController(document, {
      readPost: element => readPostSnapshot(element, lookup),
      sendDownloadRequest: request => service.handleMessage(request, sender),
      getDownloadStatus: jobId => service.handleMessage({ type: 'download.getStatus', jobId }, sender),
      subscribeDownloadStatus(callback) { notify = callback; return () => { notify = null; }; },
    });
    controller.start();
    try {
      const snapshot = readPostSnapshot(post, lookup)!.snapshot;
      const key = snapshot.photos.find(media => media.kind === 'animated_gif')!.key;
      const read = readPostSnapshot(post, lookup)!;
      read.photoTargets.get(key)!.querySelector<HTMLButtonElement>('button')!.click();
      await vi.waitFor(() => expect(post.querySelector('.x-download-status')!.textContent).toContain('GIF 변환 중'));
      expect(starts).toHaveLength(0);
      expect(prepare).toHaveBeenCalledWith(expect.any(String), 'https://video.twimg.com/tweet_video/LoopPoC.mp4', expect.any(Function));
      (progress as unknown as (value: number) => void)(42);
      await vi.waitFor(() => expect(post.querySelector('.x-download-status')!.textContent).toContain('42%'));
      (finish as unknown as (value: { url: string }) => void)({ url: 'blob:chrome-extension://gif-poc/generated-gif' });
      await vi.waitFor(() => expect(starts).toHaveLength(1));
      expect(starts[0]).toMatchObject({ relativePath: 'poc_author-883004-3.gif', url: 'blob:chrome-extension://gif-poc/generated-gif' });
      records.set(1, { id: 1, state: 'complete', mime: 'image/gif' });
      await service.handleTransportChange({ id: 1, state: 'complete' });
      await vi.waitFor(() => expect(post.querySelector('.x-download-status')!.textContent).toContain('저장 완료'));
      expect(released).toHaveBeenCalled();
      expect(JSON.stringify(storage)).not.toContain('blob:');
    } finally { controller.stop(); document.body.replaceChildren(); }
  });

  it('resolves MP4 sources, downloads in attachment order, and retains compact success feedback', async () => {
    document.body.innerHTML = html;
    const metadata = parseXPostMediaMetadata(payload);
    expect(metadata.map(post => post.postId)).toEqual(['883004']);
    const post = document.querySelector<HTMLElement>('article')!;
    const lookup = (postId: string) => metadata.find(item => item.postId === postId) ?? null;
    const read = readPostSnapshot(post, lookup)!;
    expect(read.snapshot.completeness).toBe('complete');
    expect(read.snapshot.photos.map(item => [item.kind, item.index])).toEqual([
      ['image', 1], ['video', 2], ['animated_gif', 3],
    ]);

    const storage: Record<string, unknown> = {};
    const started: FileDownload[] = [];
    const downloads = new Map<number, TransportDownload>();
    let listener: ((job: DownloadJob) => void) | null = null;
    const service = createBackgroundDownloadService({
      extensionId: 'poc-extension',
      storage: { async get() { return structuredClone(storage); }, async set(items) { Object.assign(storage, structuredClone(items)); } },
      transport: {
        async start(file) {
          started.push(file);
          const id = started.length;
          downloads.set(id, { id, state: 'in_progress' });
          return id;
        },
        async get(id) { return downloads.get(id) ?? null; },
      },
      loadSettings: async () => ({ ...DEFAULT_SETTINGS, filename: 'post', originalSize: true, saveGifAsGif: false }),
      notify: job => { listener?.(job); },
    });
    const sender = { id: 'poc-extension', tab: { id: 53 }, frameId: 0, url: 'https://x.com/poc_author/status/883004' };
    const controller = createContentController(document, {
      readPost: element => readPostSnapshot(element, lookup),
      sendDownloadRequest: request => service.handleMessage(request, sender),
      getDownloadStatus: jobId => service.handleMessage({ type: 'download.getStatus', jobId }, sender),
      subscribeDownloadStatus(callback) { listener = callback; return () => { listener = null; }; },
    });
    controller.start();
    try {
      expect(post.querySelectorAll('[data-x-download-control="photo"]')).toHaveLength(3);
      post.querySelector<HTMLButtonElement>('[data-x-download-control="bulk"]')!.click();
      await vi.waitFor(() => expect(started).toHaveLength(3));
      expect(started.map(file => file.relativePath)).toEqual([
        'poc_author-883004-1.jpg', 'poc_author-883004-2.mp4', 'poc_author-883004-3.mp4',
      ]);
      expect(started[1]!.url).toContain('clip-high.mp4');
      expect(started[2]!.url).toBe('https://video.twimg.com/tweet_video/LoopPoC.mp4');
      expect(started.every(file => !file.url.startsWith('blob:') && !file.url.includes('.m3u8'))).toBe(true);
      // Let the controller adopt the async response before forwarding terminal events.
      await vi.waitFor(() => expect(post.querySelector('.x-download-status')!.textContent).toContain('저장 중'));
      for (const id of [1, 2, 3]) {
        downloads.set(id, { id, state: 'complete', mime: id === 1 ? 'image/jpeg' : 'video/mp4' });
        await service.handleTransportChange({ id, state: 'complete' });
      }
      expect(post.querySelector('.x-download-status')!.textContent).toContain('미디어 저장 완료');
      expect(post.querySelector('[data-x-download-control="bulk"]')?.getAttribute('data-download-state')).toBe('saved');
      expect(JSON.stringify(storage)).not.toContain('video.twimg.com');
      expect(JSON.stringify(storage)).not.toContain('blob:');
    } finally {
      controller.stop();
      document.body.replaceChildren();
    }
  });
});
