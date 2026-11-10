import { MEDIA_METADATA_BRIDGE, parseXPostMediaMetadata, type XPostMediaMetadata } from '../x/media-metadata';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAGE_CACHE_LIMIT = 200;
const GRAPHQL_OPERATIONS = new Set([
  'HomeTimeline', 'HomeLatestTimeline', 'TweetDetail', 'TweetResultByRestId',
  'UserTweets', 'UserTweetsAndReplies', 'UserMedia', 'SearchTimeline', 'ExploreTimeline',
  'Bookmarks', 'Likes', 'ListLatestTweetsTimeline', 'ListTweetsTimeline',
]);

interface BridgeEnvelope {
  protocol: typeof MEDIA_METADATA_BRIDGE;
  type: 'hello' | 'ready' | 'metadata';
  metadata?: XPostMediaMetadata;
}

function isXHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com';
}

function requestUrl(target: Window, input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  try {
    const url = new URL(raw, target.location.href);
    if (url.origin !== target.location.origin) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'i' || parts[1] !== 'api' || parts[2] !== 'graphql' || parts.length !== 5) return null;
    const operation = parts[4];
    return GRAPHQL_OPERATIONS.has(operation) ? url.href : null;
  } catch {
    return null;
  }
}

function jsonResponse(response: Response): boolean {
  return response.ok && !response.bodyUsed
    && /(?:application|text)\/(?:[^;]+\+)?json\b/i.test(response.headers.get('content-type') ?? '');
}

async function readLimitedText(response: Response): Promise<string | null> {
  const clone = response.clone();
  const body = clone.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** Installs the bounded MAIN-world network observer; it never alters API responses or sends requests. */
export function installPageMediaCapture(target: Window = window): () => void {
  if (!isXHost(target.location.hostname)) return () => undefined;
  const globalTarget = target as Window & typeof globalThis;
  const cache = new Map<string, XPostMediaMetadata>();
  const listener = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== target.location.origin) return;
    const data = event.data as Partial<BridgeEnvelope> | null;
    if (!data || data.protocol !== MEDIA_METADATA_BRIDGE || data.type !== 'ready') return;
    for (const metadata of cache.values()) sendMetadata(target, metadata);
  };
  target.addEventListener('message', listener);

  const capture = (payload: unknown) => {
    for (const metadata of parseXPostMediaMetadata(payload)) {
      cache.delete(metadata.postId);
      cache.set(metadata.postId, metadata);
      while (cache.size > PAGE_CACHE_LIMIT) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      sendMetadata(target, metadata);
    }
  };

  const originalFetch = globalTarget.fetch;
  const wrappedFetch: typeof globalThis.fetch = function (this: typeof globalThis, input, init) {
    const matched = requestUrl(target, input);
    const result = Reflect.apply(originalFetch, this, [input, init]) as Promise<Response>;
    if (!matched) return result;
    void result.then(async response => {
      try {
        if (!jsonResponse(response)) return;
        const body = await readLimitedText(response);
        if (body === null || new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) return;
        capture(JSON.parse(body) as unknown);
      } catch {
        // A failed clone, oversized body, or malformed JSON is ignored; the original response is untouched.
      }
    }).catch(() => undefined);
    return result;
  };
  globalTarget.fetch = wrappedFetch;

  const xhrPrototype = globalTarget.XMLHttpRequest?.prototype;
  const originalOpen = xhrPrototype?.open;
  const originalSend = xhrPrototype?.send;
  const trackedXhr = new WeakSet<XMLHttpRequest>();
  let wrappedOpen: typeof XMLHttpRequest.prototype.open | null = null;
  let wrappedSend: typeof XMLHttpRequest.prototype.send | null = null;
  if (xhrPrototype && originalOpen && originalSend) {
    const openHook = function (
      this: XMLHttpRequest,
      method: string,
      address: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      const xhr = this;
      const url = requestUrl(target, address instanceof URL ? address : String(address));
      if (url) trackedXhr.add(xhr);
      else trackedXhr.delete(xhr);
      const args: unknown[] = [method, address];
      if (async !== undefined) args.push(async);
      if (username !== undefined) args.push(username);
      if (password !== undefined) args.push(password);
      return Reflect.apply(originalOpen!, xhr, args);
    };
    const sendHook = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const xhr = this;
      if (trackedXhr.has(xhr)) {
        xhr.addEventListener('load', () => {
          if (xhr.status < 200 || xhr.status >= 300) return;
          try {
            if ((xhr.responseType === '' || xhr.responseType === 'text')
              && xhr.responseText.length <= MAX_RESPONSE_BYTES) {
              capture(JSON.parse(xhr.responseText) as unknown);
            }
          } catch {
            // Ignore non-JSON and malformed responses.
          }
        }, { once: true });
      }
      return arguments.length === 0
        ? Reflect.apply(originalSend!, xhr, [])
        : Reflect.apply(originalSend!, xhr, [body]);
    };
    wrappedOpen = openHook as typeof XMLHttpRequest.prototype.open;
    wrappedSend = sendHook as typeof XMLHttpRequest.prototype.send;
    xhrPrototype.open = wrappedOpen;
    xhrPrototype.send = wrappedSend;
  }

  target.postMessage({ protocol: MEDIA_METADATA_BRIDGE, type: 'hello' } satisfies BridgeEnvelope, target.location.origin);

  return () => {
    target.removeEventListener('message', listener);
    if (globalTarget.fetch === wrappedFetch) globalTarget.fetch = originalFetch;
    if (xhrPrototype && wrappedOpen && xhrPrototype.open === wrappedOpen && originalOpen) xhrPrototype.open = originalOpen;
    if (xhrPrototype && wrappedSend && xhrPrototype.send === wrappedSend && originalSend) xhrPrototype.send = originalSend;
    cache.clear();
  };
}

function sendMetadata(target: Window, metadata: XPostMediaMetadata): void {
  const message: BridgeEnvelope = { protocol: MEDIA_METADATA_BRIDGE, type: 'metadata', metadata };
  target.postMessage(message, target.location.origin);
}

// This file is also built as the document_start MAIN-world entry.
if (typeof window !== 'undefined') installPageMediaCapture(window);
