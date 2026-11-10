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
import { createMediaMetadataBridge } from './media-bridge';

export const COMPLETION_NOTICE_MS = 2000;
const MAX_POST_VIEW_STATES = 200;

interface PostViewState {
  savedKeys: Set<string>;
  job: DownloadJob | null;
  successJobId: string | null;
  successUntil: number;
}

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
  view: PostViewState;
  completionTimer: ReturnType<typeof setTimeout> | null;
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
    && (snapshot.expectedPhotoCount >= 2 || snapshot.photos.some(media => media.kind !== 'image'))
    && snapshot.completeness === 'complete'
    && snapshot.photos.length === snapshot.expectedPhotoCount;
}

export function createContentController(
  document: Document,
  overrides: Partial<ContentControllerDependencies> = {},
): ContentController {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const bindings = new Map<HTMLElement, PostBinding>();
  // Bounded page-memory feedback, independent of temporary download jobs.
  const postViews = new Map<string, PostViewState>();
  let mediaBridge: ReturnType<typeof createMediaMetadataBridge> | null = null;
  let observer: PostMutationObserver | null = null;
  let unsubscribeStatus: (() => void) | null = null;
  let started = false;

  const disposeBinding = (post: HTMLElement) => {
    const binding = bindings.get(post);
    if (!binding) return;
    if (binding.completionTimer !== null) clearTimeout(binding.completionTimer);
    binding.controls.cleanup();
    bindings.delete(post);
  };

  const isCurrentBinding = (binding: PostBinding): boolean =>
    bindings.get(binding.post) === binding && binding.post.isConnected;

  const render = (binding: PostBinding) => {
    const { view, job } = binding;
    view.job = job;
    for (const item of job?.items ?? []) {
      if (item.state === 'complete') view.savedKeys.add(item.photoKey);
    }
    if (job?.state === 'complete' && view.successJobId !== job.id) {
      view.successJobId = job.id;
      view.successUntil = Date.now() + COMPLETION_NOTICE_MS;
    }
    const showSuccess = job?.state === 'complete' && Date.now() < view.successUntil;
    renderPostControls(binding.controls, binding.snapshot, {
      requestPending: binding.requestPending,
      job: binding.job,
      error: binding.error,
      savedPhotoKeys: view.savedKeys,
      hideCompletedStatus: job?.state === 'complete' && !showSuccess,
    });
    if (!showSuccess && binding.completionTimer !== null) {
      clearTimeout(binding.completionTimer);
      binding.completionTimer = null;
    }
    if (showSuccess && binding.completionTimer === null) {
      binding.completionTimer = setTimeout(() => {
        binding.completionTimer = null;
        if (isCurrentBinding(binding)) render(binding);
      }, Math.max(0, view.successUntil - Date.now()));
    }
  };

  const viewFor = (postKey: string): PostViewState => {
    let view = postViews.get(postKey);
    if (!view) {
      view = { savedKeys: new Set(), job: null, successJobId: null, successUntil: 0 };
      postViews.set(postKey, view);
      if (postViews.size > MAX_POST_VIEW_STATES) {
        const oldest = [...postViews].find(([key, value]) => key !== postKey
          && value.job?.state !== 'starting' && value.job?.state !== 'in_progress');
        if (oldest) postViews.delete(oldest[0]);
      }
    }
    return view;
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
    const result = overrides.readPost
      ? dependencies.readPost(post)
      : readPostSnapshot(post, postId => mediaBridge?.get(postId) ?? null);
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
      const view = viewFor(result.snapshot.key);
      binding = {
        post,
        snapshot: result.snapshot,
        fingerprint: result.fingerprint,
        ...mounts,
        controls: createPostControls(document, result.snapshot, mounts, {
          onSavePhoto: photoKey => { void beginDownload(binding!, { photoKeys: [photoKey] }); },
          onSaveAll: () => { void beginDownload(binding!, 'all'); },
        }),
        job: view.job,
        requestId: view.job?.requestId ?? null,
        requestPending: false,
        error: null,
        view,
        completionTimer: null,
      };
      bindings.set(post, binding);
      render(binding);
      if (binding.job?.state === 'starting' || binding.job?.state === 'in_progress') {
        void refreshJob(binding, binding.job.id, binding.snapshot.key, binding.job.requestId);
      }
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
    if (binding.job?.id !== jobId || binding.requestId !== requestId) return;
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
      if (document.defaultView) {
        mediaBridge = createMediaMetadataBridge(document.defaultView, () => {
          if (!started) return;
          for (const post of document.querySelectorAll<HTMLElement>(X_SELECTORS.post)) reconcile(post);
        });
      }
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
      mediaBridge?.stop();
      mediaBridge = null;
      for (const post of [...bindings.keys()]) disposeBinding(post);
      postViews.clear();
      started = false;
    },
    reconcile,
    bindingCount: () => bindings.size,
  };
}
