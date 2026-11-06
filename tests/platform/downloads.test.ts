import { describe, expect, it, vi } from 'vitest';
import type { FileDownload } from '../../src/core/types';
import { createChromeDownloadsTransport } from '../../src/platform/downloads';

function fakeDownloadsApi() {
  const listeners = new Set<(delta: { id: number; state?: { current?: string }; error?: { current?: string } }) => void>();
  const starts: Array<Record<string, unknown>> = [];
  const items = new Map<number, { id: number; state: string; mime?: string; error?: string }>();
  return {
    starts,
    items,
    listeners,
    download: vi.fn(async (options: Record<string, unknown>) => {
      starts.push(options);
      const id = 8;
      items.set(id, { id, state: 'in_progress' });
      return id;
    }),
    search: vi.fn(async ({ id }: { id: number }) => {
      const item = items.get(id);
      return item ? [item] : [];
    }),
    onChanged: {
      addListener: vi.fn((listener: (delta: { id: number; state?: { current?: string }; error?: { current?: string } }) => void) => listeners.add(listener)),
      removeListener: vi.fn((listener: (delta: { id: number; state?: { current?: string }; error?: { current?: string } }) => void) => listeners.delete(listener)),
    },
  };
}

describe('Chrome downloads transport', () => {
  it('starts a prepared file with safe native conflict behavior', async () => {
    const api = fakeDownloadsApi();
    const transport = createChromeDownloadsTransport(api);
    const file: FileDownload = { url: 'https://pbs.twimg.com/media/a.jpg', relativePath: 'saved/a.jpg' };

    await expect(transport.start(file)).resolves.toBe(8);
    expect(api.download).toHaveBeenCalledWith({
      url: file.url,
      filename: file.relativePath,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  });

  it('reads native state and forwards changes until unsubscribed', async () => {
    const api = fakeDownloadsApi();
    const transport = createChromeDownloadsTransport(api);
    await transport.start({ url: 'https://pbs.twimg.com/media/a.jpg', relativePath: 'a.jpg' });
    api.items.set(8, { id: 8, state: 'complete', mime: 'image/jpeg' });
    await expect(transport.get(8)).resolves.toEqual({ id: 8, state: 'complete', mime: 'image/jpeg' });
    await expect(transport.get(99)).resolves.toBeNull();

    const received: unknown[] = [];
    const unsubscribe = transport.subscribe(change => received.push(change));
    for (const listener of api.listeners) listener({ id: 8, state: { current: 'interrupted' }, error: { current: 'network_failed' } });
    expect(received).toEqual([{ id: 8, state: 'interrupted', error: 'network_failed' }]);
    unsubscribe();
    expect(api.listeners.size).toBe(0);
  });
});
