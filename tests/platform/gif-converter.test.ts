import { describe, expect, it, vi } from 'vitest';
import type { GifOffscreenCommand } from '../../src/conversion/protocol';
import { createChromeGifConverter } from '../../src/platform/gif-converter';

const EXTENSION_ID = 'extension-id';
const OFFSCREEN_URL = `chrome-extension://${EXTENSION_ID}/offscreen/index.html`;

type MessageListener = (message: unknown, sender: { id?: string; url?: string }) => void;

function fakeChrome(options: {
  initialDocument?: boolean;
  command?: (message: GifOffscreenCommand) => unknown | Promise<unknown>;
} = {}) {
  let documentOpen = options.initialDocument ?? false;
  const commands: GifOffscreenCommand[] = [];
  const listeners: MessageListener[] = [];
  const runtime = {
    id: EXTENSION_ID,
    getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
    getContexts: vi.fn(async () => documentOpen ? [{
      contextType: 'OFFSCREEN_DOCUMENT', documentUrl: OFFSCREEN_URL,
    }] : []),
    sendMessage: vi.fn(async (message: GifOffscreenCommand) => {
      commands.push(message);
      return options.command?.(message);
    }),
    onMessage: { addListener: (listener: MessageListener) => { listeners.push(listener); } },
  };
  const offscreen = {
    createDocument: vi.fn(async () => { documentOpen = true; }),
    closeDocument: vi.fn(async () => { documentOpen = false; }),
  };
  return {
    api: { runtime, offscreen } as unknown as typeof chrome,
    commands,
    listeners,
    setDocumentOpen(value: boolean) { documentOpen = value; },
    offscreen,
  };
}

describe('Chrome GIF converter adapter', () => {
  it('creates the BLOBS and WORKERS document only for prepare and checks current status', async () => {
    const fake = fakeChrome({
      command: message => message.type === 'gif.prepare'
        ? { ok: true }
        : { ok: true, status: { state: 'complete', progress: 100, url: `blob:${OFFSCREEN_URL.replace('/offscreen/index.html', '/gif-result')}` } },
    });
    const converter = createChromeGifConverter(fake.api);
    const result = await converter.prepare('gif-job-0', 'https://video.twimg.com/ext_tw_video/123/pu/vid/720x1280/file.mp4', () => undefined);

    expect(result.url).toBe(`blob:chrome-extension://${EXTENSION_ID}/gif-result`);
    expect(fake.offscreen.createDocument).toHaveBeenCalledWith({
      url: 'offscreen/index.html',
      reasons: ['BLOBS', 'WORKERS'],
      justification: expect.any(String),
    });
    expect(fake.commands.map(command => command.type)).toEqual(['gif.prepare', 'gif.status']);
  });

  it('does not recreate an offscreen page during reconnect when its state is missing', async () => {
    const fake = fakeChrome();
    const converter = createChromeGifConverter(fake.api);

    await expect(converter.reconnect('lost-conversion', () => undefined)).rejects.toThrow(/was not restarted/i);
    expect(fake.offscreen.createDocument).not.toHaveBeenCalled();
    expect(fake.commands).toEqual([]);
  });

  it('accepts events only from the exact offscreen page and rejects foreign blob URLs', async () => {
    const fake = fakeChrome({
      initialDocument: true,
      command: message => message.type === 'gif.prepare'
        ? { ok: true }
        : { ok: true, status: { state: 'running', progress: 12 } },
    });
    const converter = createChromeGifConverter(fake.api);
    const pending = converter.prepare('active-conversion', 'https://video.twimg.com/ext_tw_video/123/pu/vid/720x1280/file.mp4', () => undefined);
    await vi.waitFor(() => expect(fake.commands.map(command => command.type)).toContain('gif.status'));

    const event = {
      target: 'gif-background', type: 'gif.complete', id: 'active-conversion',
      url: 'blob:https://x.com/not-owned',
    };
    fake.listeners[0]?.(event, { id: EXTENSION_ID, url: 'https://x.com/home' });
    fake.listeners[0]?.(event, { id: EXTENSION_ID, url: OFFSCREEN_URL });

    await expect(pending).rejects.toThrow(/outside this extension/i);
  });

  it('closes only after a trusted idle request confirms no other conversion is active', async () => {
    let idle = false;
    const fake = fakeChrome({
      initialDocument: true,
      command: message => message.type === 'gif.isIdle' ? { ok: true, idle } : { ok: true },
    });
    const converter = createChromeGifConverter(fake.api);
    const closeEvent = { target: 'gif-background', type: 'gif.close-if-idle' };
    fake.listeners[0]?.(closeEvent, { id: EXTENSION_ID, url: 'https://x.com/home' });
    fake.listeners[0]?.(closeEvent, { id: EXTENSION_ID, url: OFFSCREEN_URL });
    await vi.waitFor(() => expect(fake.commands).toHaveLength(1));
    expect(fake.offscreen.closeDocument).not.toHaveBeenCalled();

    idle = true;
    fake.listeners[0]?.(closeEvent, { id: EXTENSION_ID, url: OFFSCREEN_URL });
    await vi.waitFor(() => expect(fake.offscreen.closeDocument).toHaveBeenCalledTimes(1));
    expect(fake.commands.every(command => command.type === 'gif.isIdle')).toBe(true);
    void converter;
  });
});
