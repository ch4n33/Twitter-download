import type { DownloadJob, DownloadJobItem } from '../core/types';

export const JOBS_STORAGE_KEY = 'twitterDownload.jobs.v1';
export const MAX_ACTIVE_JOBS = 100;
export const MAX_TERMINAL_JOBS = 50;
export const TERMINAL_JOB_TTL_MS = 60 * 60 * 1000;

export interface SessionJobStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export type CreateJobResult =
  | { kind: 'created'; job: DownloadJob }
  | { kind: 'duplicate'; job: DownloadJob }
  | { kind: 'capacity' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isJobItem(value: unknown): value is DownloadJobItem {
  if (!isRecord(value)) return false;
  return isString(value.photoKey)
    && Number.isInteger(value.index)
    && isString(value.relativePath)
    && (value.downloadId === null || (Number.isInteger(value.downloadId) && Number(value.downloadId) >= 0))
    && ['starting', 'in_progress', 'complete', 'failed'].includes(String(value.state))
    && (value.error === null || isString(value.error));
}

function isDownloadJob(value: unknown): value is DownloadJob {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.requestId)
    && isString(value.postKey)
    && Number.isInteger(value.tabId)
    && Number.isInteger(value.frameId)
    && isString(value.createdAt)
    && isString(value.updatedAt)
    && ['starting', 'in_progress', 'complete', 'partial', 'failed'].includes(String(value.state))
    && Array.isArray(value.items)
    && value.items.every(isJobItem)
    && Array.isArray(value.warnings)
    && value.warnings.every(isString);
}

function isTerminal(job: DownloadJob): boolean {
  return job.state === 'complete' || job.state === 'partial' || job.state === 'failed';
}

function activeSelectionKey(job: DownloadJob): string {
  return job.items.map(item => item.photoKey).sort().join('\u0000');
}

function sameActiveRequest(a: DownloadJob, b: DownloadJob): boolean {
  return !isTerminal(a)
    && a.tabId === b.tabId
    && a.frameId === b.frameId
    && a.postKey === b.postKey
    && activeSelectionKey(a) === activeSelectionKey(b);
}

/**
 * Session-backed bounded job history. All reads and writes share one queue so
 * simultaneous native download events cannot overwrite one another.
 */
export class DownloadJobStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: SessionJobStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async createOrFindDuplicate(job: DownloadJob): Promise<CreateJobResult> {
    return this.serialized(async () => {
      const { jobs, dirty } = await this.readAndPrune();
      const duplicate = Object.values(jobs).find(existing => sameActiveRequest(existing, job));
      if (duplicate) {
        if (dirty) await this.write(jobs);
        return { kind: 'duplicate', job: duplicate };
      }

      const activeCount = Object.values(jobs).filter(existing => !isTerminal(existing)).length;
      if (activeCount >= MAX_ACTIVE_JOBS) {
        if (dirty) await this.write(jobs);
        return { kind: 'capacity' };
      }

      jobs[job.id] = job;
      await this.write(jobs);
      return { kind: 'created', job };
    });
  }

  async get(jobId: string): Promise<DownloadJob | null> {
    return this.serialized(async () => {
      const { jobs, dirty } = await this.readAndPrune();
      if (dirty) await this.write(jobs);
      return jobs[jobId] ?? null;
    });
  }

  async listActive(): Promise<DownloadJob[]> {
    return this.serialized(async () => {
      const { jobs, dirty } = await this.readAndPrune();
      if (dirty) await this.write(jobs);
      return Object.values(jobs).filter(job => !isTerminal(job));
    });
  }

  async findItemByDownloadId(downloadId: number): Promise<{ job: DownloadJob; item: DownloadJobItem } | null> {
    return this.serialized(async () => {
      const { jobs, dirty } = await this.readAndPrune();
      if (dirty) await this.write(jobs);
      for (const job of Object.values(jobs)) {
        const item = job.items.find(candidate => candidate.downloadId === downloadId);
        if (item) return { job, item };
      }
      return null;
    });
  }

  async update(jobId: string, updater: (current: DownloadJob) => DownloadJob): Promise<DownloadJob | null> {
    return this.serialized(async () => {
      const { jobs } = await this.readAndPrune();
      const current = jobs[jobId];
      if (!current) return null;
      const next = updater(current);
      jobs[jobId] = next;
      const pruned = this.prune(jobs);
      await this.write(pruned);
      return pruned[jobId] ?? next;
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readAndPrune(): Promise<{ jobs: Record<string, DownloadJob>; dirty: boolean }> {
    const stored = await this.storage.get(JOBS_STORAGE_KEY);
    const raw = stored[JOBS_STORAGE_KEY];
    const jobs: Record<string, DownloadJob> = {};
    let dirty = false;
    if (isRecord(raw)) {
      for (const [id, value] of Object.entries(raw)) {
        if (isDownloadJob(value) && value.id === id) jobs[id] = value;
        else dirty = true;
      }
    } else if (raw !== undefined) {
      dirty = true;
    }
    const pruned = this.prune(jobs);
    if (Object.keys(pruned).length !== Object.keys(jobs).length) dirty = true;
    return { jobs: pruned, dirty };
  }

  private prune(jobs: Record<string, DownloadJob>): Record<string, DownloadJob> {
    const next: Record<string, DownloadJob> = {};
    const terminal = Object.values(jobs)
      .filter(isTerminal)
      .filter(job => {
        const updated = Date.parse(job.updatedAt);
        return Number.isFinite(updated) && this.now() - updated <= TERMINAL_JOB_TTL_MS;
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, MAX_TERMINAL_JOBS);
    for (const job of Object.values(jobs)) {
      if (!isTerminal(job)) next[job.id] = job;
    }
    for (const job of terminal) next[job.id] = job;
    return next;
  }

  private async write(jobs: Record<string, DownloadJob>): Promise<void> {
    await this.storage.set({ [JOBS_STORAGE_KEY]: jobs });
  }
}
