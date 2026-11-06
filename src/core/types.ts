/** Serializable contracts. No DOM objects or browser API types cross this boundary. */
export interface AppError {
  code: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
export type StaticImageExtension = 'jpg' | 'jpeg' | 'png' | 'webp' | 'avif';

export interface Settings {
  version: 1;
  subdirectory: string;
  grouping: 'none' | 'date' | 'author';
  filename: 'original' | 'post';
  originalSize: boolean;
}

/** Only static images are supported in this PoC; future media kinds can extend this union. */
export interface PhotoAsset {
  key: string;
  kind: 'image';
  index: number;
  originalFilename: string | null;
  extension: StaticImageExtension;
  displayedUrl: string;
  originalUrl: string | null;
}

export interface PostSnapshot {
  key: string;
  postId: string | null;
  authorHandle: string | null;
  photos: PhotoAsset[];
  expectedPhotoCount: number | null;
  completeness: 'complete' | 'partial' | 'unknown';
}

export type DownloadSelection = 'all' | { photoKeys: string[] };
export interface PlanningContext { now: Date }
export interface PathTarget { relativePath: string; warnings: string[] }

/** Transport input has no photo/video/GIF knowledge. */
export interface FileDownload {
  url: string;
  relativePath: string;
}

/** Static-image planning metadata stays outside the reusable file transport. */
export interface DownloadTask extends FileDownload {
  photoKey: string;
  index: number;
}

export interface DownloadPlan {
  postKey: string;
  createdAt: string;
  tasks: DownloadTask[];
  warnings: string[];
}

export interface TransportDownload {
  id: number;
  state: 'in_progress' | 'complete' | 'interrupted';
  error?: string;
  mime?: string;
}

export interface TransportChange {
  id: number;
  state?: TransportDownload['state'];
  error?: string;
}

/** Injected execution port: future video/GIF resolvers may produce tasks for the same transport. */
export interface DownloadTransport {
  start(file: FileDownload): Promise<number>;
  get(id: number): Promise<TransportDownload | null>;
}

export interface DownloadJobItem {
  photoKey: string;
  index: number;
  relativePath: string;
  downloadId: number | null;
  state: 'starting' | 'in_progress' | 'complete' | 'failed';
  error: string | null;
}

export interface DownloadJob {
  id: string;
  requestId: string;
  postKey: string;
  tabId: number;
  frameId: number;
  createdAt: string;
  updatedAt: string;
  state: 'starting' | 'in_progress' | 'complete' | 'partial' | 'failed';
  items: DownloadJobItem[];
  warnings: string[];
}

export interface DownloadStartRequest {
  type: 'download.start';
  requestId: string;
  post: PostSnapshot;
  selection: DownloadSelection;
}

export interface DownloadStatusRequest { type: 'download.getStatus'; jobId: string }
export type ExtensionRequest = DownloadStartRequest | DownloadStatusRequest;
export type ExtensionResponse = { ok: true; job: DownloadJob } | { ok: false; error: AppError };
export interface DownloadStatusMessage { type: 'download.status'; job: DownloadJob }
export interface SenderContext { tabId: number; frameId: number }
