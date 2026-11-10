import type { GifBackgroundEvent, GifConverter, GifOffscreenCommand, GifOffscreenStatus, PreparedGif } from '../conversion/protocol';

interface RuntimeMessageSender {
  id?: string;
  url?: string;
}

interface PendingConversion {
  promise: Promise<PreparedGif>;
  resolve(result: PreparedGif): void;
  reject(error: Error): void;
  onProgress(percent: number): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return fallback;
}

function isOffscreenStatus(value: unknown): value is GifOffscreenStatus {
  if (!isRecord(value) || !['missing', 'queued', 'running', 'complete', 'failed'].includes(String(value.state))) return false;
  if (typeof value.progress !== 'number' || !Number.isFinite(value.progress)) return false;
  if (value.url !== undefined && typeof value.url !== 'string') return false;
  if (value.error !== undefined && typeof value.error !== 'string') return false;
  return true;
}

function isBackgroundEvent(value: unknown): value is GifBackgroundEvent {
  if (!isRecord(value) || value.target !== 'gif-background') return false;
  if (value.type === 'gif.close-if-idle') return true;
  if (typeof value.id !== 'string') return false;
  if (value.type === 'gif.progress') return typeof value.progress === 'number' && Number.isFinite(value.progress);
  if (value.type === 'gif.complete') return typeof value.url === 'string';
  return value.type === 'gif.error' && typeof value.error === 'string';
}

