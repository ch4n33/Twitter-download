import { createDownloadPlan } from '../core/download-plan';
import type { GifConverter } from '../conversion/protocol';
import type {
  AppError,
  DownloadJob,
  DownloadJobItem,
  DownloadPlan,
  DownloadSelection,
  DownloadStartRequest,
  ExtensionRequest,
  ExtensionResponse,
  MediaKind,
  PhotoAsset,
  Result,
  Settings,
  TransportChange,
  TransportDownload,
} from '../core/types';
import { isExtensionRequest } from '../platform/messaging';
import { loadSettings } from '../platform/settings-store';
import { isAllowedImageUrl, isAllowedVideoUrl } from '../x/media-urls';
import { DownloadJobStore, type SessionJobStorage } from './job-store';

const STATIC_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);
const VIDEO_MIMES = new Set(['video/mp4', 'application/mp4']);
const GIF_MIMES = new Set(['image/gif']);

const INVALID_REQUEST: AppError = {
  code: 'invalid_request',
  message: 'The extension request is malformed or unsupported.',
};

interface SenderTabLike {
  id?: unknown;
  url?: unknown;
}

export interface DownloadServiceOptions {
  extensionId: string;
  storage: SessionJobStorage;
  transport: {
    start(file: { url: string; relativePath: string }): Promise<number>;
    get(id: number): Promise<TransportDownload | null>;
  };
  loadSettings?: () => Promise<Settings>;
  makePlan?: (
    post: DownloadStartRequest['post'],
    selection: DownloadSelection,
    settings: Settings,
    context: { now: Date },
  ) => Result<DownloadPlan>;
  isAllowedUrl?: (value: string, kind: MediaKind) => boolean;
  converter?: GifConverter;
  now?: () => Date;
  createId?: () => string;
  notify?: (job: DownloadJob) => void | Promise<void>;
}

interface SenderContext {
  tabId: number;
  frameId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isXUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'x.com'
      && url.port === ''
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

function readSender(value: unknown, expectedExtensionId: string): SenderContext | null {
  if (!isRecord(value) || value.id !== expectedExtensionId || !isRecord(value.tab)) return null;
  const tab = value.tab as SenderTabLike;
  const tabId = tab.id;
  const frameId = value.frameId;
  if (!Number.isInteger(tabId) || Number(tabId) < 0
    || !Number.isInteger(frameId) || Number(frameId) < 0
    || !isXUrl(value.url)
    || (tab.url !== undefined && (!isXUrl(tab.url) || new URL(tab.url).origin !== new URL(value.url).origin))) return null;
  return { tabId: Number(tabId), frameId: Number(frameId) };
}

function error(code: string, message: string): ExtensionResponse {
  return { ok: false, error: { code, message } };
}

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return fallback;
}

function selectedPhotos(request: DownloadStartRequest): PhotoAsset[] {
  if (request.selection === 'all') return request.post.photos;
  const wanted = new Set(request.selection.photoKeys);
  return request.post.photos.filter(photo => wanted.has(photo.key));
}

function mediaTypeError(mime: string, kind: MediaKind, outputFormat?: DownloadJobItem['outputFormat']): string | null {
  const normalized = mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const expectedMimes = outputFormat === 'gif'
    ? GIF_MIMES
    : kind === 'image' ? STATIC_IMAGE_MIMES : VIDEO_MIMES;
  if (expectedMimes.has(normalized)) return null;
  const expectedDescription = outputFormat === 'gif' ? 'GIF image' : kind === 'image' ? 'static image' : 'MP4 video';
  return `The browser reported “${normalized || mime}”; this is not a supported ${expectedDescription}.`;
}

function computeJobState(items: DownloadJobItem[]): DownloadJob['state'] {
  if (items.every(item => item.state === 'complete')) return 'complete';
  if (items.every(item => item.state === 'failed')) return 'failed';
  const allTerminal = items.every(item => item.state === 'complete' || item.state === 'failed');
  if (allTerminal) return 'partial';
  if (items.some(item => item.state === 'in_progress' || item.state === 'converting')) return 'in_progress';
  return 'starting';
}

