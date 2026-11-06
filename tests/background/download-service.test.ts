import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DownloadJob,
  DownloadStartRequest,
  Settings,
  TransportDownload,
} from '../../src/core/types';
import { BackgroundDownloadService } from '../../src/background/download-service';
import { DownloadJobStore, JOBS_STORAGE_KEY, MAX_TERMINAL_JOBS } from '../../src/background/job-store';

const NOW = new Date('2026-11-06T12:34:56.000Z');
const SETTINGS: Settings = {
  version: 1,
  subdirectory: '',
  grouping: 'none',
  filename: 'original',
  originalSize: false,
};

class MemorySessionStorage {
  readonly values: Record<string, unknown> = {};
  async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values[key] = structuredClone(value);
  }
}

function makePost(count = 2) {
  const photos = Array.from({ length: count }, (_, index) => ({
    key: `photo-${index + 1}`,
    kind: 'image' as const,
    index: index + 1,
    originalFilename: `picture-${index + 1}.jpg`,
    extension: 'jpg' as const,
    displayedUrl: `https://pbs.twimg.com/media/image-${index + 1}?format=jpg&name=small`,
    originalUrl: `https://pbs.twimg.com/media/image-${index + 1}?format=jpg&name=orig`,
  }));
  return {
    key: 'post-42',
    postId: '42',
    authorHandle: 'sample',
    photos,
    expectedPhotoCount: count,
    completeness: 'complete' as const,
  };
}

function makeRequest(overrides: Partial<DownloadStartRequest> = {}): DownloadStartRequest {
  return {
    type: 'download.start',
    requestId: 'request-1',
    post: makePost(),
    selection: 'all',
    ...overrides,
  };
}

function makeSender(overrides: Record<string, unknown> = {}) {
  return {
    id: 'extension-id',
    tab: { id: 7, url: 'https://x.com/sample/status/42' },
    frameId: 0,
    url: 'https://x.com/sample/status/42',
    ...overrides,
  };
}

function fakeTransport() {
  let nextId = 100;
  const records = new Map<number, TransportDownload>();
  const starts: Array<{ url: string; relativePath: string }> = [];
  const failures = new Set<string>();
  return {
    starts,
    records,
    failures,
    async start(file: { url: string; relativePath: string }): Promise<number> {
      starts.push(file);
      if (failures.has(file.relativePath)) throw new Error('native start rejected');
      const id = nextId++;
      records.set(id, { id, state: 'in_progress' });
      return id;
    },
    async get(id: number): Promise<TransportDownload | null> {
      return records.get(id) ?? null;
    },
  };
}

function createService(options: {
  storage?: MemorySessionStorage;
  transport?: ReturnType<typeof fakeTransport>;
  settings?: Settings;
  id?: string;
  now?: () => Date;
  isAllowedUrl?: (value: string) => boolean;
  notify?: (job: DownloadJob) => void | Promise<void>;
} = {}) {
  const storage = options.storage ?? new MemorySessionStorage();
  const transport = options.transport ?? fakeTransport();
  let generatedId = 0;
  const service = new BackgroundDownloadService({
    extensionId: 'extension-id',
    storage,
    transport,
    loadSettings: async () => options.settings ?? SETTINGS,
    now: options.now ?? (() => new Date(NOW)),
    createId: () => options.id ?? `job-${++generatedId}`,
    isAllowedUrl: options.isAllowedUrl ?? (url => url.startsWith('https://pbs.twimg.com/')),
    notify: options.notify,
  });
  return { service, storage, transport };
}

