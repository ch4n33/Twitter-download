import type { DownloadJob, PhotoAsset, PostSnapshot } from '../core/types';
import { makeDownloadIcon } from './download-icons';

export interface PostControlHandlers {
  onSavePhoto(photoKey: string, event: MouseEvent): void;
  onSaveAll(event: MouseEvent): void;
}

export interface PostControlMounts {
  photoMounts: Map<string, HTMLElement>;
  bulkMount: HTMLElement | null;
  statusHost: HTMLElement;
}

export interface PostControls {
  photoButtons: Map<string, HTMLButtonElement>;
  bulkButton: HTMLButtonElement | null;
  status: HTMLElement;
  cleanup(): void;
}

export interface PostControlState {
  requestPending: boolean;
  job: DownloadJob | null;
  error: string | null;
  savedPhotoKeys?: ReadonlySet<string>;
  hideCompletedStatus?: boolean;
}

function mediaLabel(media: PhotoAsset): string {
  return `${media.kind === 'image' ? '사진' : media.kind === 'animated_gif' ? 'GIF' : '동영상'} ${media.index}`;
}

function photoOnly(snapshot: PostSnapshot): boolean {
  return snapshot.photos.every(media => media.kind === 'image');
}

function bulkLabel(snapshot: PostSnapshot): string {
  const expected = snapshot.expectedPhotoCount;
  if (expected === null) return photoOnly(snapshot) ? '전체 사진 수 확인 중' : '전체 미디어 수 확인 중';
  if (expected === 1 && snapshot.photos[0]?.kind !== 'image') return `${mediaLabel(snapshot.photos[0]!)} 저장`;
  return `${expected}${photoOnly(snapshot) ? '장' : '개'} 모두 저장`;
}

function updateIcon(button: HTMLButtonElement, saved: boolean): void {
  const state = saved ? 'saved' : 'download';
  if (button.dataset.downloadState === state) return;
  button.dataset.downloadState = state;
  const oldIcon = button.querySelector('svg');
  const icon = makeDownloadIcon(button.ownerDocument, 20, saved);
  if (oldIcon) oldIcon.replaceWith(icon);
  else button.prepend(icon);
}

function makeButton(document: Document, kind: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `x-download-${kind}-button`;
  button.setAttribute('data-x-download-control', kind);
  return button;
}

function addClickGuard(button: HTMLButtonElement, listener: (event: MouseEvent) => void, cleanup: Array<() => void>): void {
  const stopPointer = (event: Event) => event.stopPropagation();
  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    listener(event);
  };
  button.addEventListener('pointerdown', stopPointer);
  button.addEventListener('mousedown', stopPointer);
  button.addEventListener('click', onClick);
  cleanup.push(() => {
    button.removeEventListener('pointerdown', stopPointer);
    button.removeEventListener('mousedown', stopPointer);
    button.removeEventListener('click', onClick);
  });
}

const PHOTO_HOST_ATTRIBUTE = 'data-x-download-photo-host';
const PHOTO_HOST_ATTRIBUTE_VALUE = 'positioned';

function positionStaticPhotoMount(
  document: Document,
  mount: HTMLElement,
  cleanup: Array<() => void>,
): void {
  const position = (document.defaultView?.getComputedStyle(mount).position
    || mount.style.getPropertyValue('position')).trim().toLowerCase();
  if (position && position !== 'static') return;

  const originalPosition = mount.style.getPropertyValue('position');
  const originalPriority = mount.style.getPropertyPriority('position');
  mount.style.setProperty('position', 'relative', originalPriority);

  const ownsMarker = !mount.hasAttribute(PHOTO_HOST_ATTRIBUTE);
  if (ownsMarker) mount.setAttribute(PHOTO_HOST_ATTRIBUTE, PHOTO_HOST_ATTRIBUTE_VALUE);

  cleanup.push(() => {
    if (mount.style.getPropertyValue('position') === 'relative'
      && mount.style.getPropertyPriority('position') === originalPriority) {
      if (originalPosition) mount.style.setProperty('position', originalPosition, originalPriority);
      else mount.style.removeProperty('position');
    }
    if (ownsMarker && mount.getAttribute(PHOTO_HOST_ATTRIBUTE) === PHOTO_HOST_ATTRIBUTE_VALUE) {
      mount.removeAttribute(PHOTO_HOST_ATTRIBUTE);
    }
  });
}