/** Browser adapter that keeps Chrome APIs outside the generic download service. */
export function createChromeGifConverter(api: typeof chrome = chrome): GifConverter {
  const extensionId = api.runtime.id;
  const offscreenUrl = api.runtime.getURL('offscreen/index.html');
  const backgroundUrl = api.runtime.getURL('background/index.js');
  const pending = new Map<string, PendingConversion>();
  let creation: Promise<void> | null = null;
  let lifecycleTail: Promise<void> = Promise.resolve();

  const hasOffscreenDocument = async (): Promise<boolean> => {
    const contexts = await api.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    });
    return contexts.some(context => context.contextType === 'OFFSCREEN_DOCUMENT' && context.documentUrl === offscreenUrl);
  };

  const ensureOffscreenDocument = async (): Promise<void> => {
    if (await hasOffscreenDocument()) return;
    if (!creation) {
      creation = api.offscreen.createDocument({
        url: 'offscreen/index.html',
        reasons: ['BLOBS', 'WORKERS'],
        justification: 'Convert X animated GIF MP4 media locally and keep its temporary GIF URL alive during download.',
      }).catch(async cause => {
        if (await hasOffscreenDocument()) return;
        throw cause;
      }).finally(() => {
        creation = null;
      });
    }
    await creation;
  };

  const isOwnExtensionBlob = (value: string): boolean => {
    try {
      const url = new URL(value);
      const extensionBase = api.runtime.getURL('');
      return extensionBase.startsWith('chrome-extension://')
        && url.protocol === 'blob:' && value.startsWith(`blob:${extensionBase}`)
        && !url.search && !url.hash;
    } catch {
      return false;
    }
  };

  const settle = (id: string, result: PreparedGif | Error): void => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    if (result instanceof Error) item.reject(result);
    else item.resolve(result);
  };

  const serializedLifecycle = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleTail.then(operation, operation);
    lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const closeDocumentWhenIdle = async (): Promise<void> => {
    await serializedLifecycle(async () => {
      if (!await hasOffscreenDocument()) return;
      const response = await sendCommand({ target: 'gif-offscreen', type: 'gif.isIdle' });
      if (isRecord(response) && response.ok === true && response.idle === true) {
        await api.offscreen.closeDocument();
      }
    });
  };

  const onMessage = (message: unknown, sender: RuntimeMessageSender): void => {
    if (sender.id !== extensionId || sender.url !== offscreenUrl || !isBackgroundEvent(message)) return;
    if (message.type === 'gif.close-if-idle') {
      void closeDocumentWhenIdle().catch(() => undefined);
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    if (message.type === 'gif.progress') {
      item.onProgress(Math.max(0, Math.min(100, Math.round(message.progress))));
    } else if (message.type === 'gif.complete') {
      if (!isOwnExtensionBlob(message.url)) {
        settle(message.id, new Error('The GIF conversion returned a URL outside this extension.'));
      } else {
        settle(message.id, { url: message.url });
      }
    } else {
      settle(message.id, new Error(message.error || 'The GIF conversion failed.'));
    }
  };
  api.runtime.onMessage.addListener(onMessage);

  const watch = (id: string, onProgress: (percent: number) => void): PendingConversion => {
    const existing = pending.get(id);
    if (existing) return existing;
    let resolve!: (result: PreparedGif) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PreparedGif>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const item = { promise, resolve, reject, onProgress };
    pending.set(id, item);
    return item;
  };

  const sendCommand = async (message: GifOffscreenCommand): Promise<unknown> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        return await api.runtime.sendMessage(message);
      } catch (cause) {
        lastError = cause;
        if (attempt < 19) await new Promise(resolve => globalThis.setTimeout(resolve, 50));
      }
    }
    throw new Error(errorText(lastError, 'The GIF conversion page did not respond.'));
  };

  const readStatus = async (id: string): Promise<GifOffscreenStatus> => {
    const response = await sendCommand({ target: 'gif-offscreen', type: 'gif.status', id });
    if (!isRecord(response) || response.ok !== true || !isOffscreenStatus(response.status)) {
      throw new Error('The GIF conversion page returned an invalid status.');
    }
    return response.status;
  };

  const consumeStatus = (id: string, status: GifOffscreenStatus): void => {
    const item = pending.get(id);
    if (!item) return;
    item.onProgress(Math.max(0, Math.min(100, Math.round(status.progress))));
    if (status.state === 'complete') {
      if (status.url && isOwnExtensionBlob(status.url)) settle(id, { url: status.url });
      else settle(id, new Error('The GIF conversion result is missing an extension-owned URL.'));
    } else if (status.state === 'failed') {
      settle(id, new Error(status.error || 'The GIF conversion failed.'));
    } else if (status.state === 'missing') {
      settle(id, new Error('The GIF conversion state is missing; it was not restarted. Retry the download.'));
    }
  };

  return {
    async prepare(id, url, onProgress) {
      const tracked = watch(id, onProgress);
      try {
        await serializedLifecycle(async () => {
          await ensureOffscreenDocument();
          const response = await sendCommand({ target: 'gif-offscreen', type: 'gif.prepare', id, url });
          if (!isRecord(response) || response.ok !== true) {
            throw new Error(isRecord(response) && typeof response.error === 'string'
              ? response.error : 'The GIF conversion could not start.');
          }
          consumeStatus(id, await readStatus(id));
        });
      } catch (cause) {
        settle(id, new Error(errorText(cause, 'The GIF conversion could not start.')));
      }
      return tracked.promise;
    },

    async reconnect(id, onProgress) {
      const tracked = watch(id, onProgress);
      try {
        await serializedLifecycle(async () => {
          if (!await hasOffscreenDocument()) {
            throw new Error('The offscreen GIF conversion state is missing; it was not restarted. Retry the download.');
          }
          consumeStatus(id, await readStatus(id));
        });
      } catch (cause) {
        settle(id, new Error(errorText(cause, 'The GIF conversion could not be restored.')));
      }
      return tracked.promise;
    },

    async release(id) {
      await serializedLifecycle(async () => {
        if (!await hasOffscreenDocument()) return;
        const response = await sendCommand({ target: 'gif-offscreen', type: 'gif.release', id });
        if (!isRecord(response) || response.ok !== true) {
          throw new Error(isRecord(response) && typeof response.error === 'string'
            ? response.error : 'The GIF conversion result could not be released.');
        }
      });
    },
  };
}
