import type { MediaAsset, OutputFormat, Settings } from './types';

/** The input identity stays MP4 even when an animated GIF is re-encoded. */
export function outputFormatFor(asset: MediaAsset, settings: Settings): OutputFormat {
  return asset.kind === 'animated_gif' && settings.saveGifAsGif ? 'gif' : asset.extension;
}
