import type {
  DownloadJob,
  DownloadSelection,
  DownloadStartRequest,
  ExtensionResponse,
  PostSnapshot,
} from '../core/types';
import { getDownloadStatus, sendDownloadRequest, subscribeDownloadStatus } from '../platform/messaging';
import { findBulkMount, findPhotoMount } from '../x/mount-points';
import { readPostSnapshot, type PostReadResult } from '../x/post-reader';
import { X_SELECTORS } from '../x/selectors';
import { createPostControls, renderPostControls, type PostControls } from './controls';
import { observePosts, type PostMutationObserver } from './observer';

export interface ContentControllerDependencies {
  readPost(post: HTMLElement): PostReadResult | null;
  findBulkMount(post: HTMLElement): HTMLElement | null;
  findPhotoMount(wrapper: HTMLElement): HTMLElement | null;
  sendDownloadRequest(request: DownloadStartRequest): Promise<ExtensionResponse>;
  getDownloadStatus(jobId: string): Promise<ExtensionResponse>;
  subscribeDownloadStatus(listener: (job: DownloadJob) => void): () => void;
  createRequestId(): string;
}

export interface ContentController {
  start(): void;
  stop(): void;
  reconcile(post: HTMLElement): void;
  bindingCount(): number;
}

interface PostBinding {
  post: HTMLElement;
  snapshot: PostSnapshot;
  fingerprint: string;
  photoMounts: Map<string, HTMLElement>;
  bulkMount: HTMLElement | null;
  statusHost: HTMLElement;
  controls: PostControls;
  job: DownloadJob | null;
  requestId: string | null;
  requestPending: boolean;
  error: string | null;
}

const DEFAULT_DEPENDENCIES: ContentControllerDependencies = {
  readPost: readPostSnapshot,
  findBulkMount,
  findPhotoMount,
  sendDownloadRequest,
  getDownloadStatus,
  subscribeDownloadStatus,
  createRequestId: defaultRequestId,
};

function defaultRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `x-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sameMounts(left: Map<string, HTMLElement>, right: Map<string, HTMLElement>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, mount] of left) if (right.get(key) !== mount) return false;
  return true;
}

function allControlsConnected(controls: PostControls): boolean {
  if (!controls.status.isConnected) return false;
  if (controls.bulkButton && !controls.bulkButton.isConnected) return false;
  return [...controls.photoButtons.values()].every(button => button.isConnected);
}

function isBulkSelectionComplete(snapshot: PostSnapshot): boolean {
  return snapshot.expectedPhotoCount !== null
    && snapshot.expectedPhotoCount >= 2
    && snapshot.completeness === 'complete'
    && snapshot.photos.length === snapshot.expectedPhotoCount;
}

export function createContentController(
  document: Document,
  overrides: Partial<ContentControllerDependencies> = {},
): ContentController {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const bindings = new Map<HTMLElement, PostBinding>();
  let observer: PostMutationObserver | null = null;
  let unsubscribeStatus: (() => void) | null = null;
  let started = false;

  const disposeBinding = (post: HTMLElement) => {
    const binding = bindings.get(post);
    if (!binding) return;
    binding.controls.cleanup();
    bindings.delete(post);
  };

  const isCurrentBinding = (binding: PostBinding): boolean =>
    bindings.get(binding.post) === binding && binding.post.isConnected;

  const render = (binding: PostBinding) => {
    renderPostControls(binding.controls, binding.snapshot, {
      requestPending: binding.requestPending,
      job: binding.job,
      error: binding.error,
    });
  };

  const buildMounts = (post: HTMLElement, result: PostReadResult) => {
    const photoMounts = new Map<string, HTMLElement>();
    for (const [photoKey, wrapper] of result.photoTargets) {
      const mount = dependencies.findPhotoMount(wrapper);
      if (mount) photoMounts.set(photoKey, mount);
    }
    const bulkMount = dependencies.findBulkMount(post);
    return { photoMounts, bulkMount, statusHost: bulkMount ?? post };
  };

  const rebuildControls = (binding: PostBinding, result: PostReadResult) => {
    binding.controls.cleanup();
    const mounts = buildMounts(binding.post, result);
    binding.photoMounts = mounts.photoMounts;
    binding.bulkMount = mounts.bulkMount;
    binding.statusHost = mounts.statusHost;
    binding.controls = createPostControls(document, binding.snapshot, mounts, {
      onSavePhoto: photoKey => { void beginDownload(binding, { photoKeys: [photoKey] }); },
      onSaveAll: () => { void beginDownload(binding, 'all'); },
    });
    render(binding);
  };

  const reconcile = (post: HTMLElement) => {
    if (!post.isConnected || !post.matches(X_SELECTORS.post)) {
      disposeBinding(post);
      return;
    }
    const result = dependencies.readPost(post);
    if (!result) {
      disposeBinding(post);
      return;
    }

    let binding = bindings.get(post);
    if (binding && binding.snapshot.key !== result.snapshot.key) {
      disposeBinding(post);
      binding = undefined;
    }
    if (!binding) {
      const mounts = buildMounts(post, result);
      binding = {
        post,
        snapshot: result.snapshot,
        fingerprint: result.fingerprint,
        ...mounts,
        controls: createPostControls(document, result.snapshot, mounts, {
          onSavePhoto: photoKey => { void beginDownload(binding!, { photoKeys: [photoKey] }); },
          onSaveAll: () => { void beginDownload(binding!, 'all'); },
        }),
        job: null,
        requestId: null,
        requestPending: false,
        error: null,
      };
      bindings.set(post, binding);
      render(binding);
      return;
    }

    const mounts = buildMounts(post, result);
    const shouldRebuild = binding.fingerprint !== result.fingerprint
      || !sameMounts(binding.photoMounts, mounts.photoMounts)
      || binding.bulkMount !== mounts.bulkMount
      || binding.statusHost !== mounts.statusHost
      || !allControlsConnected(binding.controls);
    binding.snapshot = result.snapshot;
    binding.fingerprint = result.fingerprint;
    if (shouldRebuild) rebuildControls(binding, result);
    else render(binding);
  };

  const refreshJob = async (binding: PostBinding, jobId: string, postKey: string, requestId: string) => {
    let response: ExtensionResponse;
    try {
      response = await dependencies.getDownloadStatus(jobId);
    } catch {
      return;
    }
    if (!isCurrentBinding(binding) || binding.snapshot.key !== postKey || !response.ok) return;
    if (response.job.id !== jobId || response.job.postKey !== postKey || response.job.requestId !== requestId) return;
    binding.job = response.job;
    render(binding);
  };

  async function beginDownload(binding: PostBinding, selection: DownloadSelection): Promise<void> {
    if (!isCurrentBinding(binding) || binding.requestPending
      || binding.job?.state === 'starting' || binding.job?.state === 'in_progress') return;
    if (selection === 'all' && !isBulkSelectionComplete(binding.snapshot)) return;

    const postKey = binding.snapshot.key;
    const requestId = dependencies.createRequestId();
    binding.requestId = requestId;
    binding.requestPending = true;
    binding.job = null;
    binding.error = null;
    render(binding);

    let response: ExtensionResponse;
    try {
      response = await dependencies.sendDownloadRequest({
        type: 'download.start',
        requestId,
        post: binding.snapshot,
        selection,
      });
    } catch (cause) {
      if (!isCurrentBinding(binding) || binding.snapshot.key !== postKey) return;
      binding.requestPending = false;
      binding.error = cause instanceof Error ? cause.message : '다운로드 요청을 보낼 수 없어요.';
      render(binding);
      return;
    }

    if (!isCurrentBinding(binding) || binding.snapshot.key !== postKey) return;
    binding.requestPending = false;
    if (!response.ok) {
      binding.requestId = null;
      binding.error = response.error.message;
      render(binding);
      return;
    }

    const job = response.job;
    if (job.postKey !== postKey) {
      binding.requestId = null;
      binding.error = '다운로드 응답이 현재 게시물과 일치하지 않아요.';
      render(binding);
      return;
    }
    binding.job = job;
    // A same-selection duplicate may return the already-running job's original requestId.
    binding.requestId = job.requestId;
    binding.error = null;
    render(binding);
    if (job.state === 'starting' || job.state === 'in_progress') {
      void refreshJob(binding, job.id, job.postKey, job.requestId);
    }
  }

  const onStatus = (job: DownloadJob) => {
    for (const binding of bindings.values()) {
      if (!binding.job || binding.job.id !== job.id) continue;
      if (binding.snapshot.key !== job.postKey || binding.requestId !== job.requestId) continue;
      binding.job = job;
      binding.error = null;
      render(binding);
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      unsubscribeStatus = dependencies.subscribeDownloadStatus(onStatus);
      observer = observePosts({
        document,
        onPostChanged: reconcile,
        onPostRemoved: disposeBinding,
      });
    },
    stop() {
      if (!started) return;
      observer?.stop();
      observer = null;
      unsubscribeStatus?.();
      unsubscribeStatus = null;
      for (const post of [...bindings.keys()]) disposeBinding(post);
      started = false;
    },
    reconcile,
    bindingCount: () => bindings.size,
  };
}
