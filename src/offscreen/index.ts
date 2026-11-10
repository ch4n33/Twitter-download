import { isAllowedVideoUrl } from '../x/media-urls';
import {
  CONVERSION_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  type GifBackgroundEvent,
  type GifOffscreenCommand,
  type GifOffscreenStatus,
  type GifOffscreenState,
  type GifWorkerConvertMessage,
  type GifWorkerResponseMessage,
} from '../conversion/protocol';

interface MessageSenderLike {
  id?: string;
  url?: string;
}

interface WorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface OffscreenRuntimeDependencies {
  extensionId: string;
  extensionUrl(path: string): string;
  sendEvent(event: GifBackgroundEvent): Promise<unknown>;
  fetcher?: typeof fetch;
  WorkerConstructor?: new (url: string, options?: WorkerOptions) => WorkerLike;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  schedule?: (callback: () => void) => unknown;
}

interface ConversionRecord {
  state: Exclude<GifOffscreenState, 'missing'>;
  progress: number;
  url?: string;
  error?: string;
}

interface CommandResponse {
  ok: boolean;
  status?: GifOffscreenStatus;
  error?: string;
  idle?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGifOffscreenCommand(value: unknown): value is GifOffscreenCommand {
  if (!isRecord(value) || value.target !== 'gif-offscreen') return false;
  if (value.type === 'gif.isIdle') return true;
  if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 256) return false;
  if (value.type === 'gif.prepare') return typeof value.url === 'string' && value.url.length <= 8192;
  return value.type === 'gif.status' || value.type === 'gif.release';
}

function errorText(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return fallback;
}

