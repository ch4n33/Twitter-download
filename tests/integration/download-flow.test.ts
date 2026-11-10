// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createBackgroundDownloadService } from '../../src/background/download-service';
import { buildRelativePath } from '../../src/core/paths';
import type {
  FileDownload,
  Settings,
  TransportDownload,
} from '../../src/core/types';
import { readPostSnapshot } from '../../src/x/post-reader';

class MemorySessionStorage {
  readonly values: Record<string, unknown> = {};

  async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values[key] = structuredClone(value);
  }
}

function makePostElement(): HTMLElement {
  document.body.innerHTML = `
    <article data-testid="tweet">
      <div data-testid="User-Name">
        <a href="/sample_user"><span>Sample User</span></a>
      </div>
      <a href="/sample_user/status/2118530055324254686">
        <time datetime="2026-11-06T10:00:00Z">Nov 6</time>
      </a>
      <div data-testid="tweetText">Two photos from the coast.</div>
      <div data-testid="mediaCarousel">
        <a href="/sample_user/status/2118530055324254686/photo/1">
          <div data-testid="tweetPhoto">
            <img alt="Coast in the morning" src="https://pbs.twimg.com/media/coast-morning.jpg?format=jpg&amp;name=small">
          </div>
        </a>
        <a href="/sample_user/status/2118530055324254686/photo/2" style="display: none">
          <div data-testid="tweetPhoto">
            <img alt="Coast in the evening" src="https://pbs.twimg.com/media/coast-evening.webp?format=webp&amp;name=small">
          </div>
        </a>
      </div>
    </article>`;
  const post = document.querySelector<HTMLElement>('article[data-testid="tweet"]');
  if (!post) throw new Error('post fixture was not mounted');
  return post;
}

function fakeTransport() {
  let nextId = 700;
  const starts: FileDownload[] = [];
  const records = new Map<number, TransportDownload>();
  return {
    starts,
    records,
    async start(file: FileDownload): Promise<number> {
      starts.push({ ...file });
      const id = nextId++;
      records.set(id, { id, state: 'in_progress' });
      return id;
    },
    async get(id: number): Promise<TransportDownload | null> {
      return records.get(id) ?? null;
    },
  };
}

function trustedSender() {
  return {
    id: 'test-extension-id',
    tab: { id: 23 },
    frameId: 0,
    url: 'https://x.com/sample_user/status/2118530055324254686',
  };
}

const SETTINGS: Settings = {
  version: 1,
  subdirectory: 'archive',
  grouping: 'author',
  filename: 'post',
  originalSize: true,
  saveGifAsGif: true,
};

describe('X photo DOM to background download flow', () => {
  it('keeps the complete carousel order, planned paths, and terminal job states aligned', async () => {
    const read = readPostSnapshot(makePostElement());
    expect(read).not.toBeNull();
    if (!read) throw new Error('X post could not be read');

    const { snapshot } = read;
    expect(snapshot).toMatchObject({
      postId: '2118530055324254686',
      authorHandle: '@sample_user',
      expectedPhotoCount: 2,
      completeness: 'complete',
    });
    expect(snapshot.photos.map(photo => photo.index)).toEqual([1, 2]);
    expect(snapshot.photos.map(photo => photo.extension)).toEqual(['jpg', 'webp']);
    expect(snapshot.photos.map(photo => photo.originalFilename)).toEqual(['coast-morning.jpg', 'coast-evening.webp']);
    expect(snapshot.photos.map(photo => read.photoTargets.has(photo.key))).toEqual([true, true]);

    const storage = new MemorySessionStorage();
    const transport = fakeTransport();
    const jobTime = new Date(2026, 10, 6, 13, 15, 0);
    const service = createBackgroundDownloadService({
      extensionId: 'test-extension-id',
      storage,
      transport,
      loadSettings: async () => SETTINGS,
      now: () => jobTime,
      createId: () => 'carousel-job',
    });

    const started = await service.handleMessage({
      type: 'download.start',
      requestId: 'carousel-request',
      post: snapshot,
      selection: 'all',
    }, trustedSender());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    expect(started.job.state).toBe('in_progress');
    expect(started.job.items.map(item => item.index)).toEqual([1, 2]);

    const expectedTargets = snapshot.photos.map(photo => {
      const result = buildRelativePath(snapshot, photo, SETTINGS, { now: jobTime });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.relativePath;
    });
    expect(expectedTargets).toEqual([
      'archive/@sample_user/sample_user-2118530055324254686-1.jpg',
      'archive/@sample_user/sample_user-2118530055324254686-2.webp',
    ]);
    expect(transport.starts.map(file => file.relativePath)).toEqual(expectedTargets);
    expect(transport.starts.map(file => file.url)).toEqual(snapshot.photos.map(photo => photo.originalUrl));
    for (const { relativePath } of transport.starts) {
      expect(relativePath.startsWith('/')).toBe(false);
      expect(relativePath.startsWith('~')).toBe(false);
      expect(relativePath).not.toContain('/~');
      expect(/^[a-z]:[\\/]/i.test(relativePath)).toBe(false);
    }

    const firstDownloadId = started.job.items[0]?.downloadId;
    const secondDownloadId = started.job.items[1]?.downloadId;
    if (firstDownloadId === null || firstDownloadId === undefined
      || secondDownloadId === null || secondDownloadId === undefined) {
      throw new Error('the fake transport did not return both download IDs');
    }
    transport.records.set(firstDownloadId, { id: firstDownloadId, state: 'complete', mime: 'image/jpeg' });
    transport.records.set(secondDownloadId, { id: secondDownloadId, state: 'interrupted', error: 'connection lost' });
    await service.handleTransportChange({ id: firstDownloadId, state: 'complete' });
    await service.handleTransportChange({ id: secondDownloadId, state: 'interrupted', error: 'connection lost' });

    const partial = await service.handleMessage({ type: 'download.getStatus', jobId: started.job.id }, trustedSender());
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error(partial.error.message);
    expect(partial.job.state).toBe('partial');
    expect(partial.job.items.map(item => item.state)).toEqual(['complete', 'failed']);

    const individual = await service.handleMessage({
      type: 'download.start',
      requestId: 'second-photo-only',
      post: snapshot,
      selection: { photoKeys: [snapshot.photos[1]!.key] },
    }, trustedSender());
    expect(individual.ok).toBe(true);
    if (!individual.ok) throw new Error(individual.error.message);
    expect(individual.job.items.map(item => item.index)).toEqual([2]);
    expect(transport.starts[2]).toMatchObject({
      url: snapshot.photos[1]!.originalUrl,
      relativePath: expectedTargets[1],
    });
    const individualId = individual.job.items[0]?.downloadId;
    if (individualId === null || individualId === undefined) throw new Error('the single-photo download ID is missing');
    transport.records.set(individualId, { id: individualId, state: 'complete', mime: 'image/webp' });
    await service.handleTransportChange({ id: individualId, state: 'complete' });
    const completed = await service.handleMessage({ type: 'download.getStatus', jobId: individual.job.id }, trustedSender());
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw new Error(completed.error.message);
    expect(completed.job.state).toBe('complete');
    expect(completed.job.items[0]).toMatchObject({ index: 2, state: 'complete' });
  });
});
