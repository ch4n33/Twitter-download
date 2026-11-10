import {
  isXPostMediaMetadata,
  MEDIA_METADATA_BRIDGE,
  type XPostMediaMetadata,
} from '../x/media-metadata';

const PAGE_CACHE_LIMIT = 200;

export interface MediaMetadataBridge {
  get(postId: string): XPostMediaMetadata | null;
  stop(): void;
}

interface BridgeMessage {
  protocol: typeof MEDIA_METADATA_BRIDGE;
  type: 'hello' | 'ready' | 'metadata';
  metadata?: unknown;
}

function isBridgeMessage(value: unknown): value is BridgeMessage {
  return value !== null && typeof value === 'object'
    && (value as { protocol?: unknown }).protocol === MEDIA_METADATA_BRIDGE
    && ['hello', 'ready', 'metadata'].includes((value as { type?: unknown }).type as string);
}

function copyMetadata(metadata: XPostMediaMetadata): XPostMediaMetadata {
  return { ...metadata, assets: metadata.assets.map(asset => ({ ...asset })) };
}

/** Receives only bounded, URL-validated metadata from the same page's MAIN-world capture script. */
export function createMediaMetadataBridge(
  target: Window,
  onChange?: (postId: string) => void,
): MediaMetadataBridge {
  const cache = new Map<string, XPostMediaMetadata>();
  const sendReady = () => {
    target.postMessage({ protocol: MEDIA_METADATA_BRIDGE, type: 'ready' } satisfies BridgeMessage, target.location.origin);
  };
  const listener = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== target.location.origin || !isBridgeMessage(event.data)) return;
    if (event.data.type === 'hello') {
      sendReady();
      return;
    }
    if (event.data.type !== 'metadata' || !isXPostMediaMetadata(event.data.metadata)) return;
    const metadata = event.data.metadata;
    const previous = cache.get(metadata.postId);
    if (previous && JSON.stringify(previous) === JSON.stringify(metadata)) return;
    cache.delete(metadata.postId);
    cache.set(metadata.postId, copyMetadata(metadata));
    while (cache.size > PAGE_CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    onChange?.(metadata.postId);
  };
  target.addEventListener('message', listener);
  sendReady();
  // MAIN and isolated scripts may start in either order; retry after the page listener is installed.
  const retryZero = target.setTimeout(sendReady, 0);
  const retryLater = target.setTimeout(sendReady, 100);

  return {
    get(postId: string): XPostMediaMetadata | null {
      const metadata = cache.get(postId);
      return metadata ? copyMetadata(metadata) : null;
    },
    stop(): void {
      target.removeEventListener('message', listener);
      target.clearTimeout(retryZero);
      target.clearTimeout(retryLater);
      cache.clear();
    },
  };
}
