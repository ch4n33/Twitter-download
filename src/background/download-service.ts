import { createDownloadPlan } from '../core/download-plan';
import type {
  AppError,
  DownloadJob,
  DownloadJobItem,
  DownloadPlan,
  DownloadSelection,
  DownloadStartRequest,
  ExtensionRequest,
  ExtensionResponse,
  PhotoAsset,
  Result,
  Settings,
  TransportChange,
  TransportDownload,
} from '../core/types';
import { isExtensionRequest } from '../platform/messaging';
import { loadSettings } from '../platform/settings-store';
import { isAllowedImageUrl } from '../x/media-urls';
import { DownloadJobStore, type SessionJobStorage } from './job-store';

const STATIC_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);

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
  isAllowedUrl?: (value: string) => boolean;
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

function mediaTypeError(mime: string): string | null {
  const normalized = mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return STATIC_IMAGE_MIMES.has(normalized)
    ? null
    : `The browser reported “${normalized || mime}”; this is not a supported static image.`;
}

function computeJobState(items: DownloadJobItem[]): DownloadJob['state'] {
  if (items.every(item => item.state === 'complete')) return 'complete';
  if (items.every(item => item.state === 'failed')) return 'failed';
  const allTerminal = items.every(item => item.state === 'complete' || item.state === 'failed');
  if (allTerminal) return 'partial';
  if (items.some(item => item.state === 'in_progress')) return 'in_progress';
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
  const mimeError = result.mime ? mediaTypeError(result.mime) : null;
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
  private readonly urlValidator: (value: string) => boolean;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly notifier: (job: DownloadJob) => void | Promise<void>;
  private restorePromise: Promise<void> | null = null;

  constructor(private readonly options: DownloadServiceOptions) {
    this.store = new DownloadJobStore(options.storage, () => this.clock().getTime());
    this.settingsLoader = options.loadSettings ?? loadSettings;
    this.planFactory = options.makePlan ?? createDownloadPlan;
    this.urlValidator = options.isAllowedUrl ?? isAllowedImageUrl;
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
    if (result) await this.applyResult(found.job.id, found.item.photoKey, result);
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
      if (!this.urlValidator(photo.displayedUrl)) {
        return error('unsupported_media_url', `The displayed image URL for photo ${photo.index} is not supported.`);
      }
      if (settings.originalSize && photo.originalUrl && !this.urlValidator(photo.originalUrl)) {
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
      if (!this.urlValidator(task.url)) {
        return error('unsupported_media_url', `The planned image URL for photo ${task.index} is not supported.`);
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
      state: 'starting',
      items: plan.tasks.map(task => ({
        photoKey: task.photoKey,
        index: task.index,
        relativePath: task.relativePath,
        downloadId: null,
        state: 'starting',
        error: null,
      })),
      warnings: [...plan.warnings],
    };

    const created = await this.store.createOrFindDuplicate(job);
    if (created.kind === 'duplicate') return { ok: true, job: created.job };
    if (created.kind === 'capacity') {
      return error('too_many_active_jobs', 'Too many active downloads are being tracked. Wait for one to finish and retry.');
    }
    await this.notify(created.job);

    await Promise.all(plan.tasks.map((task, index) => this.startTask(created.job.id, index, task)));
    const latest = await this.store.get(created.job.id);
    return latest ? { ok: true, job: latest } : error('job_lost', 'The download job state could not be recovered.');
  }

  private async startTask(
    jobId: string,
    itemIndex: number,
    task: DownloadPlan['tasks'][number],
  ): Promise<void> {
    let downloadId: number;
    try {
      downloadId = await this.options.transport.start(task);
    } catch (cause) {
      const message = errorMessage(cause, 'The browser rejected this download.');
      await this.updateItem(jobId, itemIndex, item => ({ ...item, state: 'failed', error: message }));
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
      if (current) await this.applyResult(jobId, task.photoKey, current);
    } catch {
      // The accepted download remains in progress; a later native event can resolve it.
    }
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
          } else {
            await this.updateItem(job.id, index, itemValue => ({
              ...itemValue,
              state: 'failed',
              error: 'The browser no longer has this download; it was not restarted.',
            }));
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