export function createPostControls(
  document: Document,
  snapshot: PostSnapshot,
  mounts: PostControlMounts,
  handlers: PostControlHandlers,
): PostControls {
  const cleanup: Array<() => void> = [];
  const photoButtons = new Map<string, HTMLButtonElement>();

  for (const photo of snapshot.photos) {
    const mount = mounts.photoMounts.get(photo.key);
    if (!mount) continue;
    positionStaticPhotoMount(document, mount, cleanup);
    const button = makeButton(document, 'photo');
    button.append(makeDownloadIcon(document, 20));
    button.setAttribute('aria-label', `${mediaLabel(photo)} 저장`);
    button.title = `${mediaLabel(photo)} 저장`;
    addClickGuard(button, event => handlers.onSavePhoto(photo.key, event), cleanup);
    mount.append(button);
    photoButtons.set(photo.key, button);
  }

  const expected = snapshot.expectedPhotoCount;
  const shouldShowBulk = expected !== null
    ? expected >= 2 || snapshot.photos.length > 1 || !photoOnly(snapshot)
    : snapshot.photos.length > 1;
  let bulkButton: HTMLButtonElement | null = null;
  if (shouldShowBulk && mounts.bulkMount) {
    const knownMultiPhotoTotal = expected !== null && expected >= 1;
    const buttonLabel = bulkLabel(snapshot);
    bulkButton = makeButton(document, 'bulk');
    bulkButton.append(makeDownloadIcon(document, 20));
    const count = document.createElement('span');
    count.className = 'x-download-bulk-count';
    count.setAttribute('data-x-download-count', '');
    count.textContent = knownMultiPhotoTotal ? String(expected) : '…';
    count.hidden = expected === 1;
    bulkButton.append(count);
    bulkButton.setAttribute('aria-label', buttonLabel);
    bulkButton.title = knownMultiPhotoTotal ? buttonLabel : '전체 사진 목록을 확인한 뒤 저장할 수 있어요.';
    addClickGuard(bulkButton, handlers.onSaveAll, cleanup);
    mounts.bulkMount.append(bulkButton);
  }

  const status = document.createElement('span');
  status.className = 'x-download-status';
  status.setAttribute('data-x-download-control', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  mounts.statusHost.append(status);

  return {
    photoButtons,
    bulkButton,
    status,
    cleanup() {
      for (const remove of cleanup.splice(0)) remove();
      for (const button of photoButtons.values()) button.remove();
      bulkButton?.remove();
      status.remove();
      photoButtons.clear();
    },
  };
}

function jobStatusText(job: DownloadJob, snapshot: PostSnapshot): string {
  const total = job.items.length;
  const complete = job.items.filter(item => item.state === 'complete').length;
  const failedItems = job.items.filter(item => item.state === 'failed');
  const failed = failedItems.length;
  const firstError = failedItems.find(item => item.error)?.error;
  const noun = photoOnly(snapshot) ? '사진' : '미디어';
  const unit = photoOnly(snapshot) ? '장' : '개';
  const converting = job.items.filter(item => item.state === 'converting');
  let summary: string;
  if (converting.length > 0) {
    const progress = converting[0]?.progress;
    summary = `GIF 변환 중${progress === undefined ? '' : `: ${Math.round(progress)}%`}${total > 1 ? ` · ${complete}/${total}개 저장 완료` : ''}`;
  } else if (job.state === 'starting') {
    summary = failed > 0
      ? `저장 요청 중: ${complete}${unit} 완료, ${failed}${unit} 실패${firstError ? ` — ${firstError}` : ''}`
      : '저장 요청을 준비하고 있어요.';
  } else if (job.state === 'in_progress') {
    summary = `${noun} 저장 중: ${complete + failed}/${total}${unit} 처리${failed > 0 ? `, ${failed}${unit} 실패` : ''}${firstError ? ` — ${firstError}` : ''}`;
  } else if (job.state === 'complete') {
    summary = `${noun} 저장 완료 (${complete}/${total}${unit})`;
  } else if (job.state === 'partial') {
    summary = `일부 ${noun} 저장 실패 (${complete}${unit} 완료, ${failed}${unit} 실패)${firstError ? ` — ${firstError}` : ''}`;
  } else {
    summary = `${noun} 저장 실패${firstError ? ` — ${firstError}` : ''}`;
  }

  const warnings = job.warnings.filter(warning => warning.trim().length > 0);
  const firstWarning = warnings[0];
  if (!firstWarning) return summary;
  const trimmedWarning = firstWarning.trim();
  const conciseWarning = trimmedWarning.length > 160
    ? `${trimmedWarning.slice(0, 157)}…`
    : trimmedWarning;
  const additionalCount = warnings.length - 1;
  return `${summary} · 안내: ${conciseWarning}${additionalCount > 0 ? ` 외 ${additionalCount}건` : ''}`;
}

export function renderPostControls(
  controls: PostControls,
  snapshot: PostSnapshot,
  state: PostControlState,
): void {
  const busy = state.requestPending || state.job?.state === 'starting' || state.job?.state === 'in_progress';
  for (const photo of snapshot.photos) {
    const button = controls.photoButtons.get(photo.key);
    if (!button) continue;
    button.disabled = Boolean(busy);
    const saved = state.savedPhotoKeys?.has(photo.key) ?? false;
    const label = mediaLabel(photo);
    button.setAttribute('aria-label', saved ? `이미 저장한 ${label} · 다시 저장` : `${label} 저장`);
    updateIcon(button, saved);
    const item = state.job?.items.find(candidate => candidate.photoKey === photo.key);
    button.title = item?.state === 'failed' && item.error
      ? `${label} 저장 실패: ${item.error}`
      : saved ? `이미 저장한 ${label} · 다시 저장` : `${label} 저장`;
  }

  if (controls.bulkButton) {
    const expected = snapshot.expectedPhotoCount;
    const totalIsKnownAndComplete = expected !== null
      && (expected >= 2 || !photoOnly(snapshot))
      && snapshot.completeness === 'complete'
      && expected === snapshot.photos.length;
    const savedCount = snapshot.photos.filter(media => state.savedPhotoKeys?.has(media.key)).length;
    const allSaved = totalIsKnownAndComplete && savedCount === expected;
    const label = bulkLabel(snapshot);
    const count = controls.bulkButton.querySelector<HTMLElement>('[data-x-download-count]');
    if (count) {
      count.textContent = expected !== null && expected >= 1 ? String(expected) : '…';
      count.hidden = expected === 1;
    }
    updateIcon(controls.bulkButton, allSaved);
    controls.bulkButton.setAttribute('aria-label', allSaved ? `모두 저장한 미디어 · ${label}` : label);
    controls.bulkButton.disabled = Boolean(busy) || !totalIsKnownAndComplete;
    controls.bulkButton.title = totalIsKnownAndComplete
      ? allSaved ? `모두 저장한 미디어 · ${label}` : savedCount > 0 ? `${savedCount}/${expected}개 저장함 · ${label}` : label
      : photoOnly(snapshot) ? '전체 사진 목록을 확인한 뒤 저장할 수 있어요.' : '전체 미디어의 MP4 주소를 확인하지 못했어요. 확인된 항목은 개별 저장할 수 있어요.';
  }

  if (state.error) {
    controls.status.hidden = false;
    controls.status.textContent = `${photoOnly(snapshot) ? '사진' : '미디어'} 저장을 시작하지 못했어요: ${state.error}`;
  } else if (state.requestPending) {
    controls.status.hidden = false;
    controls.status.textContent = '저장 요청을 보내고 있어요.';
  } else if (state.job && !(state.job.state === 'complete' && state.hideCompletedStatus)) {
    controls.status.hidden = false;
    controls.status.textContent = jobStatusText(state.job, snapshot);
  } else {
    controls.status.hidden = true;
    controls.status.textContent = '';
  }
}
