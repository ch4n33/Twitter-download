// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaMetadataBridge } from '../../src/content/media-bridge';
import { installPageMediaCapture } from '../../src/content/page-media';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis };
};

const responsePayload = {
  data: { tweetResult: { result: {
    rest_id: '710044',
    legacy: { id_str: '710044', extended_entities: { media: [{
      id_str: '71001', type: 'video', video_info: { variants: [
        { content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/71001/pu/vid/clip.mp4', bitrate: 256000 },
      ] },
    }] } },
  } } },
};

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('media metadata page bridge', () => {
  let dom: { window: Window & typeof globalThis } | null = null;
  let disposePage: (() => void) | null = null;
  let bridge: ReturnType<typeof createMediaMetadataBridge> | null = null;
  let restorePostMessage: (() => void) | null = null;

  afterEach(() => {
    bridge?.stop();
    disposePage?.();
    restorePostMessage?.();
    dom?.window.close();
    bridge = null;
    disposePage = null;
    restorePostMessage = null;
    dom = null;
  });

  it('captures only an allowlisted fetch response clone, preserves the original response, and replays cache on ready', async () => {
    dom = new JSDOM('', { url: 'https://x.com/' });
    const target = dom.window;
    restorePostMessage = emulateSameWindowPostMessage(target);
    const original = new Response(JSON.stringify(responsePayload), {
      status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    const fetchStub = vi.fn(async () => original);
    target.fetch = fetchStub as typeof globalThis.fetch;
    disposePage = installPageMediaCapture(target);

    const returned = await target.fetch('/i/api/graphql/query/HomeTimeline?variables=%7B%7D');
    expect(returned).toBe(original);
    await tick();
    expect(original.bodyUsed).toBe(false);
    expect(await returned.json()).toEqual(responsePayload);

    const onChange = vi.fn();
    bridge = createMediaMetadataBridge(target, onChange);
    await tick();
    expect(bridge.get('710044')?.assets[0]?.url).toBe('https://video.twimg.com/ext_tw_video/71001/pu/vid/clip.mp4');
    expect(onChange).toHaveBeenCalledWith('710044');

    const unrelated = new Response(JSON.stringify(responsePayload), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    fetchStub.mockResolvedValueOnce(unrelated);
    await target.fetch('/i/api/graphql/query/DirectMessages?variables=%7B%7D');
    await tick();
    expect(bridge.get('710044')).not.toBeNull();
    expect(unrelated.bodyUsed).toBe(false);
  });

  it('captures allowlisted XHR text without replacing its response or changing unrelated endpoints', async () => {
    dom = new JSDOM('', { url: 'https://x.com/' });
    const target = dom.window;
    restorePostMessage = emulateSameWindowPostMessage(target);
    const prototype = target.XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    Object.defineProperty(prototype, 'open', {
      configurable: true,
      value: function (this: XMLHttpRequest, _method: string, _url: string | URL) { return undefined; },
    });
    Object.defineProperty(prototype, 'send', {
      configurable: true,
      value: function (this: XMLHttpRequest) {
        Object.defineProperties(this, {
          status: { configurable: true, value: 200 },
          responseType: { configurable: true, value: '' },
          responseText: { configurable: true, value: JSON.stringify(responsePayload) },
        });
        this.dispatchEvent(new target.Event('load'));
      },
    });
    disposePage = installPageMediaCapture(target);
    bridge = createMediaMetadataBridge(target);

    const xhr = new target.XMLHttpRequest();
    xhr.open('GET', '/i/api/graphql/query/TweetDetail');
    xhr.send();
    await tick();
    expect(bridge.get('710044')?.expectedMediaCount).toBe(1);
    expect(xhr.responseText).toBe(JSON.stringify(responsePayload));

    const unrelated = new target.XMLHttpRequest();
    unrelated.open('GET', '/i/api/graphql/query/DirectMessages');
    unrelated.send();
    await tick();
    expect(bridge.get('710044')?.assets).toHaveLength(1);

    disposePage?.();
    disposePage = null;
    Object.defineProperty(prototype, 'open', { configurable: true, value: originalOpen });
    Object.defineProperty(prototype, 'send', { configurable: true, value: originalSend });
  });

  it('rejects forged-origin and malformed bridge messages', async () => {
    dom = new JSDOM('', { url: 'https://x.com/' });
    const target = dom.window;
    restorePostMessage = emulateSameWindowPostMessage(target);
    bridge = createMediaMetadataBridge(target);
    const forged = new target.MessageEvent('message', {
      source: target,
      origin: 'https://attacker.example',
      data: { protocol: 'x-media-metadata-v1', type: 'metadata', metadata: responsePayload },
    });
    target.dispatchEvent(forged);
    const malformed = new target.MessageEvent('message', {
      source: target,
      origin: 'https://x.com',
      data: { protocol: 'x-media-metadata-v1', type: 'metadata', metadata: { postId: '710044' } },
    });
    target.dispatchEvent(malformed);
    await tick();
    expect(bridge.get('710044')).toBeNull();
  });
});

function emulateSameWindowPostMessage(target: Window & typeof globalThis): () => void {
  const original = target.postMessage;
  target.postMessage = ((message: unknown, targetOrigin: string) => {
    if (targetOrigin !== target.location.origin) return;
    target.setTimeout(() => target.dispatchEvent(new target.MessageEvent('message', {
      source: target,
      origin: target.location.origin,
      data: message,
    })), 0);
  }) as typeof target.postMessage;
  return () => { target.postMessage = original; };
}