function updateJobTime(job: DownloadJob, now: Date, items: DownloadJobItem[]): DownloadJob {
  return {
    ...job,
    updatedAt: now.toISOString(),
    items,
    state: computeJobState(items),
  };
}

function isItemTerminal(item: DownloadJobItem): boolean {
  return item.state === 'complete' || item.state === 'failed';
}

function applyNativeResult(item: DownloadJobItem, result: TransportDownload): DownloadJobItem {
  if (isItemTerminal(item)) return item;
  if (result.state === 'in_progress') {
    return { ...item, state: 'in_progress', error: null };
  }
  if (result.state === 'interrupted') {
    return {
      ...item,
      state: 'failed',
      error: result.error || 'The browser interrupted this download.',
    };
  }
  // Older browsers can omit the response MIME. Preserve the prior behavior in that case.
  const mimeError = result.mime ? mediaTypeError(result.mime, item.expectedKind ?? 'image', item.outputFormat) : null;
  return mimeError
    ? { ...item, state: 'failed', error: mimeError }
    : { ...item, state: 'complete', error: null };
}

/**
 * Coordinates static-image plans and generic file downloads. It owns no DOM or
 * browser globals, which keeps the lifecycle behavior testable with fakes.
 */
export class BackgroundDownloadService {
  private readonly store: DownloadJobStore;
  private readonly settingsLoader: () => Promise<Settings>;
  private readonly planFactory: NonNullable<DownloadServiceOptions['makePlan']>;
  private readonly urlValidator: (value: string, kind: MediaKind) => boolean;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly notifier: (job: DownloadJob) => void | Promise<void>;
  private restorePromise: Promise<void> | null = null;

  constructor(private readonly options: DownloadServiceOptions) {
    this.store = new DownloadJobStore(options.storage, () => this.clock().getTime());
    this.settingsLoader = options.loadSettings ?? loadSettings;
    this.planFactory = options.makePlan ?? createDownloadPlan;
    this.urlValidator = options.isAllowedUrl ?? ((value, kind) => (
      kind === 'image' ? isAllowedImageUrl(value) : isAllowedVideoUrl(value)
    ));
    this.clock = options.now ?? (() => new Date());
    this.idFactory = options.createId ?? (() => crypto.randomUUID());
    this.notifier = options.notify ?? (() => undefined);
  }

  async handleMessage(message: unknown, sender: unknown): Promise<ExtensionResponse> {
    const context = readSender(sender, this.options.extensionId);
    if (!context) return error('invalid_sender', 'Requests must come from this extension in an X tab and frame.');
    if (!isExtensionRequest(message)) return { ok: false, error: INVALID_REQUEST };

    try {
      await this.ensureRestored();
      if (message.type === 'download.getStatus') return await this.getStatus(message.jobId, context);
      return await this.startDownload(message, context);
    } catch (cause) {
      return error('background_error', errorMessage(cause, 'The background download service failed.'));
    }
  }

  /** Called after event listeners are registered in the MV3 service worker. */
  async restore(): Promise<void> {
    await this.ensureRestored();
  }

  async handleTransportChange(change: TransportChange): Promise<void> {
    await this.ensureRestored();
    const found = await this.store.findItemByDownloadId(change.id);
    if (!found || isItemTerminal(found.item)) return;

    let result: TransportDownload | null = null;
    if (change.state === 'interrupted') {
      result = { id: change.id, state: 'interrupted', ...(change.error ? { error: change.error } : {}) };
    } else if (change.state === 'complete') {
      try {
        result = await this.options.transport.get(change.id);
      } catch {
        result = null;
      }
      result ??= { id: change.id, state: 'complete' };
    } else if (change.state === 'in_progress') {
      result = { id: change.id, state: 'in_progress' };
    } else {
      try {
        result = await this.options.transport.get(change.id);
      } catch {
        return;
      }
    }
    if (result) {
      await this.applyResult(found.job.id, found.item.photoKey, result);
      if (result.state === 'complete' || result.state === 'interrupted') {
        await this.releaseConvertedItem(found.job.id, found.item);
      }
    }
  }

