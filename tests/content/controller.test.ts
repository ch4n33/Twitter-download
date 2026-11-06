// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DownloadJob, DownloadStartRequest, ExtensionResponse, PostSnapshot } from '../../src/core/types';
import type { PostReadResult } from '../../src/x/post-reader';
import { createContentController } from '../../src/content/controller';

const contentCss = readFileSync(resolve(process.cwd(), 'src/content/content.css'), 'utf8');

interface Fixture {
  post: HTMLElement;
  result: PostReadResult;
  actionRow: HTMLElement;
  wrappers: HTMLElement[];
}

function makeFixture(
  document: Document,
  count: number,
  expectedPhotoCount: number | null = count,
  completeness: PostSnapshot['completeness'] = 'complete',
  postKey = 'x:status:post-1',
): Fixture {
  const post = document.createElement('article');
  post.dataset.testid = 'tweet';
  const photos = Array.from({ length: count }, (_, offset) => ({
    key: `${postKey}:photo:${offset + 1}`,
    kind: 'image' as const,
    index: offset + 1,
    originalFilename: `photo-${offset + 1}.jpg`,
    extension: 'jpg' as const,
    displayedUrl: `https://pbs.twimg.com/media/photo-${offset + 1}?format=jpg&name=small`,
    originalUrl: `https://pbs.twimg.com/media/photo-${offset + 1}?format=jpg&name=orig`,
  }));
  const wrappers = photos.map(() => {
    const wrapper = document.createElement('div');
    wrapper.dataset.testid = 'tweetPhoto';
    const image = document.createElement('img');
    wrapper.append(image);
    post.append(wrapper);
    return wrapper;
  });
  const actionRow = document.createElement('div');
  actionRow.setAttribute('role', 'group');
  for (const testId of ['reply', 'retweet', 'like', 'bookmark', 'share']) {
    const native = document.createElement('button');
    native.dataset.testid = testId;
    native.textContent = testId;
    actionRow.append(native);
  }
  post.append(actionRow);
  document.body.append(post);

  const snapshot: PostSnapshot = {
    key: postKey,
    postId: postKey.split(':').at(-1) ?? null,
    authorHandle: '@sample',
    photos,
    expectedPhotoCount,
    completeness,
  };
  return {
    post,
    actionRow,
    wrappers,
    result: {
      snapshot,
      photoTargets: new Map(photos.map((photo, index) => [photo.key, wrappers[index]!])),
      fingerprint: JSON.stringify(snapshot),
    },
  };
}

function makeJob(
  post: PostSnapshot,
  photoKeys: string[],
  state: DownloadJob['state'] = 'in_progress',
  requestId = 'request-existing',
): DownloadJob {
  return {
    id: 'job-existing',
    requestId,
    postKey: post.key,
    tabId: 10,
    frameId: 0,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:01.000Z',
    state,
    warnings: [],
    items: photoKeys.map((photoKey, index) => ({
      photoKey,
      index: post.photos.find(photo => photo.key === photoKey)?.index ?? index + 1,
      relativePath: `photo-${index + 1}.jpg`,
      downloadId: index + 100,
      state: state === 'complete' ? 'complete' : state === 'failed' ? 'failed' : 'in_progress',
      error: state === 'failed' ? 'Native download failed' : null,
    })),
  };
}

function makeHarness(fixture: Fixture, overrides: {
  send?: (request: DownloadStartRequest) => Promise<ExtensionResponse>;
  get?: (jobId: string) => Promise<ExtensionResponse>;
} = {}) {
  let result = fixture.result;
  const statusListeners = new Set<(job: DownloadJob) => void>();
  const requests: DownloadStartRequest[] = [];
  const readPost = vi.fn(() => result);
  const sendDownloadRequest = vi.fn(async (request: DownloadStartRequest) => {
    requests.push(request);
    return overrides.send ? overrides.send(request) : { ok: false as const, error: { code: 'not-configured', message: 'not configured' } };
  });
  const getDownloadStatus = vi.fn(async (jobId: string) => overrides.get
    ? overrides.get(jobId)
    : { ok: false as const, error: { code: 'job_not_found', message: 'not found' } });
  const controller = createContentController(fixture.post.ownerDocument, {
    readPost,
    findBulkMount: post => post.querySelector('[role="group"]') as HTMLElement | null,
    findPhotoMount: wrapper => wrapper,
    sendDownloadRequest,
    getDownloadStatus,
    subscribeDownloadStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    createRequestId: () => 'request-new',
  });
  return {
    controller,
    requests,
    readPost,
    sendDownloadRequest,
    getDownloadStatus,
    statusListeners,
    setResult(next: PostReadResult) { result = next; },
  };
}