describe('background download service', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('aggregates a native start rejection and a later completion as a partial job', async () => {
    const transport = fakeTransport();
    transport.failures.add('picture-2.jpg');
    const { service, storage } = createService({ transport });

    const response = await service.handleMessage(makeRequest(), makeSender());
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.job.state).toBe('in_progress');
    expect(response.job.items.map(item => item.state)).toEqual(['in_progress', 'failed']);
    expect(response.job.items[1]?.error).toBe('native start rejected');

    transport.records.set(100, { id: 100, state: 'complete', mime: 'image/jpeg' });
    await service.handleTransportChange({ id: 100, state: 'complete' });
    const status = await service.handleMessage({ type: 'download.getStatus', jobId: 'job-1' }, makeSender());
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.job.state).toBe('partial');
    expect(status.job.items.map(item => item.state)).toEqual(['complete', 'failed']);
    expect(JSON.stringify(storage.values[JOBS_STORAGE_KEY])).not.toContain('pbs.twimg.com');
  });

  it.each(['video/mp4', 'image/gif', 'text/html'])('does not report %s as a static-image success', async mime => {
    const transport = fakeTransport();
    const { service } = createService({ transport });
    const response = await service.handleMessage(makeRequest({ selection: { photoKeys: ['photo-1'] } }), makeSender());
    expect(response.ok).toBe(true);
    transport.records.set(100, { id: 100, state: 'complete', mime });
    await service.handleTransportChange({ id: 100, state: 'complete' });
    const status = await service.handleMessage({ type: 'download.getStatus', jobId: 'job-1' }, makeSender());
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.job.state).toBe('failed');
    expect(status.job.items[0]?.error).toContain(mime);
  });

  it('reconciles a completion event that arrived before its download ID was persisted', async () => {
    const storage = new MemorySessionStorage();
    const records = new Map<number, TransportDownload>();
    let service!: BackgroundDownloadService;
    const transport = {
      async start(): Promise<number> {
        records.set(50, { id: 50, state: 'complete', mime: 'image/png' });
        await service.handleTransportChange({ id: 50, state: 'complete' });
        return 50;
      },
      async get(id: number): Promise<TransportDownload | null> { return records.get(id) ?? null; },
    };
    service = new BackgroundDownloadService({
      extensionId: 'extension-id', storage, transport,
      loadSettings: async () => SETTINGS,
      makePlan: undefined,
      now: () => new Date(NOW),
      createId: () => 'race-job',
      isAllowedUrl: () => true,
    });

    const response = await service.handleMessage(makeRequest({ selection: { photoKeys: ['photo-1'] } }), makeSender());
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.job.items[0]).toMatchObject({ downloadId: 50, state: 'complete' });
    expect(response.job.state).toBe('complete');
  });

  it('restores known download IDs after worker recreation without starting them again', async () => {
    const storage = new MemorySessionStorage();
    const firstTransport = fakeTransport();
    const first = createService({ storage, transport: firstTransport, id: 'restart-job' });
    const started = await first.service.handleMessage(makeRequest({ selection: { photoKeys: ['photo-1'] } }), makeSender());
    expect(started.ok).toBe(true);
    expect(firstTransport.starts).toHaveLength(1);

    const recoveredTransport = fakeTransport();
    recoveredTransport.records.set(100, { id: 100, state: 'complete', mime: 'image/jpeg' });
    const recovered = createService({ storage, transport: recoveredTransport, id: 'unused' });
    const status = await recovered.service.handleMessage({ type: 'download.getStatus', jobId: 'restart-job' }, makeSender());
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.job.state).toBe('complete');
    expect(recoveredTransport.starts).toHaveLength(0);
  });

  it('fails an unresolved start after restart instead of silently downloading it again', async () => {
    const storage = new MemorySessionStorage();
    const now = NOW.toISOString();
    const job: DownloadJob = {
      id: 'uncertain-job', requestId: 'uncertain-request', postKey: 'post-uncertain',
      tabId: 7, frameId: 0, createdAt: now, updatedAt: now, state: 'starting',
      warnings: [],
      items: [{ photoKey: 'photo-x', index: 4, relativePath: 'photo.jpg', downloadId: null, state: 'starting', error: null }],
    };
    storage.values[JOBS_STORAGE_KEY] = { [job.id]: job };
    const transport = fakeTransport();
    const { service } = createService({ storage, transport });

    const status = await service.handleMessage({ type: 'download.getStatus', jobId: job.id }, makeSender());
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.job.state).toBe('failed');
    expect(status.job.items[0]?.error).toContain('was not restarted');
    expect(transport.starts).toHaveLength(0);
  });

  it('suppresses active duplicate selections and keeps job status private to its frame', async () => {
    const { service, transport } = createService();
    const original = await service.handleMessage(makeRequest({ selection: { photoKeys: ['photo-2', 'photo-1'] } }), makeSender());
    const duplicate = await service.handleMessage(
      makeRequest({ requestId: 'request-2', selection: { photoKeys: ['photo-1', 'photo-2'] } }),
      makeSender(),
    );
    expect(original.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    if (original.ok && duplicate.ok) expect(duplicate.job.id).toBe(original.job.id);
    expect(transport.starts).toHaveLength(2);

    const otherFrame = await service.handleMessage(
      { type: 'download.getStatus', jobId: 'job-1' },
      makeSender({ frameId: 2, url: 'https://x.com/sample/status/42?frame=2' }),
    );
    expect(otherFrame).toMatchObject({ ok: false, error: { code: 'job_not_found' } });
  });

  it('accepts a trusted sender when Chrome omits the sensitive sender.tab.url property', async () => {
    const { service, transport } = createService();
    const source = makeSender({ tab: { id: 7 } });
    const response = await service.handleMessage(makeRequest({ selection: { photoKeys: ['photo-1'] } }), source);
    expect(response.ok).toBe(true);
    expect(transport.starts).toHaveLength(1);
  });

  it('does not share an active duplicate job between frames in the same tab', async () => {
    const { service, transport } = createService();
    const first = await service.handleMessage(makeRequest({ selection: { photoKeys: ['photo-1'] } }), makeSender());
    const second = await service.handleMessage(
      makeRequest({ requestId: 'request-frame-2', selection: { photoKeys: ['photo-1'] } }),
      makeSender({ frameId: 2, url: 'https://x.com/sample/status/42?frame=2' }),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.job.id).not.toBe(first.job.id);
    expect(transport.starts).toHaveLength(2);
  });

  it('rejects untrusted senders, non-X frames, and malformed requests', async () => {
    const { service, transport } = createService();
    expect(await service.handleMessage(makeRequest(), makeSender({ id: 'other-extension' })))
      .toMatchObject({ ok: false, error: { code: 'invalid_sender' } });
    expect(await service.handleMessage(makeRequest(), makeSender({ tab: { id: 7, url: 'https://example.com/' } })))
      .toMatchObject({ ok: false, error: { code: 'invalid_sender' } });
    expect(await service.handleMessage(makeRequest(), makeSender({ url: 'https://evilx.com/' })))
      .toMatchObject({ ok: false, error: { code: 'invalid_sender' } });
    expect(await service.handleMessage({ type: 'download.start', requestId: '', post: null }, makeSender()))
      .toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(transport.starts).toHaveLength(0);
  });

  it('rejects an unsupported original URL before a plan can request it', async () => {
    const { service, transport } = createService({
      settings: { ...SETTINGS, originalSize: true },
      isAllowedUrl: url => url.includes('name=small'),
    });
    const response = await service.handleMessage(makeRequest(), makeSender());
    expect(response).toMatchObject({ ok: false, error: { code: 'unsupported_media_url' } });
    expect(transport.starts).toHaveLength(0);
  });
});