  private async getStatus(jobId: string, context: SenderContext): Promise<ExtensionResponse> {
    const job = await this.store.get(jobId);
    if (!job || job.tabId !== context.tabId || job.frameId !== context.frameId) {
      return error('job_not_found', 'No download job is available to this tab and frame.');
    }
    return { ok: true, job };
  }

  private async startDownload(request: DownloadStartRequest, context: SenderContext): Promise<ExtensionResponse> {
    let settings: Settings;
    try {
      settings = await this.settingsLoader();
    } catch (cause) {
      return error('settings_unavailable', errorMessage(cause, 'Download settings could not be loaded.'));
    }

    for (const photo of selectedPhotos(request)) {
      if (!this.urlValidator(photo.displayedUrl, photo.kind)) {
        const label = photo.kind === 'image' ? 'displayed image URL for photo' : 'displayed media URL for item';
        return error('unsupported_media_url', `The ${label} ${photo.index} is not supported.`);
      }
      if (photo.kind === 'image' && settings.originalSize && photo.originalUrl
        && !this.urlValidator(photo.originalUrl, photo.kind)) {
        return error('unsupported_media_url', `The original image URL for photo ${photo.index} is not supported.`);
      }
    }

    let planResult: Result<DownloadPlan>;
    const now = this.clock();
    try {
      planResult = this.planFactory(request.post, request.selection, settings, { now });
    } catch (cause) {
      return error('planning_failed', errorMessage(cause, 'The download plan could not be created.'));
    }
    if (!planResult.ok) return { ok: false, error: planResult.error };
    const plan = planResult.value;
    if (plan.tasks.length === 0) return error('empty_plan', 'The selected images produced no download tasks.');
    for (const task of plan.tasks) {
      if (!this.urlValidator(task.url, task.kind)) {
        const label = task.kind === 'image' ? 'planned image URL for photo' : 'planned media URL for item';
        return error('unsupported_media_url', `The ${label} ${task.index} is not supported.`);
      }
    }

    const job: DownloadJob = {
      id: this.idFactory(),
      requestId: request.requestId,
      postKey: request.post.key,
      tabId: context.tabId,
      frameId: context.frameId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      state: plan.tasks.some(task => task.transform === 'mp4-to-gif') ? 'in_progress' : 'starting',
      items: plan.tasks.map(task => {
        const outputFormat = task.outputFormat ?? (task.transform === 'mp4-to-gif' ? 'gif' : undefined);
        return {
          photoKey: task.photoKey,
          index: task.index,
          expectedKind: task.kind,
          ...(outputFormat ? { outputFormat } : {}),
          relativePath: task.relativePath,
          downloadId: null,
          state: task.transform === 'mp4-to-gif' ? 'converting' as const : 'starting' as const,
          ...(task.transform === 'mp4-to-gif' ? { progress: 0 } : {}),
          error: null,
        };
      }),
      warnings: [...plan.warnings],
    };

    const created = await this.store.createOrFindDuplicate(job);
    if (created.kind === 'duplicate') return { ok: true, job: created.job };
    if (created.kind === 'capacity') {
      return error('too_many_active_jobs', 'Too many active downloads are being tracked. Wait for one to finish and retry.');
    }
    await this.notify(created.job);

    if (plan.tasks.some(task => task.transform === 'mp4-to-gif')) {
      for (const [index, task] of plan.tasks.entries()) {
        void this.startTask(created.job.id, index, task).catch(cause => (
          this.failUnexpectedStart(created.job.id, index, task, cause)
        ));
      }
      const latest = await this.store.get(created.job.id);
      return latest ? { ok: true, job: latest } : error('job_lost', 'The download job state could not be recovered.');
    }

    await Promise.all(plan.tasks.map((task, index) => this.startTask(created.job.id, index, task)));
    const latest = await this.store.get(created.job.id);
    return latest ? { ok: true, job: latest } : error('job_lost', 'The download job state could not be recovered.');
  }

