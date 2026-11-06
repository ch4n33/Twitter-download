import type { DownloadJob, PostSnapshot } from '../core/types';

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
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function makeDownloadIcon(document: Document, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', 'M12 3v12m0 0 4-4m-4 4-4-4M5 17v3h14v-3');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
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
    button.append(makeDownloadIcon(document, 16));
    button.setAttribute('aria-label', `사진 ${photo.index} 저장`);
    button.title = `사진 ${photo.index} 저장`;
    addClickGuard(button, event => handlers.onSavePhoto(photo.key, event), cleanup);
    mount.append(button);
    photoButtons.set(photo.key, button);
  }

  const expected = snapshot.expectedPhotoCount;
  const shouldShowBulk = expected !== null
    ? expected >= 2 || snapshot.photos.length > 1
    : snapshot.photos.length > 1;
  let bulkButton: HTMLButtonElement | null = null;
  if (shouldShowBulk && mounts.bulkMount) {
    const knownMultiPhotoTotal = expected !== null && expected >= 2;
    const buttonLabel = knownMultiPhotoTotal ? `${expected}장 모두 저장` : '전체 사진 수 확인 중';
    bulkButton = makeButton(document, 'bulk');
    bulkButton.append(makeDownloadIcon(document, 18));
    const count = document.createElement('span');
    count.className = 'x-download-bulk-count';
    count.setAttribute('data-x-download-count', '');
    count.textContent = knownMultiPhotoTotal ? String(expected) : '…';
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

function jobStatusText(job: DownloadJob): string {
  const total = job.items.length;
  const complete = job.items.filter(item => item.state === 'complete').length;
  const failedItems = job.items.filter(item => item.state === 'failed');
  const failed = failedItems.length;
  const firstError = failedItems.find(item => item.error)?.error;
  let summary: string;
  if (job.state === 'starting') {
    summary = failed > 0
      ? `저장 요청 중: ${complete}장 완료, ${failed}장 실패${firstError ? ` — ${firstError}` : ''}`
      : '저장 요청을 준비하고 있어요.';
  } else if (job.state === 'in_progress') {
    summary = `사진 저장 중: ${complete + failed}/${total}장 처리${failed > 0 ? `, ${failed}장 실패` : ''}${firstError ? ` — ${firstError}` : ''}`;
  } else if (job.state === 'complete') {
    summary = `사진 저장 완료 (${complete}/${total}장)`;
  } else if (job.state === 'partial') {
    summary = `일부 사진 저장 실패 (${complete}장 완료, ${failed}장 실패)${firstError ? ` — ${firstError}` : ''}`;
  } else {
    summary = `사진 저장 실패${firstError ? ` — ${firstError}` : ''}`;
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
    button.setAttribute('aria-label', `사진 ${photo.index} 저장`);
    const item = state.job?.items.find(candidate => candidate.photoKey === photo.key);
    button.title = item?.state === 'failed' && item.error
      ? `사진 ${photo.index} 저장 실패: ${item.error}`
      : item?.state === 'complete' ? `사진 ${photo.index} 저장 완료` : `사진 ${photo.index} 저장`;
  }

  if (controls.bulkButton) {
    const expected = snapshot.expectedPhotoCount;
    const totalIsKnownAndComplete = expected !== null
      && expected >= 2
      && snapshot.completeness === 'complete'
      && expected === snapshot.photos.length;
    const label = expected !== null && expected >= 2
      ? `${expected}장 모두 저장`
      : '전체 사진 수 확인 중';
    const count = controls.bulkButton.querySelector<HTMLElement>('[data-x-download-count]');
    if (count) count.textContent = expected !== null && expected >= 2 ? String(expected) : '…';
    controls.bulkButton.setAttribute('aria-label', label);
    controls.bulkButton.disabled = Boolean(busy) || !totalIsKnownAndComplete;
    controls.bulkButton.title = totalIsKnownAndComplete ? label : '전체 사진 목록을 확인한 뒤 저장할 수 있어요.';
  }

  if (state.error) {
    controls.status.hidden = false;
    controls.status.textContent = `사진 저장을 시작하지 못했어요: ${state.error}`;
  } else if (state.requestPending) {
    controls.status.hidden = false;
    controls.status.textContent = '저장 요청을 보내고 있어요.';
  } else if (state.job) {
    controls.status.hidden = false;
    controls.status.textContent = jobStatusText(state.job);
  } else {
    controls.status.hidden = true;
    controls.status.textContent = '';
  }
}
