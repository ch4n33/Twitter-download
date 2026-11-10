/** Shared limits and message contracts for the offscreen page and GIF worker. */
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 120_000;
export const MAX_DURATION_SECONDS = 60;
export const MAX_FRAME_PIXELS = 4_194_304;
export const MAX_TOTAL_PIXELS = 300_000_000;
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const CONVERSION_TIMEOUT_MS = 120_000;

export interface GifWorkerConvertMessage {
  type: 'convert';
  id: string;
  input: ArrayBuffer;
}

export interface GifWorkerProgressMessage {
  type: 'progress';
  id: string;
  progress: number;
}

export interface GifWorkerCompleteMessage {
  type: 'complete';
  id: string;
  buffer: ArrayBuffer;
}

export interface GifWorkerErrorMessage {
  type: 'error';
  id: string;
  error: string;
}

export type GifWorkerResponseMessage =
  | GifWorkerProgressMessage
  | GifWorkerCompleteMessage
  | GifWorkerErrorMessage;

export type GifOffscreenCommand =
  | { target: 'gif-offscreen'; type: 'gif.prepare'; id: string; url: string }
  | { target: 'gif-offscreen'; type: 'gif.status'; id: string }
  | { target: 'gif-offscreen'; type: 'gif.release'; id: string }
  | { target: 'gif-offscreen'; type: 'gif.isIdle' };

export type GifOffscreenState = 'missing' | 'queued' | 'running' | 'complete' | 'failed';

export interface GifOffscreenStatus {
  state: GifOffscreenState;
  progress: number;
  url?: string;
  error?: string;
}

export type GifBackgroundEvent =
  | { target: 'gif-background'; type: 'gif.progress'; id: string; progress: number }
  | { target: 'gif-background'; type: 'gif.complete'; id: string; url: string }
  | { target: 'gif-background'; type: 'gif.error'; id: string; error: string }
  | { target: 'gif-background'; type: 'gif.close-if-idle' };

export interface PreparedGif {
  url: string;
}

/**
 * Background-side port. The reconnect operation must inspect existing
 * offscreen state and must never start a conversion from a persisted source URL.
 */
export interface GifConverter {
  prepare(id: string, url: string, onProgress: (percent: number) => void): Promise<PreparedGif>;
  reconnect(id: string, onProgress: (percent: number) => void): Promise<PreparedGif>;
  release(id: string): Promise<void>;
}