describe('download job store retention', () => {
  it('keeps active jobs and caps terminal history at 50 entries', async () => {
    const storage = new MemorySessionStorage();
    const store = new DownloadJobStore(storage, () => NOW.getTime());
    for (let index = 0; index < MAX_TERMINAL_JOBS + 5; index += 1) {
      const createdAt = new Date(NOW.getTime() + index).toISOString();
      const job: DownloadJob = {
        id: `done-${index}`, requestId: `req-${index}`, postKey: `post-${index}`,
        tabId: index, frameId: 0, createdAt, updatedAt: createdAt,
        state: 'complete', warnings: [],
        items: [{ photoKey: `photo-${index}`, index: 1, relativePath: 'a.jpg', downloadId: index, state: 'complete', error: null }],
      };
      await store.createOrFindDuplicate(job);
    }
    const active: DownloadJob = {
      id: 'active', requestId: 'active-req', postKey: 'active-post', tabId: 900, frameId: 1,
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), state: 'in_progress', warnings: [],
      items: [{ photoKey: 'active-photo', index: 2, relativePath: 'b.jpg', downloadId: 900, state: 'in_progress', error: null }],
    };
    await store.createOrFindDuplicate(active);

    const persisted = storage.values[JOBS_STORAGE_KEY] as Record<string, unknown>;
    expect(Object.keys(persisted)).toHaveLength(MAX_TERMINAL_JOBS + 1);
    expect(persisted.active).toBeDefined();
    expect(await store.get('active')).toMatchObject({ state: 'in_progress' });
  });

  it('expires terminal history after one hour', async () => {
    const storage = new MemorySessionStorage();
    let currentTime = NOW.getTime();
    const store = new DownloadJobStore(storage, () => currentTime);
    const job: DownloadJob = {
      id: 'expiring', requestId: 'expiring-req', postKey: 'expiring-post', tabId: 1, frameId: 0,
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), state: 'failed', warnings: [],
      items: [{ photoKey: 'photo-expiring', index: 1, relativePath: 'a.jpg', downloadId: null, state: 'failed', error: 'rejected' }],
    };
    await store.createOrFindDuplicate(job);
    currentTime += 60 * 60 * 1000 + 1;
    await expect(store.get(job.id)).resolves.toBeNull();
  });
});
