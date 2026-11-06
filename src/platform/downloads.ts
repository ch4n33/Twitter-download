import type {
  DownloadTransport,
  FileDownload,
  TransportChange,
  TransportDownload,
} from '../core/types';

type NativeDownloadState = TransportDownload['state'];

interface NativeDownloadItem {
  id: number;
  state: string;
  error?: string;
  mime?: string;
}

interface NativeDownloadDelta {
  id: number;
  state?: { current?: string };
  error?: { current?: string };
}

interface DownloadsApi {
  download(options: {
    url: string;
    filename: string;
    conflictAction: 'uniquify';
    saveAs: false;
  }): Promise<number>;
  search(query: { id: number }): Promise<NativeDownloadItem[]>;
  onChanged: {
    addListener(listener: (delta: NativeDownloadDelta) => void): void;
    removeListener(listener: (delta: NativeDownloadDelta) => void): void;
  };
}

export interface DownloadTransportWithEvents extends DownloadTransport {
  subscribe(listener: (change: TransportChange) => void): () => void;
}

function isNativeState(value: string): value is NativeDownloadState {
  return value === 'in_progress' || value === 'complete' || value === 'interrupted';
}

function mapItem(item: NativeDownloadItem): TransportDownload | null {
  if (!Number.isInteger(item.id) || !isNativeState(item.state)) return null;
  return {
    id: item.id,
    state: item.state,
    ...(typeof item.error === 'string' ? { error: item.error } : {}),
    ...(typeof item.mime === 'string' ? { mime: item.mime } : {}),
  };
}

/**
 * Thin Chrome Downloads API adapter. It has no DOM or X-specific knowledge, so
 * a future resolver can submit any prepared file through the same port.
 */
export function createChromeDownloadsTransport(api: DownloadsApi): DownloadTransportWithEvents {
  const listeners = new Map<(change: TransportChange) => void, (delta: NativeDownloadDelta) => void>();

  return {
    async start(task: FileDownload): Promise<number> {
      return api.download({
        url: task.url,
        filename: task.relativePath,
        conflictAction: 'uniquify',
        saveAs: false,
      });
    },

    async get(id: number): Promise<TransportDownload | null> {
      const [item] = await api.search({ id });
      return item ? mapItem(item) : null;
    },

    subscribe(listener: (change: TransportChange) => void): () => void {
      const nativeListener = (delta: NativeDownloadDelta) => {
        if (!Number.isInteger(delta.id)) return;
        const state = delta.state?.current;
        listener({
          id: delta.id,
          ...(typeof state === 'string' && isNativeState(state) ? { state } : {}),
          ...(typeof delta.error?.current === 'string' ? { error: delta.error.current } : {}),
        });
      };
      listeners.set(listener, nativeListener);
      api.onChanged.addListener(nativeListener);
      return () => {
        const registered = listeners.get(listener);
        if (!registered) return;
        listeners.delete(listener);
        api.onChanged.removeListener(registered);
      };
    },
  };
}
