import { convertMp4ToGif } from "./mp4-to-gif";
import type { GifWorkerConvertMessage, GifWorkerResponseMessage } from "./protocol";

type GifWorkerScope = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: GifWorkerResponseMessage, transfer?: Transferable[]): void;
};

const workerScope = globalThis as unknown as GifWorkerScope;
let converting = false;

workerScope.onmessage = event => {
  const request = parseConvertRequest(event.data);
  if (!request) return;

  if (converting) {
    postError(request.id, "This conversion worker is already processing an MP4.");
    return;
  }

  converting = true;
  void convertMp4ToGif(request.input, progress => {
    workerScope.postMessage({ type: "progress", id: request.id, progress });
  })
    .then(bytes => {
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      workerScope.postMessage({ type: "complete", id: request.id, buffer }, [buffer]);
    })
    .catch(error => {
      postError(request.id, error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      converting = false;
    });
};

function parseConvertRequest(value: unknown): GifWorkerConvertMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<GifWorkerConvertMessage>;
  if (
    candidate.type !== "convert" ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    !(candidate.input instanceof ArrayBuffer)
  ) {
    return undefined;
  }
  return candidate as GifWorkerConvertMessage;
}

function postError(id: string, error: string): void {
  workerScope.postMessage({ type: "error", id, error });
}