function mimeType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** Fetches a bounded source MP4 without cookies or ambient credentials. */
export async function fetchMp4Input(
  sourceUrl: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<ArrayBuffer> {
  if (!isAllowedVideoUrl(sourceUrl)) throw new Error('The source URL is not an allowed X MP4.');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_INPUT_BYTES;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(sourceUrl, {
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The source MP4 request failed with HTTP ${response.status}.`);
    if (!['video/mp4', 'application/mp4'].includes(mimeType(response))) {
      throw new Error(`The source response is not MP4 media (${mimeType(response) || 'missing MIME type'}).`);
    }
    const finalUrl = response.url || sourceUrl;
    if (!isAllowedVideoUrl(finalUrl)) throw new Error('The source MP4 redirected outside the allowed X video URLs.');

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`The source MP4 exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit.`);
    }
    if (!response.body) throw new Error('The source MP4 response did not provide a readable stream.');

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`The source MP4 exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit.`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  } catch (cause) {
    if (controller.signal.aborted) throw new Error('Fetching the source MP4 timed out.');
    throw cause;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function isValidGifBuffer(buffer: ArrayBuffer, maxBytes = MAX_OUTPUT_BYTES): boolean {
  if (buffer.byteLength < 14 || buffer.byteLength > maxBytes) return false;
  const bytes = new Uint8Array(buffer);
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  return (signature === 'GIF87a' || signature === 'GIF89a') && bytes[bytes.length - 1] === 0x3b;
}

function currentStatus(record: ConversionRecord | undefined): GifOffscreenStatus {
  if (!record) return { state: 'missing', progress: 0 };
  return {
    state: record.state,
    progress: record.progress,
    ...(record.state === 'complete' && record.url ? { url: record.url } : {}),
    ...(record.state === 'failed' && record.error ? { error: record.error } : {}),
  };
}

function ownExtensionBlob(url: string, extensionUrl: (path: string) => string): boolean {
  const base = extensionUrl('');
  return base.startsWith('chrome-extension://') && url.startsWith(`blob:${base}`);
}

/**
 * Creates the serialized offscreen command handler. Conversion results and
 * progress live only in this page so a restarted service worker can reconnect.
 */
export function createOffscreenConversionHandler(deps: OffscreenRuntimeDependencies) {
  const records = new Map<string, ConversionRecord>();
  let queueTail: Promise<void> = Promise.resolve();
  let activeCount = 0;
  let closeRequestPending = false;
  const fetcher = deps.fetcher ?? fetch;
  const WorkerConstructor = deps.WorkerConstructor ?? Worker;
  const createObjectURL = deps.createObjectURL ?? (blob => URL.createObjectURL(blob));
  const revokeObjectURL = deps.revokeObjectURL ?? (url => URL.revokeObjectURL(url));
  const schedule = deps.schedule ?? (callback => globalThis.setTimeout(callback, 0));

  const emit = (event: GifBackgroundEvent): void => {
    void deps.sendEvent(event).catch(() => undefined);
  };

  const updateProgress = (id: string, value: number): void => {
    const record = records.get(id);
    if (!record || record.state === 'complete' || record.state === 'failed') return;
    const progress = Math.max(0, Math.min(100, Math.round(value)));
    if (!Number.isFinite(progress) || progress === record.progress) return;
    record.state = 'running';
    record.progress = progress;
    emit({ target: 'gif-background', type: 'gif.progress', id, progress });
  };

  const convert = (id: string, input: ArrayBuffer): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
    let worker: WorkerLike;
    try {
      worker = new WorkerConstructor(deps.extensionUrl('conversion/gif-worker.js'), { type: 'module' });
    } catch (cause) {
      reject(new Error(errorText(cause, 'The GIF conversion worker could not be started.')));
      return;
    }

    let settled = false;
    const timeout = globalThis.setTimeout(() => finish(new Error('GIF conversion timed out.')), CONVERSION_TIMEOUT_MS);
    const finish = (error: Error | null, result?: ArrayBuffer): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('The GIF conversion worker returned no result.'));
    };

    worker.onmessage = event => {
      const message: unknown = event.data;
      if (!isRecord(message) || message.id !== id || typeof message.type !== 'string') return;
      const typed = message as unknown as GifWorkerResponseMessage;
      if (typed.type === 'progress') {
        if (typeof typed.progress === 'number') updateProgress(id, typed.progress);
      } else if (typed.type === 'complete') {
        if (typed.buffer instanceof ArrayBuffer) finish(null, typed.buffer);
        else finish(new Error('The GIF conversion worker returned an invalid buffer.'));
      } else if (typed.type === 'error') {
        finish(new Error(typeof typed.error === 'string' ? typed.error : 'GIF conversion failed.'));
      }
    };
    worker.onerror = event => finish(new Error(event.message || 'The GIF conversion worker failed.'));
    worker.onmessageerror = () => finish(new Error('The GIF conversion worker returned unreadable data.'));

    const request: GifWorkerConvertMessage = { type: 'convert', id, input };
    try {
      worker.postMessage(request, [input]);
    } catch (cause) {
      finish(new Error(errorText(cause, 'The GIF conversion worker could not receive the MP4.')));
    }
  });

  const run = async (id: string, sourceUrl: string): Promise<void> => {
    const record = records.get(id);
    if (!record) return;
    record.state = 'running';
    try {
      const input = await fetchMp4Input(sourceUrl, { fetcher });
      const buffer = await convert(id, input);
      if (!isValidGifBuffer(buffer)) throw new Error('The conversion result is not a valid GIF or exceeds the output limit.');
      const objectUrl = createObjectURL(new Blob([buffer], { type: 'image/gif' }));
      if (!ownExtensionBlob(objectUrl, deps.extensionUrl)) {
        revokeObjectURL(objectUrl);
        throw new Error('The offscreen page did not create an extension-owned GIF URL.');
      }
      const current = records.get(id);
      if (!current) {
        revokeObjectURL(objectUrl);
        return;
      }
      current.state = 'complete';
      current.progress = 100;
      current.url = objectUrl;
      emit({ target: 'gif-background', type: 'gif.progress', id, progress: 100 });
      emit({ target: 'gif-background', type: 'gif.complete', id, url: objectUrl });
    } catch (cause) {
      const current = records.get(id);
      if (!current) return;
      const message = errorText(cause, 'The source media could not be converted to GIF.');
      current.state = 'failed';
      current.error = message;
      emit({ target: 'gif-background', type: 'gif.error', id, error: message });
    }
  };

  const closeWhenIdle = (): void => {
    if (records.size !== 0 || activeCount !== 0 || closeRequestPending) return;
    schedule(() => {
      if (records.size !== 0 || activeCount !== 0 || closeRequestPending) return;
      closeRequestPending = true;
      emit({ target: 'gif-background', type: 'gif.close-if-idle' });
    });
  };

  return (message: unknown, sender: MessageSenderLike, sendResponse: (value: unknown) => void): boolean => {
    if (!isRecord(message) || message.target !== 'gif-offscreen') return false;
    if (sender.id !== deps.extensionId || sender.url !== deps.extensionUrl('background/index.js')) {
      sendResponse({ ok: false, error: 'invalid_sender' } satisfies CommandResponse);
      return true;
    }
    if (!isGifOffscreenCommand(message)) {
      sendResponse({ ok: false, error: 'invalid_request' } satisfies CommandResponse);
      return true;
    }

    if (message.type === 'gif.isIdle') {
      sendResponse({ ok: true, idle: records.size === 0 && activeCount === 0 } satisfies CommandResponse);
      return true;
    }

    if (message.type === 'gif.status') {
      sendResponse({ ok: true, status: currentStatus(records.get(message.id)) } satisfies CommandResponse);
      return true;
    }

    if (message.type === 'gif.release') {
      const record = records.get(message.id);
      if (record?.url) revokeObjectURL(record.url);
      records.delete(message.id);
      sendResponse({ ok: true } satisfies CommandResponse);
      closeWhenIdle();
      return true;
    }

    if (!isAllowedVideoUrl(message.url)) {
      sendResponse({ ok: false, error: 'The source URL is not an allowed X MP4.' } satisfies CommandResponse);
      return true;
    }

    const prior = records.get(message.id);
    if (!prior) {
      closeRequestPending = false;
      const record: ConversionRecord = { state: 'queued', progress: 0 };
      records.set(message.id, record);
      emit({ target: 'gif-background', type: 'gif.progress', id: message.id, progress: 0 });
      const task = queueTail.then(async () => {
        if (!records.has(message.id)) return;
        activeCount += 1;
        try {
          await run(message.id, message.url);
        } finally {
          activeCount -= 1;
          closeWhenIdle();
        }
      });
      queueTail = task.then(() => undefined, () => undefined);
    }
    sendResponse({ ok: true, status: currentStatus(prior ?? records.get(message.id)) } satisfies CommandResponse);
    return true;
  };
}

export function registerOffscreenRuntime(api: typeof chrome = chrome): void {
  const handler = createOffscreenConversionHandler({
    extensionId: api.runtime.id,
    extensionUrl: path => api.runtime.getURL(path),
    sendEvent: event => api.runtime.sendMessage(event),
  });
  api.runtime.onMessage.addListener((message, sender, sendResponse) => (
    handler(message, sender, sendResponse)
  ));
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) registerOffscreenRuntime(chrome);
