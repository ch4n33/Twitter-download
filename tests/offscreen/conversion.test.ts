import { describe, expect, it, vi } from 'vitest';
import { fetchMp4Input, createOffscreenConversionHandler } from '../../src/offscreen/index';
import type { GifOffscreenCommand } from '../../src/conversion/protocol';

const EXTENSION_ID = 'offscreen-test-id';
const BACKGROUND_URL = `chrome-extension://${EXTENSION_ID}/background/index.js`;
const SOURCE_URL = 'https://video.twimg.com/ext_tw_video/123/pu/vid/720x1280/file.mp4';

function gifBuffer(signature = 'GIF89a'): ArrayBuffer {
  const bytes = new Uint8Array(14);
  for (let index = 0; index < 6; index += 1) bytes[index] = signature.charCodeAt(index) ?? 0;
  bytes[6] = 1;
  bytes[8] = 1;
  bytes[13] = 0x3b;
  return bytes.buffer;
}

function mp4Response(bytes = new Uint8Array([1, 2, 3]), url = SOURCE_URL): Response {
  const response = new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

class ControlledWorker {
  static created: ControlledWorker[] = [];
  static active = 0;
  static maxActive = 0;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  id = '';
  terminated = false;

  constructor(readonly url: string, readonly options?: WorkerOptions) {
    ControlledWorker.created.push(this);
    ControlledWorker.active += 1;
    ControlledWorker.maxActive = Math.max(ControlledWorker.maxActive, ControlledWorker.active);
  }

  postMessage(message: unknown): void {
    this.id = (message as { id: string }).id;
  }

  finish(buffer = gifBuffer()): void {
    this.onmessage?.({ data: { type: 'complete', id: this.id, buffer } } as MessageEvent<unknown>);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    ControlledWorker.active -= 1;
  }
}

function makeRuntime(options: { fetcher?: typeof fetch; worker?: typeof ControlledWorker } = {}) {
  const events: unknown[] = [];
  const revoked: string[] = [];
  let objectUrl = 0;
  const handler = createOffscreenConversionHandler({
    extensionId: EXTENSION_ID,
    extensionUrl: path => `chrome-extension://${EXTENSION_ID}/${path}`,
    sendEvent: async event => { events.push(event); },
    fetcher: options.fetcher ?? (async () => mp4Response()),
    WorkerConstructor: (options.worker ?? ControlledWorker) as unknown as new (url: string, options?: WorkerOptions) => Worker,
    createObjectURL: blob => {
      expect(blob.type).toBe('image/gif');
      objectUrl += 1;
      return `blob:chrome-extension://${EXTENSION_ID}/gif-${objectUrl}`;
    },
    revokeObjectURL: url => { revoked.push(url); },
    schedule: callback => { callback(); return undefined; },
    // The page itself cannot call chrome.offscreen.closeDocument; it requests a
    // close through a validated runtime event to the background service worker.
  });
  const sender = { id: EXTENSION_ID, url: BACKGROUND_URL };
  const send = (command: GifOffscreenCommand, from = sender): Promise<unknown> => new Promise(resolve => {
    handler(command, from, resolve);
  });
  return { handler, events, revoked, send };
}

describe('offscreen GIF conversion runtime', () => {
  it('fetches only allowed MP4 URLs with omitted credentials and enforces a stream size limit', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => mp4Response());
    const buffer = await fetchMp4Input(SOURCE_URL, { fetcher });
    expect(buffer.byteLength).toBe(3);
    expect(fetcher).toHaveBeenCalledWith(SOURCE_URL, expect.objectContaining({ credentials: 'omit' }));
    await expect(fetchMp4Input('https://example.com/file.mp4', { fetcher })).rejects.toThrow(/allowed X MP4/i);

    await expect(fetchMp4Input(SOURCE_URL, {
      fetcher: async () => mp4Response(new Uint8Array([1, 2, 3, 4])),
      maxBytes: 3,
    })).rejects.toThrow(/limit/i);
  });

  it('rejects untrusted senders and preserves an extension-owned GIF until release', async () => {
    ControlledWorker.created = [];
    ControlledWorker.active = 0;
    ControlledWorker.maxActive = 0;
    const runtime = makeRuntime();
    const rejected = await runtime.send({ target: 'gif-offscreen', type: 'gif.prepare', id: 'bad', url: SOURCE_URL }, {
      id: EXTENSION_ID, url: 'https://x.com/home',
    });
    expect(rejected).toMatchObject({ ok: false, error: 'invalid_sender' });
    expect(ControlledWorker.created).toHaveLength(0);

    await runtime.send({ target: 'gif-offscreen', type: 'gif.prepare', id: 'good', url: SOURCE_URL });
    await vi.waitFor(() => expect(ControlledWorker.created).toHaveLength(1));
    ControlledWorker.created[0]!.finish();
    await vi.waitFor(() => expect(runtime.events).toContainEqual(expect.objectContaining({ type: 'gif.complete', id: 'good' })));
    const status = await runtime.send({ target: 'gif-offscreen', type: 'gif.status', id: 'good' });
    expect(status).toMatchObject({ ok: true, status: { state: 'complete', progress: 100, url: `blob:chrome-extension://${EXTENSION_ID}/gif-1` } });
    expect(runtime.revoked).toEqual([]);

    await runtime.send({ target: 'gif-offscreen', type: 'gif.release', id: 'good' });
    expect(runtime.revoked).toEqual([`blob:chrome-extension://${EXTENSION_ID}/gif-1`]);
    expect(runtime.events).toContainEqual({ target: 'gif-background', type: 'gif.close-if-idle' });
  });

  it('serializes conversions to one worker and does not close while a queued item remains', async () => {
    ControlledWorker.created = [];
    ControlledWorker.active = 0;
    ControlledWorker.maxActive = 0;
    const runtime = makeRuntime();
    await runtime.send({ target: 'gif-offscreen', type: 'gif.prepare', id: 'first', url: SOURCE_URL });
    await runtime.send({ target: 'gif-offscreen', type: 'gif.prepare', id: 'second', url: SOURCE_URL });
    await vi.waitFor(() => expect(ControlledWorker.created).toHaveLength(1));
    expect(await runtime.send({ target: 'gif-offscreen', type: 'gif.status', id: 'second' }))
      .toMatchObject({ ok: true, status: { state: 'queued' } });
    expect(ControlledWorker.maxActive).toBe(1);

    ControlledWorker.created[0]!.finish();
    await vi.waitFor(() => expect(ControlledWorker.created).toHaveLength(2));
    expect(ControlledWorker.maxActive).toBe(1);
    expect(runtime.events).not.toContainEqual({ target: 'gif-background', type: 'gif.close-if-idle' });
    ControlledWorker.created[1]!.finish();
    await vi.waitFor(() => expect(runtime.events).toContainEqual(expect.objectContaining({ type: 'gif.complete', id: 'second' })));
    await runtime.send({ target: 'gif-offscreen', type: 'gif.release', id: 'first' });
    expect(runtime.events).not.toContainEqual({ target: 'gif-background', type: 'gif.close-if-idle' });
    await runtime.send({ target: 'gif-offscreen', type: 'gif.release', id: 'second' });
    expect(runtime.events).toContainEqual({ target: 'gif-background', type: 'gif.close-if-idle' });
  });

  it('rejects worker output without a GIF signature and trailer', async () => {
    ControlledWorker.created = [];
    ControlledWorker.active = 0;
    ControlledWorker.maxActive = 0;
    const runtime = makeRuntime();
    await runtime.send({ target: 'gif-offscreen', type: 'gif.prepare', id: 'invalid-output', url: SOURCE_URL });
    await vi.waitFor(() => expect(ControlledWorker.created).toHaveLength(1));
    ControlledWorker.created[0]!.finish(gifBuffer('NOTGIF'));
    await vi.waitFor(() => expect(runtime.events).toContainEqual(expect.objectContaining({ type: 'gif.error', id: 'invalid-output' })));
    expect(await runtime.send({ target: 'gif-offscreen', type: 'gif.status', id: 'invalid-output' }))
      .toMatchObject({ ok: true, status: { state: 'failed', error: expect.stringMatching(/valid GIF/i) } });
  });
});