  private async startTask(
    jobId: string,
    itemIndex: number,
    task: DownloadPlan['tasks'][number],
    reconnect = false,
  ): Promise<void> {
    let downloadUrl = task.url;
    const conversionId = task.transform === 'mp4-to-gif' ? this.conversionId(jobId, itemIndex) : null;
    if (conversionId) {
      const converter = this.options.converter;
      if (!converter) {
        await this.failGifConversion(jobId, itemIndex, new Error('GIF conversion is unavailable.'));
        return;
      }
      try {
        const prepared = reconnect
          ? await converter.reconnect(conversionId, progress => this.reportProgress(jobId, itemIndex, progress))
          : await converter.prepare(conversionId, task.url, progress => this.reportProgress(jobId, itemIndex, progress));
        downloadUrl = prepared.url;
      } catch (cause) {
        await this.failGifConversion(jobId, itemIndex, cause);
        await this.safeRelease(converter, conversionId);
        return;
      }

      const current = await this.store.get(jobId);
      const item = current?.items[itemIndex];
      if (!item || isItemTerminal(item)) {
        await this.safeRelease(converter, conversionId);
        return;
      }
      await this.updateItem(jobId, itemIndex, value => {
        const { progress: _progress, ...rest } = value;
        return { ...rest, state: 'starting', error: null };
      });
    }

    let downloadId: number;
    try {
      downloadId = await this.options.transport.start({ url: downloadUrl, relativePath: task.relativePath });
    } catch (cause) {
      const message = errorMessage(cause, 'The browser rejected this download.');
      await this.updateItem(jobId, itemIndex, item => ({ ...item, state: 'failed', error: message }));
      if (conversionId && this.options.converter) await this.safeRelease(this.options.converter, conversionId);
      return;
    }

    const saved = await this.updateItem(jobId, itemIndex, item => ({
      ...item,
      downloadId,
      state: 'in_progress',
      error: null,
    }));
    if (!saved) return;

    // A very fast download may have emitted onChanged before its id was stored.
    // Querying after persistence closes that event race without restarting it.
    try {
      const current = await this.options.transport.get(downloadId);
      if (current) {
        await this.applyResult(jobId, task.photoKey, current);
        if (current.state === 'complete' || current.state === 'interrupted') {
          const latest = await this.store.get(jobId);
          const item = latest?.items[itemIndex];
          if (item) await this.releaseConvertedItem(jobId, item);
        }
      }
    } catch {
      // The accepted download remains in progress; a later native event can resolve it.
    }
  }

  private conversionId(jobId: string, itemIndex: number): string {
    return `gif-${jobId}-${itemIndex}`;
  }

  private async handleProgress(jobId: string, itemIndex: number, percent: number): Promise<void> {
    if (!Number.isFinite(percent)) return;
    const progress = Math.max(0, Math.min(100, Math.round(percent)));
    await this.updateItem(jobId, itemIndex, item => (
      item.state !== 'converting' || item.progress === progress
        ? item
        : { ...item, progress, error: null }
    ));
  }

  private reportProgress(jobId: string, itemIndex: number, percent: number): void {
    void this.handleProgress(jobId, itemIndex, percent).catch(() => undefined);
  }

  private async failGifConversion(jobId: string, itemIndex: number, cause: unknown): Promise<void> {
    const detail = errorMessage(cause, 'The source media could not be converted to GIF.');
    await this.updateItem(jobId, itemIndex, item => ({
      ...item,
      state: 'failed',
      error: `${detail} GIF 저장 옵션을 끄면 MP4로 저장할 수 있어요.`,
    }));
  }

  private async failUnexpectedStart(
    jobId: string,
    itemIndex: number,
    task: DownloadPlan['tasks'][number],
    cause: unknown,
  ): Promise<void> {
    if (task.transform === 'mp4-to-gif') {
      await this.failGifConversion(jobId, itemIndex, cause);
      if (this.options.converter) await this.safeRelease(this.options.converter, this.conversionId(jobId, itemIndex));
      return;
    }
    await this.updateItem(jobId, itemIndex, item => ({
      ...item,
      state: 'failed',
      error: errorMessage(cause, 'The browser rejected this download.'),
    }));
  }