async function flushMutationObserver(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function installContentStyles(document: Document, nativeCss: string): () => void {
  const nativeStyle = document.createElement('style');
  nativeStyle.textContent = nativeCss;
  const extensionStyle = document.createElement('style');
  extensionStyle.textContent = contentCss;
  document.head.append(nativeStyle, extensionStyle);
  return () => {
    nativeStyle.remove();
    extensionStyle.remove();
  };
}

describe('in-page photo controls', () => {
  it('preserves X class-based absolute photo geometry while adding the overlay button', () => {
    document.body.replaceChildren();
    const removeStyles = installContentStyles(document, '.native-photo-media { position: absolute; inset: 0; top: 0; right: 0; bottom: 0; left: 0; }');
    const fixture = makeFixture(document, 1);
    const wrapper = fixture.wrappers[0]!;
    wrapper.classList.add('native-photo-media');
    const nativeImage = wrapper.querySelector('img')!;
    const harness = makeHarness(fixture);

    try {
      const before = document.defaultView!.getComputedStyle(wrapper);
      expect(before.position).toBe('absolute');
      expect([before.top, before.right, before.bottom, before.left]).toEqual(['0px', '0px', '0px', '0px']);

      harness.controller.start();

      expect(wrapper.querySelector('[data-x-download-control="photo"]')).not.toBeNull();
      expect(nativeImage.isConnected).toBe(true);
      const after = document.defaultView!.getComputedStyle(wrapper);
      expect(after.position).toBe('absolute');
      expect([after.top, after.right, after.bottom, after.left]).toEqual(['0px', '0px', '0px', '0px']);
      expect(wrapper.hasAttribute('data-x-download-photo-host')).toBe(false);
    } finally {
      harness.controller.stop();
      removeStyles();
    }
  });

  it('positions only static photo mounts and restores their inline position state safely', () => {
    document.body.replaceChildren();
    const removeStyles = installContentStyles(document, '.native-photo-media { position: static; }');
    const fixture = makeFixture(document, 2);
    const [preservedWrapper, changedWrapper] = fixture.wrappers as [HTMLElement, HTMLElement];
    preservedWrapper.classList.add('native-photo-media');
    preservedWrapper.style.setProperty('position', 'static', 'important');
    preservedWrapper.style.setProperty('overflow', 'hidden');
    changedWrapper.classList.add('native-photo-media');
    const harness = makeHarness(fixture);

    try {
      harness.controller.start();

      expect(preservedWrapper.querySelector('[data-x-download-control="photo"]')).not.toBeNull();
      expect(changedWrapper.querySelector('[data-x-download-control="photo"]')).not.toBeNull();
      expect(preservedWrapper.style.getPropertyValue('position')).toBe('relative');
      expect(preservedWrapper.style.getPropertyPriority('position')).toBe('important');
      expect(changedWrapper.style.getPropertyValue('position')).toBe('relative');
      expect(preservedWrapper.getAttribute('data-x-download-photo-host')).toBe('positioned');

      changedWrapper.style.setProperty('position', 'absolute');
      changedWrapper.style.setProperty('inset', '0');
      harness.controller.stop();

      expect(preservedWrapper.style.getPropertyValue('position')).toBe('static');
      expect(preservedWrapper.style.getPropertyPriority('position')).toBe('important');
      expect(preservedWrapper.style.getPropertyValue('overflow')).toBe('hidden');
      expect(changedWrapper.style.getPropertyValue('position')).toBe('absolute');
      expect(changedWrapper.style.getPropertyValue('inset')).toBe('0px');
      expect(preservedWrapper.hasAttribute('data-x-download-photo-host')).toBe(false);
      expect(changedWrapper.hasAttribute('data-x-download-photo-host')).toBe(false);
    } finally {
      harness.controller.stop();
      removeStyles();
    }
  });

  it.each([1, 2, 3, 4])('adds per-photo buttons for %i photos and shows only a truthful bulk total', photosCount => {
    document.body.replaceChildren();
    const fixture = makeFixture(document, photosCount);
    const harness = makeHarness(fixture);
    harness.controller.start();

    const photoButtons = fixture.post.querySelectorAll<HTMLButtonElement>('[data-x-download-control="photo"]');
    expect(photoButtons).toHaveLength(photosCount);
    for (const [offset, button] of Array.from(photoButtons).entries()) {
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(button.getAttribute('aria-label')).toBe(`사진 ${offset + 1} 저장`);
      expect(button.title).toBe(`사진 ${offset + 1} 저장`);
    }
    const bulk = fixture.actionRow.querySelector<HTMLButtonElement>('[data-x-download-control="bulk"]');
    if (photosCount === 1) {
      expect(bulk).toBeNull();
    } else {
      expect(bulk?.textContent).toBe(String(photosCount));
      expect(bulk?.getAttribute('aria-label')).toBe(`${photosCount}장 모두 저장`);
      expect(bulk?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(bulk?.title).toBe(`${photosCount}장 모두 저장`);
      expect(bulk?.disabled).toBe(false);
    }
    const nativeOrder = Array.from(fixture.actionRow.querySelectorAll('button:not([data-x-download-control])'))
      .map(button => button.textContent);
    expect(nativeOrder).toEqual(['reply', 'retweet', 'like', 'bookmark', 'share']);
    if (bulk) {
      expect(bulk.previousElementSibling?.textContent).toBe('share');
      expect(bulk.nextElementSibling?.getAttribute('data-x-download-control')).toBe('status');
    } else {
      expect(fixture.actionRow.lastElementChild?.getAttribute('data-x-download-control')).toBe('status');
    }
    harness.controller.stop();
  });

  it('keeps a known expected total visible but disabled until the full list is complete', () => {
    document.body.replaceChildren();
    const fixture = makeFixture(document, 2, 4, 'partial');
    const harness = makeHarness(fixture);
    harness.controller.start();
    const bulk = fixture.actionRow.querySelector<HTMLButtonElement>('[data-x-download-control="bulk"]');
    expect(bulk?.textContent).toBe('4');
    expect(bulk?.getAttribute('aria-label')).toBe('4장 모두 저장');
    expect(bulk?.querySelector('svg')).not.toBeNull();
    expect(bulk?.title).toBe('전체 사진 목록을 확인한 뒤 저장할 수 있어요.');
    expect(bulk?.disabled).toBe(true);
    harness.controller.stop();
  });

  it('does not present visible photos as the full count when the total is unknown', () => {
    document.body.replaceChildren();
    const fixture = makeFixture(document, 2, null, 'unknown');
    const harness = makeHarness(fixture);
    harness.controller.start();
    const bulk = fixture.actionRow.querySelector<HTMLButtonElement>('[data-x-download-control="bulk"]');
    expect(bulk?.textContent).toBe('…');
    expect(bulk?.getAttribute('aria-label')).toBe('전체 사진 수 확인 중');
    expect(bulk?.querySelector('svg')).not.toBeNull();
    expect(bulk?.title).toBe('전체 사진 목록을 확인한 뒤 저장할 수 있어요.');
    expect(bulk?.disabled).toBe(true);
    expect(bulk?.textContent).not.toContain('2');
    harness.controller.stop();
  });

  it('sends the clicked photo key and prevents the native image click', async () => {
    document.body.replaceChildren();
    const fixture = makeFixture(document, 3);
    const selectedKey = fixture.result.snapshot.photos[2]!.key;
    const job = makeJob(fixture.result.snapshot, [selectedKey]);
    const harness = makeHarness(fixture, {
      send: async () => ({ ok: true, job }),
      get: async () => ({ ok: true, job }),
    });
    harness.controller.start();
    let nativeClickCount = 0;
    fixture.post.addEventListener('click', () => { nativeClickCount += 1; });
    const button = fixture.wrappers[2]!.querySelector<HTMLButtonElement>('[data-x-download-control="photo"]')!;
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.getAttribute('aria-label')).toBe('사진 3 저장');
    expect(button.title).toBe('사진 3 저장');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    await vi.waitFor(() => expect(harness.sendDownloadRequest).toHaveBeenCalledTimes(1));

    expect(event.defaultPrevented).toBe(true);
    expect(nativeClickCount).toBe(0);
    expect(harness.requests[0]?.selection).toEqual({ photoKeys: [selectedKey] });
    expect(harness.requests[0]?.post.photos[2]?.index).toBe(3);
    expect(button.disabled).toBe(true);
    harness.controller.stop();
  });

  it('adopts a duplicate job requestId, shows progress, reports failures, and unlocks after terminal status', async () => {
    document.body.replaceChildren();
    const fixture = makeFixture(document, 2);
    const photoKeys = fixture.result.snapshot.photos.map(photo => photo.key);
    const duplicateJob = makeJob(fixture.result.snapshot, photoKeys, 'in_progress', 'request-original');
    let currentJob = duplicateJob;
    const harness = makeHarness(fixture, {
      send: async () => ({ ok: true, job: currentJob }),
      get: async () => ({ ok: true, job: currentJob }),
    });
    harness.controller.start();
    const bulk = fixture.actionRow.querySelector<HTMLButtonElement>('[data-x-download-control="bulk"]')!;
    expect(bulk.textContent).toBe('2');
    expect(bulk.querySelector('svg')).not.toBeNull();
    bulk.click();
    await vi.waitFor(() => expect(bulk.disabled).toBe(true));
    await vi.waitFor(() => expect(fixture.actionRow.querySelector('.x-download-status')?.textContent).toContain('저장 중'));
    expect(harness.requests[0]?.requestId).toBe('request-new');
    bulk.click();
    expect(harness.sendDownloadRequest).toHaveBeenCalledTimes(1);

    currentJob = {
      ...duplicateJob,
      state: 'partial',
      items: [
        { ...duplicateJob.items[0]!, state: 'complete', error: null },
        { ...duplicateJob.items[1]!, state: 'failed', error: 'Network interrupted' },
      ],
    };
    const statusListener = [...harness.statusListeners][0]!;
    statusListener(currentJob);
    expect(fixture.actionRow.querySelector('.x-download-status')?.textContent)
      .toContain('일부 사진 저장 실패');
    expect(fixture.actionRow.querySelector('.x-download-status')?.textContent)
      .toContain('Network interrupted');
    expect(bulk.disabled).toBe(false);
    expect(bulk.textContent).toBe('2');
    expect(bulk.querySelector('svg')).not.toBeNull();
    expect(bulk.getAttribute('aria-label')).toBe('2장 모두 저장');

    statusListener({ ...currentJob, requestId: 'another-request', state: 'failed' });
    expect(fixture.actionRow.querySelector('.x-download-status')?.textContent)
      .toContain('일부 사진 저장 실패');
    harness.controller.stop();
  });

  it('shows plan warnings alongside both in-progress and complete job status', async () => {
    document.body.replaceChildren();
    const fixture = makeFixture(document, 1);
    const photoKey = fixture.result.snapshot.photos[0]!.key;
    const job = makeJob(fixture.result.snapshot, [photoKey], 'in_progress');
    job.warnings = ['작성자 정보가 없어 원본 파일명으로 저장합니다.'];
    const harness = makeHarness(fixture, {
      send: async () => ({ ok: true, job }),
      get: async () => ({ ok: true, job }),
    });
    harness.controller.start();
    fixture.wrappers[0]!.querySelector<HTMLButtonElement>('[data-x-download-control="photo"]')!.click();
    const status = fixture.post.querySelector<HTMLElement>('.x-download-status')!;
    await vi.waitFor(() => expect(status.textContent).toContain(job.warnings[0]!));
    expect(status.textContent).toContain('저장 중');

    const complete: DownloadJob = {
      ...job,
      state: 'complete',
      items: job.items.map(item => ({ ...item, state: 'complete', error: null })),
    };
    [...harness.statusListeners][0]!(complete);
    expect(status.textContent).toContain('사진 저장 완료');
    expect(status.textContent).toContain(job.warnings[0]!);
    harness.controller.stop();
  });

  it('recreates controls when a photo mount is replaced without a fingerprint change', async () => {
    document.body.replaceChildren();
    const fixture = makeFixture(document, 2);
    const harness = makeHarness(fixture);
    harness.controller.start();
    const originalFingerprint = fixture.result.fingerprint;
    const oldWrapper = fixture.wrappers[0]!;
    const replacement = document.createElement('div');
    replacement.dataset.testid = 'tweetPhoto';
    replacement.append(document.createElement('img'));
    oldWrapper.replaceWith(replacement);
    fixture.wrappers[0] = replacement;
    harness.setResult({
      ...fixture.result,
      photoTargets: new Map([
        [fixture.result.snapshot.photos[0]!.key, replacement],
        [fixture.result.snapshot.photos[1]!.key, fixture.wrappers[1]!],
      ]),
      fingerprint: originalFingerprint,
    });

    await vi.waitFor(() => expect(replacement.querySelector('[data-x-download-control="photo"]')).not.toBeNull());
    expect(fixture.post.querySelectorAll('[data-x-download-control="photo"]')).toHaveLength(2);
    expect(oldWrapper.querySelector('[data-x-download-control="photo"]')).toBeNull();
    harness.controller.stop();
  });

  it('ignores stale status when X reuses the same article node for another post', async () => {
    document.body.replaceChildren();
    const fixture = makeFixture(document, 1);
    const oldJob = makeJob(fixture.result.snapshot, [fixture.result.snapshot.photos[0]!.key]);
    const harness = makeHarness(fixture, { send: async () => ({ ok: true, job: oldJob }) });
    harness.controller.start();
    fixture.wrappers[0]!.querySelector<HTMLButtonElement>('[data-x-download-control="photo"]')!.click();
    await vi.waitFor(() => expect(fixture.post.querySelector('.x-download-status')?.textContent).toContain('저장 중'));

    const next = makeFixture(document, 1, 1, 'complete', 'x:status:post-2');
    next.post.remove();
    const nextPhoto = next.result.snapshot.photos[0]!;
    const oldWrapper = fixture.wrappers[0]!;
    oldWrapper.querySelector('[data-x-download-control="photo"]')?.remove();
    const newPhoto = document.createElement('div');
    newPhoto.dataset.testid = 'tweetPhoto';
    newPhoto.append(document.createElement('img'));
    oldWrapper.replaceWith(newPhoto);
    fixture.wrappers[0] = newPhoto;
    const nextSnapshot: PostSnapshot = { ...next.result.snapshot, photos: [{ ...nextPhoto, key: `${nextPhoto.key}:reused` }] };
    harness.setResult({
      snapshot: nextSnapshot,
      photoTargets: new Map([[nextSnapshot.photos[0]!.key, newPhoto]]),
      fingerprint: 'reused-post-fingerprint',
    });
    fixture.post.append(document.createElement('span'));
    await vi.waitFor(() => expect(fixture.wrappers[0]!.querySelector('[data-x-download-control="photo"]')).not.toBeNull());
    expect(harness.controller.bindingCount()).toBe(1);
    expect(fixture.post.querySelector('.x-download-status')?.textContent).toBe('');

    const listener = [...harness.statusListeners][0]!;
    listener({ ...oldJob, state: 'complete', items: oldJob.items.map(item => ({ ...item, state: 'complete' })) });
    expect(fixture.post.querySelector('.x-download-status')?.textContent).toBe('');
    harness.controller.stop();
  });

  it('ignores its own observer mutations and releases controls for removed posts', async () => {
    document.body.replaceChildren();
    const fixture = makeFixture(document, 2);
    const harness = makeHarness(fixture);
    harness.controller.start();
    await flushMutationObserver();
    expect(harness.readPost).toHaveBeenCalledTimes(1);
    expect(harness.controller.bindingCount()).toBe(1);

    fixture.post.remove();
    await vi.waitFor(() => expect(harness.controller.bindingCount()).toBe(0));
    expect(fixture.post.querySelectorAll('[data-x-download-control]')).toHaveLength(0);
    harness.controller.stop();
  });
});
