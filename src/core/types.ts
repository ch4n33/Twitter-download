/** Serializable contracts. No DOM objects or browser API types cross this boundary. */
export interface AppError {
  code: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
export type StaticImageExtension = 'jpg' | 'jpeg' | 'png' | 'webp' | 'avif';
export type MediaKind = 'image' | 'video' | 'animated_gif';
export type MediaExtension = StaticImageExtension | 'mp4';
export type OutputFormat = MediaExtension | 'gif';

export interface Settings {
  version: 1;
  subdirectory: string;
  grouping: 'none' | 'date' | 'author';
  filename: 'original' | 'post';
  originalSize: boolean;
  saveGifAsGif: boolean;
}

/** The legacy `photos` field carries all downloadable attachments for compatibility. */
export interface MediaAsset {
  key: string;
  kind: MediaKind;
  index: number;
  originalFilename: string | null;
  extension: MediaExtension;
  displayedUrl: string;
  originalUrl: string | null;
}

/** Legacy name retained for existing consumers of the photo-oriented contracts. */
export type PhotoAsset = MediaAsset;

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
  kind: MediaKind;
  extension: MediaExtension;
  /** Output can differ from the MP4 source for animated GIF attachments. */
  outputFormat?: OutputFormat;
  transform?: 'mp4-to-gif';
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
  /** Missing only on jobs persisted by older versions; recovery treats those as images. */
  expectedKind?: MediaKind;
  outputFormat?: OutputFormat;
  relativePath: string;
  downloadId: number | null;
  state: 'starting' | 'converting' | 'in_progress' | 'complete' | 'failed';
  /** Conversion progress from 0 to 100, absent for ordinary downloads. */
  progress?: number;
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
