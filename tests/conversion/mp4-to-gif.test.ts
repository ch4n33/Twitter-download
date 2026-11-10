import { describe, expect, it } from "vitest";
import { GIFEncoder } from "gifenc";
import type { Track } from "mp4box";
import {
  MAX_INPUT_BYTES,
  buildVideoDecoderConfig,
  convertMp4ToGif,
  quantizeDurationsToCentiseconds,
  writeRgbaFrameToGif,
} from "../../src/conversion/mp4-to-gif";

describe("convertMp4ToGif validation", () => {
  it("rejects MP4 inputs over the memory limit before parsing", async () => {
    await expect(convertMp4ToGif(new ArrayBuffer(MAX_INPUT_BYTES + 1)))
      .rejects.toThrow(/larger than 32 MiB/);
  });

  it("rejects malformed input that has no MP4 movie metadata", async () => {
    await expect(convertMp4ToGif(new ArrayBuffer(12)))
      .rejects.toThrow(/MP4/);
  });

  it("rejects AVC sample entries with no decoder configuration", () => {
    const track = {
      codec: "avc1.64001e",
      video: { width: 640, height: 360 },
    } as unknown as Track;

    expect(() => buildVideoDecoderConfig(track, { type: "avc1" }))
      .toThrow(/avcC decoder configuration/);
  });
});

describe("GIF timing and encoding", () => {
  it("rounds cumulative frame timing to centiseconds", () => {
    expect(quantizeDurationsToCentiseconds([6_000, 6_000, 6_000]))
      .toEqual([1, 0, 1]);
  });

  it("writes GIF89a, infinite-loop metadata, and a trailer for multiple frames", () => {
    const encoder = GIFEncoder();
    const firstFrame = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const secondFrame = new Uint8ClampedArray([
      0, 0, 0, 255, 255, 255, 0, 255,
      255, 0, 255, 255, 0, 255, 255, 255,
    ]);

    writeRgbaFrameToGif(encoder, firstFrame, 2, 2, 2, true);
    writeRgbaFrameToGif(encoder, secondFrame, 2, 2, 3, false);
    encoder.finish();
    const bytes = encoder.bytes();
    const text = new TextDecoder().decode(bytes);

    expect(text.slice(0, 6)).toBe("GIF89a");
    expect(text).toContain("NETSCAPE2.0");
    expect(bytes.at(-1)).toBe(0x3b);
  });
});
