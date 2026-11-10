import { DataStream, createFile } from "mp4box";
import type { Movie, Sample, Track } from "mp4box";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import {
  CONVERSION_TIMEOUT_MS,
  MAX_DURATION_SECONDS,
  MAX_FRAME_PIXELS,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_TOTAL_PIXELS,
} from "./protocol";

export {
  MAX_DURATION_SECONDS,
  MAX_INPUT_BYTES,
  MAX_TOTAL_PIXELS,
  MAX_OUTPUT_BYTES,
};
export { MAX_FRAME_PIXELS as MAX_PIXELS_PER_FRAME } from "./protocol";
export { CONVERSION_TIMEOUT_MS as MAX_CONVERSION_MS } from "./protocol";

const MAX_DECODER_QUEUE_SIZE = 4;
const RESUME_DECODER_QUEUE_SIZE = 1;
const MICROSECONDS_PER_SECOND = 1_000_000;
const MICROSECONDS_PER_CENTISECOND = 10_000;
const ORIGINAL_MP4_ADVICE = "Turn off GIF format saving to save the MP4 instead.";

type WebCodecsConfig = {
  codec: string;
  codedWidth?: number;
  codedHeight?: number;
  description?: Uint8Array;
};

type DecodedVideoFrame = {
  timestamp: number;
  duration: number | null;
  displayWidth: number;
  displayHeight: number;
  codedWidth: number;
  codedHeight: number;
  close(): void;
};

type VideoDecoderLike = {
  decodeQueueSize: number;
  ondequeue: (() => void) | null;
  configure(config: WebCodecsConfig): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
};

type VideoDecoderConstructor = {
  new (init: {
    output(frame: DecodedVideoFrame): void;
    error(error: Error): void;
  }): VideoDecoderLike;
  isConfigSupported(config: WebCodecsConfig): Promise<{
    supported: boolean;
    config: WebCodecsConfig;
  }>;
};

type EncodedVideoChunkConstructor = new (init: {
  type: "key" | "delta";
  timestamp: number;
  duration?: number;
  data: Uint8Array;
}) => unknown;

type VideoSampleDescription = {
  type?: string;
  avcC?: unknown;
  hvcC?: unknown;
  av1C?: {
    version: number;
    seq_profile: number;
    seq_level_idx_0: number;
    seq_tier_0: number;
    high_bitdepth: number;
    twelve_bit: number;
    monochrome: number;
    chroma_subsampling_x: number;
    chroma_subsampling_y: number;
    chroma_sample_position: number;
    initial_presentation_delay_present: number;
    initial_presentation_delay_minus_one: number;
    configOBUs: Uint8Array;
  };
};

type PendingFrame = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  timestampUs: number;
  durationUs: number | null;
};

type MP4BoxBuffer = ArrayBuffer & { fileStart: number };

/**
 * Converts every decoded video sample to an animated GIF in the current worker.
 * Input and output are kept in memory; the explicit limits keep that work bounded.
 */
