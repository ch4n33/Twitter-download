import type {
  DownloadJob, DownloadStartRequest, DownloadStatusMessage, ExtensionRequest,
  ExtensionResponse, PhotoAsset, PostSnapshot,
} from '../core/types';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function nullableText(value: unknown, max: number): boolean {
  return value === null || text(value, max);
}
function isPhoto(value: unknown): value is PhotoAsset {
  if (!record(value)) return false;
  return value.kind === 'image' && text(value.key) && Number.isInteger(value.index)
    && Number(value.index) >= 1 && Number(value.index) <= 100
    && nullableText(value.originalFilename, 240)
    && ['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(String(value.extension))
    && text(value.displayedUrl, 8192) && nullableText(value.originalUrl, 8192);
}
function isPost(value: unknown): value is PostSnapshot {
  if (!record(value) || !text(value.key) || !nullableText(value.postId, 40)
    || !nullableText(value.authorHandle, 64) || !Array.isArray(value.photos)
    || value.photos.length < 1 || value.photos.length > 100 || !value.photos.every(isPhoto)
    || !['complete', 'partial', 'unknown'].includes(String(value.completeness))) return false;
  const total = value.expectedPhotoCount;
  if (total !== null && (!Number.isInteger(total) || Number(total) < 1 || Number(total) > 100)) return false;
  const keys = new Set(value.photos.map(photo => photo.key));
  const indices = new Set(value.photos.map(photo => photo.index));
  return keys.size === value.photos.length && indices.size === value.photos.length;
}

/** Runtime validation is required even though the application is TypeScript. */
export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (!record(value)) return false;
  if (value.type === 'download.getStatus') return text(value.jobId, 128);
  if (value.type !== 'download.start' || !text(value.requestId, 128) || !isPost(value.post)) return false;
  if (value.selection === 'all') return true;
  return record(value.selection) && Array.isArray(value.selection.photoKeys)
    && value.selection.photoKeys.length > 0 && value.selection.photoKeys.length <= 100
    && value.selection.photoKeys.every(key => text(key));
}

export function isDownloadStatusMessage(value: unknown): value is DownloadStatusMessage {
  if (!record(value) || value.type !== 'download.status' || !record(value.job)) return false;
  const job = value.job;
  return text(job.id, 128) && text(job.requestId, 128) && text(job.postKey)
    && Number.isInteger(job.tabId) && Number.isInteger(job.frameId)
    && text(job.createdAt, 80) && text(job.updatedAt, 80)
    && ['starting', 'in_progress', 'complete', 'partial', 'failed'].includes(String(job.state))
    && Array.isArray(job.warnings) && job.warnings.every(warning => typeof warning === 'string')
    && Array.isArray(job.items) && job.items.length > 0 && job.items.length <= 100
    && job.items.every(item => record(item) && text(item.photoKey) && Number.isInteger(item.index)
      && text(item.relativePath) && (item.downloadId === null || Number.isInteger(item.downloadId))
      && ['starting', 'in_progress', 'complete', 'failed'].includes(String(item.state))
      && (item.error === null || typeof item.error === 'string'));
}

export function sendDownloadRequest(request: DownloadStartRequest): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage(request) as Promise<ExtensionResponse>;
}

export function getDownloadStatus(jobId: string): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage({ type: 'download.getStatus', jobId }) as Promise<ExtensionResponse>;
}

export function subscribeDownloadStatus(listener: (job: DownloadJob) => void): () => void {
  const callback = (message: unknown) => {
    if (isDownloadStatusMessage(message)) listener(message.job);
  };
  chrome.runtime.onMessage.addListener(callback);
  return () => chrome.runtime.onMessage.removeListener(callback);
}
