import type { ExtensionResponse } from '../core/types';
import { createChromeDownloadsTransport } from '../platform/downloads';
import { createChromeGifConverter } from '../platform/gif-converter';
import { createBackgroundDownloadService } from './download-service';

const transport = createChromeDownloadsTransport(chrome.downloads);
const converter = createChromeGifConverter(chrome);
const sessionStorage = {
  async get(key: string): Promise<Record<string, unknown>> {
    return chrome.storage.session.get(key) as Promise<Record<string, unknown>>;
  },
  async set(values: Record<string, unknown>): Promise<void> {
    await chrome.storage.session.set(values);
  },
};

const service = createBackgroundDownloadService({
  extensionId: chrome.runtime.id,
  storage: sessionStorage,
  transport,
  converter,
  notify: async job => {
    try {
      await chrome.tabs.sendMessage(
        job.tabId,
        { type: 'download.status', job },
        { frameId: job.frameId },
      );
    } catch {
      // The source tab or frame may have closed while Chrome continues the download.
    }
  },
});

// Register service-worker events at module evaluation, before asynchronous restore.
transport.subscribe(change => {
  void service.handleTransportChange(change).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && typeof message === 'object'
    && ((message as { target?: unknown }).target === 'gif-offscreen'
      || (message as { target?: unknown }).target === 'gif-background')) return false;
  void service.handleMessage(message, sender).then(
    response => sendResponse(response),
    () => sendResponse({
      ok: false,
      error: { code: 'background_error', message: 'The background download service failed.' },
    } satisfies ExtensionResponse),
  );
  return true;
});

// Restore conversion state after listeners are live so offscreen events can be rejoined.
void service.restore().catch(() => undefined);