  private async safeRelease(converter: GifConverter, id: string): Promise<void> {
    try {
      await converter.release(id);
    } catch {
      // Cleanup must not change a native download result.
    }
  }

  private async releaseConvertedItem(jobId: string, item: DownloadJobItem): Promise<void> {
    if (item.outputFormat !== 'gif' || !this.options.converter) return;
    const items = (await this.store.get(jobId))?.items ?? [];
    const index = items.findIndex(candidate => candidate.photoKey === item.photoKey);
    if (index >= 0) await this.safeRelease(this.options.converter, this.conversionId(jobId, index));
  }

  private async updateItem(
    jobId: string,
    itemIndex: number,
    change: (item: DownloadJobItem) => DownloadJobItem,
  ): Promise<boolean> {
    let changed = false;
    const job = await this.store.update(jobId, current => {
      const item = current.items[itemIndex];
      if (!item) return current;
      const nextItem = change(item);
      if (nextItem === item || isItemTerminal(item)) return current;
      changed = true;
      const items = current.items.map((candidate, index) => index === itemIndex ? nextItem : candidate);
      return updateJobTime(current, this.clock(), items);
    });
    if (changed && job) await this.notify(job);
    return Boolean(job);
  }

  private async applyResult(jobId: string, photoKey: string, result: TransportDownload): Promise<void> {
    let changed = false;
    const job = await this.store.update(jobId, current => {
      const index = current.items.findIndex(item => item.photoKey === photoKey);
      if (index < 0) return current;
      const item = current.items[index]!;
      const nextItem = applyNativeResult(item, result);
      if (nextItem === item) return current;
      changed = true;
      const items = current.items.map((candidate, candidateIndex) => candidateIndex === index ? nextItem : candidate);
      return updateJobTime(current, this.clock(), items);
    });
    if (changed && job) await this.notify(job);
  }

  private async notify(job: DownloadJob): Promise<void> {
    try {
      await this.notifier(job);
    } catch {
      // A closed tab/frame cannot stop background tracking of a native download.
    }
  }

  private ensureRestored(): Promise<void> {
    if (!this.restorePromise) {
      this.restorePromise = this.restoreActiveJobs().catch(cause => {
        this.restorePromise = null;
        throw cause;
      });
    }
    return this.restorePromise;
  }

  private async restoreActiveJobs(): Promise<void> {
    const jobs = await this.store.listActive();
    for (const job of jobs) {
      for (let index = 0; index < job.items.length; index += 1) {
        const item = job.items[index]!;
        if (isItemTerminal(item)) continue;
        if (item.state === 'converting') {
          const task = {
            photoKey: item.photoKey,
            index: item.index,
            kind: item.expectedKind ?? 'animated_gif',
            extension: 'mp4',
            url: '',
            relativePath: item.relativePath,
            outputFormat: item.outputFormat ?? 'gif',
            transform: 'mp4-to-gif',
          } satisfies DownloadPlan['tasks'][number];
          void this.startTask(job.id, index, task, true).catch(cause => (
            this.failUnexpectedStart(job.id, index, task, cause)
          ));
          continue;
        }
        if (item.downloadId === null) {
          await this.updateItem(job.id, index, current => ({
            ...current,
            state: 'failed',
            error: 'The worker stopped before the browser confirmed this download start; it was not restarted.',
          }));
          continue;
        }
        try {
          const current = await this.options.transport.get(item.downloadId);
          if (current) {
            await this.applyResult(job.id, item.photoKey, current);
            if (current.state === 'complete' || current.state === 'interrupted') {
              await this.releaseConvertedItem(job.id, item);
            }
          } else {
            await this.updateItem(job.id, index, itemValue => ({
              ...itemValue,
              state: 'failed',
              error: 'The browser no longer has this download; it was not restarted.',
            }));
            await this.releaseConvertedItem(job.id, item);
          }
        } catch {
          // Keep a known ID in progress if a temporary lookup error prevents restoration.
        }
      }
    }
  }
}

export function createBackgroundDownloadService(options: DownloadServiceOptions): BackgroundDownloadService {
  return new BackgroundDownloadService(options);
}
