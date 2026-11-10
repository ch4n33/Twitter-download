declare module "gifenc" {
  export type Palette = Array<[number, number, number] | [number, number, number, number]>;

  export interface GIFEncoderOptions {
    auto?: boolean;
    initialCapacity?: number;
  }

  export interface GIFEncoderInstance {
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    finish(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: {
        delay?: number;
        palette?: Palette;
        repeat?: number;
      },
    ): void;
  }

  export function GIFEncoder(options?: GIFEncoderOptions): GIFEncoderInstance;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
  ): Palette;
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
  ): Uint8Array;
}