export async function convertMp4ToGif(
  input: ArrayBuffer,
  onProgress?: (percent: number) => void,
): Promise<Uint8Array> {
  if (!(input instanceof ArrayBuffer) || input.byteLength === 0) {
    throw new Error("The selected file is empty or is not an MP4 file.");
  }
  if (input.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`This MP4 is larger than 32 MiB. ${ORIGINAL_MP4_ADVICE}`);
  }

  const webCodecs = globalThis as unknown as {
    VideoDecoder?: VideoDecoderConstructor;
    EncodedVideoChunk?: EncodedVideoChunkConstructor;
  };

  return await new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    let pausedForBackpressure = false;
    let finishing = false;
    let decoder: VideoDecoderLike | undefined;
    let file: ReturnType<typeof createFile> | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let currentTrack: Track | undefined;
    let totalSamples = 0;
    let decodedSamples = 0;
    let decodedFrames = 0;
    let expectedVideoEndUs: number | undefined;
    let gif: ReturnType<typeof GIFEncoder> | undefined;
    let pendingFrame: PendingFrame | undefined;
    let canvas: OffscreenCanvas | undefined;
    let canvasContext: OffscreenCanvasRenderingContext2D | undefined;
    let outputWidth = 0;
    let outputHeight = 0;
    let totalDecodedPixels = 0;
    const quantizeNextDelay = createCentisecondQuantizer();

    const cleanup = () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      file?.stop();
      try {
        decoder?.close();
      } catch {
        // Closing a decoder that already failed is harmless.
      }
    };

    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };

    const succeed = (bytes: Uint8Array) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        onProgress?.(100);
      } catch {
        // Progress reporting must not invalidate an otherwise complete GIF.
      }
      resolve(bytes);
    };

    const reportProgress = (percent: number) => {
      if (settled || !onProgress) return;
      try {
        onProgress(Math.max(0, Math.min(99, Math.floor(percent))));
      } catch (error) {
        fail(error);
      }
    };

    const timeoutMessage = `GIF conversion exceeded ${Math.round(CONVERSION_TIMEOUT_MS / 1000)} seconds. ${ORIGINAL_MP4_ADVICE}`;
    timeoutHandle = setTimeout(() => fail(new Error(timeoutMessage)), CONVERSION_TIMEOUT_MS);

    const writePendingFrame = (frame: PendingFrame, durationUs: number) => {
      if (!gif) gif = GIFEncoder({ initialCapacity: 4096 });
      const delayCs = quantizeNextDelay(durationUs);
      writeRgbaFrameToGif(gif, frame.rgba, frame.width, frame.height, delayCs, gif.bytesView().length === 0);
      if (gif.bytesView().byteLength > MAX_OUTPUT_BYTES) {
        throw new Error(`The GIF would be larger than 64 MiB. ${ORIGINAL_MP4_ADVICE}`);
      }
    };

    const onDecodedFrame = (frame: DecodedVideoFrame) => {
      try {
        if (settled) return;
        decodedFrames += 1;
        if (decodedFrames > totalSamples) {
          throw new Error("The MP4 decoder produced an unexpected number of frames; conversion stopped to avoid changing the video.");
        }

        const width = frame.displayWidth || frame.codedWidth;
        const height = frame.displayHeight || frame.codedHeight;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
          throw new Error("The MP4 contains invalid video frame dimensions.");
        }
        const framePixels = width * height;
        if (framePixels > MAX_FRAME_PIXELS) {
          throw new Error(`This MP4 frame is larger than the GIF conversion limit. ${ORIGINAL_MP4_ADVICE}`);
        }
        totalDecodedPixels += framePixels;
        if (totalDecodedPixels > MAX_TOTAL_PIXELS) {
          throw new Error(`This MP4 has too many video pixels to convert. ${ORIGINAL_MP4_ADVICE}`);
        }

        if (outputWidth === 0) {
          if (width > 65_535 || height > 65_535) {
            throw new Error(`GIF cannot represent this MP4 frame size. ${ORIGINAL_MP4_ADVICE}`);
          }
          outputWidth = width;
          outputHeight = height;
          canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("Could not create the canvas needed to convert MP4 frames.");
          canvasContext = context;
        } else if (width !== outputWidth || height !== outputHeight) {
          throw new Error("The MP4 changes frame dimensions during playback; conversion stopped to preserve the original frames.");
        }

        if (pendingFrame && frame.timestamp < pendingFrame.timestampUs) {
          throw new Error("The MP4 decoder returned frames out of presentation order; conversion stopped to preserve timing.");
        }

        canvasContext!.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height);
        const imageData = canvasContext!.getImageData(0, 0, width, height);
        const nextFrame: PendingFrame = {
          rgba: imageData.data,
          width,
          height,
          timestampUs: frame.timestamp,
          durationUs: frame.duration,
        };

        if (pendingFrame) {
          writePendingFrame(nextFrameFromPending(pendingFrame), frame.timestamp - pendingFrame.timestampUs);
        }
        pendingFrame = nextFrame;
      } catch (error) {
        fail(error);
      } finally {
        try {
          frame.close();
        } catch {
          // A frame may already be closed by the browser after a decoder error.
        }
      }
    };

    const nextFrameFromPending = (frame: PendingFrame): PendingFrame => frame;

    const finishDecoding = () => {
      if (settled || finishing || decodedSamples < totalSamples || !decoder) return;
      finishing = true;
      file?.stop();
      void decoder
        .flush()
        .then(() => {
          if (settled) return;
          if (decodedFrames !== decodedSamples) {
            throw new Error("Some MP4 video frames could not be decoded. Conversion stopped to avoid dropping frames.");
          }
          if (!pendingFrame) throw new Error("The MP4 contains no decodable video frames.");

          let finalDurationUs =
            expectedVideoEndUs === undefined
              ? 0
              : expectedVideoEndUs - pendingFrame.timestampUs;
          if (!(finalDurationUs > 0) && pendingFrame.durationUs !== null) {
            finalDurationUs = pendingFrame.durationUs;
          }
          if (!(finalDurationUs > 0)) {
            throw new Error("The MP4 does not contain a valid duration for its last video frame.");
          }

          writePendingFrame(pendingFrame, finalDurationUs);
          gif!.finish();
          const output = gif!.bytes();
          if (output.byteLength > MAX_OUTPUT_BYTES) {
            throw new Error(`The GIF would be larger than 64 MiB. ${ORIGINAL_MP4_ADVICE}`);
          }
          succeed(output);
        })
        .catch(fail);
    };

    const startExtraction = async (movie: Movie) => {
      const track = movie.videoTracks[0];
      if (!track) throw new Error("This MP4 does not contain a video track.");
      currentTrack = track;

      const samples = file!.getTrackSamplesInfo(track.id) ?? [];
      totalSamples = samples.length || track.nb_samples;
      if (!Number.isSafeInteger(totalSamples) || totalSamples <= 0) {
        throw new Error("The MP4 video track contains no decodable frames.");
      }

      const timescale = track.timescale;
      if (!Number.isFinite(timescale) || timescale <= 0) {
        throw new Error("The MP4 video track has invalid timing information.");
      }

      const sampleEndpoints = samples
        .filter(sample => Number.isFinite(sample.cts) && Number.isFinite(sample.duration))
        .map(sample => ({ start: sample.cts, end: sample.cts + sample.duration }));
      if (sampleEndpoints.length > 0) {
        const firstPresentationTick = Math.min(...sampleEndpoints.map(sample => sample.start));
        const finalPresentationTick = Math.max(...sampleEndpoints.map(sample => sample.end));
        expectedVideoEndUs = Math.round((finalPresentationTick * MICROSECONDS_PER_SECOND) / timescale);
        const sampleDurationSeconds = (finalPresentationTick - firstPresentationTick) / timescale;
        if (sampleDurationSeconds > MAX_DURATION_SECONDS) {
          throw new Error(`This MP4 is longer than ${MAX_DURATION_SECONDS} seconds. ${ORIGINAL_MP4_ADVICE}`);
        }
      }

      const metadataDurations = [
        track.samples_duration / timescale,
        track.duration / timescale,
        track.movie_timescale > 0 ? track.movie_duration / track.movie_timescale : 0,
      ].filter(value => Number.isFinite(value) && value > 0 && value < 0xffff_ffff);
      const metadataDuration = Math.max(0, ...metadataDurations);
      if (metadataDuration > MAX_DURATION_SECONDS) {
        throw new Error(`This MP4 is longer than ${MAX_DURATION_SECONDS} seconds. ${ORIGINAL_MP4_ADVICE}`);
      }

      const width = track.video?.width ?? 0;
      const height = track.video?.height ?? 0;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        throw new Error("The MP4 video track has invalid frame dimensions.");
      }
      const framePixels = width * height;
      if (framePixels > MAX_FRAME_PIXELS) {
        throw new Error(`This MP4 frame is larger than the GIF conversion limit. ${ORIGINAL_MP4_ADVICE}`);
      }
      if (framePixels * totalSamples > MAX_TOTAL_PIXELS) {
        throw new Error(`This MP4 has too many video pixels to convert. ${ORIGINAL_MP4_ADVICE}`);
      }

      const firstSample = samples[0];
      const config = buildVideoDecoderConfig(track, firstSample?.description);
      if (typeof OffscreenCanvas === "undefined") {
        throw new Error("This browser does not provide OffscreenCanvas for GIF conversion.");
      }
      const VideoDecoder = webCodecs.VideoDecoder;
      const EncodedVideoChunk = webCodecs.EncodedVideoChunk;
      if (!VideoDecoder || !EncodedVideoChunk) {
        throw new Error("This browser does not provide WebCodecs video decoding for MP4 conversion.");
      }
      const supported = await VideoDecoder.isConfigSupported(config);
      if (!supported.supported) {
        throw new Error(`This browser cannot decode the MP4 video codec ${track.codec} with WebCodecs.`);
      }

      reportProgress(0);
      const activeDecoder = new VideoDecoder({
        output: onDecodedFrame,
        error: error => fail(new Error(`MP4 video decoding failed: ${error.message}`)),
      });
      decoder = activeDecoder;
      activeDecoder.ondequeue = () => {
        if (settled || !pausedForBackpressure) return;
        if (activeDecoder.decodeQueueSize <= RESUME_DECODER_QUEUE_SIZE) {
          pausedForBackpressure = false;
          queueMicrotask(() => {
            if (!settled && !finishing) file?.start();
          });
        }
      };
      activeDecoder.configure(supported.config);

      file!.onSamples = (id, _user, extractedSamples) => {
        if (settled || id !== track.id || !decoder) return;
        try {
          for (const sample of extractedSamples) {
            const data = sample.data;
            if (!data || data.byteLength === 0) {
              throw new Error("The MP4 video sample is missing encoded data.");
            }
            if (sample.description_index !== firstSample?.description_index) {
              throw new Error("The MP4 changes video codec configuration during playback, which this browser cannot safely convert.");
            }
            const sampleTimescale = sample.timescale || timescale;
            const timestamp = Math.round((sample.cts * MICROSECONDS_PER_SECOND) / sampleTimescale);
            const duration = Math.round((sample.duration * MICROSECONDS_PER_SECOND) / sampleTimescale);
            decoder.decode(
              new EncodedVideoChunk({
                type: sample.is_sync ? "key" : "delta",
                timestamp,
                duration: duration >= 0 ? duration : undefined,
                data,
              }),
            );
            decodedSamples += 1;
            file!.releaseUsedSamples(track.id, sample.number + 1);
            reportProgress((decodedSamples / totalSamples) * 99);

            if (decoder.decodeQueueSize >= MAX_DECODER_QUEUE_SIZE && decodedSamples < totalSamples) {
              file!.stop();
              pausedForBackpressure = true;
              break;
            }
          }
          finishDecoding();
        } catch (error) {
          fail(error);
        }
      };

      file!.setExtractionOptions(track.id, undefined, { nbSamples: 1 });
      file!.start();
      if (decodedSamples === 0 && !pausedForBackpressure && totalSamples > 0) {
        throw new Error("The MP4 video samples could not be read.");
      }
    };

    file = createFile(true);
    file.onError = (_module, message) => fail(new Error(`Could not parse this MP4 file: ${message}`));
    file.onReady = movie => {
      void startExtraction(movie).catch(fail);
    };

    try {
      const inputWithOffset = input as MP4BoxBuffer;
      Object.defineProperty(inputWithOffset, "fileStart", {
        configurable: true,
        value: 0,
      });
      file.appendBuffer(inputWithOffset);
      file.flush();
      if (!file.readySent) {
        fail(new Error("This file could not be read as a valid MP4."));
      }
    } catch (error) {
      fail(new Error(`Could not parse this MP4 file: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

/** Converts cumulative microsecond durations to GIF centiseconds without losing accumulated time. */
export function quantizeDurationsToCentiseconds(durationsUs: readonly number[]): number[] {
  const quantizeNext = createCentisecondQuantizer();
  return durationsUs.map(quantizeNext);
}

function createCentisecondQuantizer(): (durationUs: number) => number {
  let accumulatedUs = 0;
  let previousRoundedCs = 0;
  return durationUs => {
    if (!Number.isFinite(durationUs) || durationUs < 0) {
      throw new Error("Frame durations must be finite, non-negative microseconds.");
    }
    accumulatedUs += durationUs;
    const roundedCs = Math.round(accumulatedUs / MICROSECONDS_PER_CENTISECOND);
    const delayCs = roundedCs - previousRoundedCs;
    previousRoundedCs = roundedCs;
    return delayCs;
  };
}

/** Encodes one RGBA frame, using gifenc's standard per-frame palette quantization. */
export function writeRgbaFrameToGif(
  encoder: ReturnType<typeof GIFEncoder>,
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  delayCentiseconds: number,
  firstFrame: boolean,
): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("GIF frame dimensions must be positive whole numbers.");
  }
  if (width > 65_535 || height > 65_535) {
    throw new Error("GIF frame dimensions cannot exceed 65,535 pixels per side.");
  }
  if (!Number.isSafeInteger(delayCentiseconds) || delayCentiseconds < 0 || delayCentiseconds > 65_535) {
    throw new Error("GIF frame timing exceeds the format limit.");
  }
  if (rgba.byteLength !== width * height * 4) {
    throw new Error("GIF frame pixel data does not match its dimensions.");
  }

  const palette = quantize(rgba, 256);
  const indexedPixels = applyPalette(rgba, palette);
  encoder.writeFrame(indexedPixels, width, height, {
    delay: delayCentiseconds * 10,
    palette,
    ...(firstFrame ? { repeat: 0 } : {}),
  });
}

/** Creates the decoder configuration from the MP4 sample entry's codec record. */
export function buildVideoDecoderConfig(
  track: Track,
  rawDescription: unknown,
): WebCodecsConfig {
  const description = rawDescription as VideoSampleDescription | undefined;
  const codecPrefix = track.codec.split(".")[0]?.toLowerCase() ?? "";
  const config: WebCodecsConfig = {
    codec: track.codec,
    ...(track.video?.width ? { codedWidth: track.video.width } : {}),
    ...(track.video?.height ? { codedHeight: track.video.height } : {}),
  };

  if (["avc1", "avc2", "avc3", "avc4"].includes(codecPrefix)) {
    if (!description?.avcC) {
      throw new Error(`The MP4 ${track.codec} video track does not contain the avcC decoder configuration required by WebCodecs.`);
    }
    config.description = serializeCodecBox(description.avcC);
  } else if (["hvc1", "hvc2", "hev1", "hev2"].includes(codecPrefix)) {
    if (!description?.hvcC) {
      throw new Error(`The MP4 ${track.codec} video track does not contain the hvcC decoder configuration required by WebCodecs.`);
    }
    config.description = serializeCodecBox(description.hvcC);
  } else if (codecPrefix === "av01") {
    if (!description?.av1C) {
      throw new Error(`The MP4 ${track.codec} video track does not contain the av1C decoder configuration required by WebCodecs.`);
    }
    config.description = serializeAv1Configuration(description.av1C);
  } else if (!["vp08", "vp09"].includes(codecPrefix)) {
    throw new Error(`The MP4 video codec ${track.codec || "(unknown)"} is not supported for GIF conversion.`);
  }

  return config;
}

function serializeCodecBox(box: unknown): Uint8Array {
  const writable = box as { write?: (stream: DataStream) => void };
  if (typeof writable?.write !== "function") {
    throw new Error("The MP4 codec configuration could not be read for WebCodecs.");
  }
  const stream = new DataStream(0);
  writable.write.call(box, stream);
  const record = new Uint8Array(stream.buffer, 0, stream.getPosition());
  if (record.byteLength < 8) {
    throw new Error("The MP4 codec configuration is incomplete.");
  }
  return record.slice(8);
}

function serializeAv1Configuration(config: NonNullable<VideoSampleDescription["av1C"]>): Uint8Array {
  if (!Number.isInteger(config.version) || config.version !== 1 || !config.configOBUs) {
    throw new Error("The MP4 av1C decoder configuration is incomplete.");
  }
  const record = new Uint8Array(4 + config.configOBUs.byteLength);
  record[0] = 0x80 | (config.version & 0x7f);
  record[1] = ((config.seq_profile & 0x7) << 5) | (config.seq_level_idx_0 & 0x1f);
  record[2] =
    ((config.seq_tier_0 & 0x1) << 7) |
    ((config.high_bitdepth & 0x1) << 6) |
    ((config.twelve_bit & 0x1) << 5) |
    ((config.monochrome & 0x1) << 4) |
    ((config.chroma_subsampling_x & 0x1) << 3) |
    ((config.chroma_subsampling_y & 0x1) << 2) |
    (config.chroma_sample_position & 0x3);
  record[3] = config.initial_presentation_delay_present
    ? 0x10 | (config.initial_presentation_delay_minus_one & 0xf)
    : 0;
  record.set(config.configOBUs, 4);
  return record;
}
