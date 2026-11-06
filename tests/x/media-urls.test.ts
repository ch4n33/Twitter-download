import { describe, expect, it } from 'vitest';
import { getStaticImageUrlInfo, isAllowedImageUrl } from '../../src/x/media-urls';

describe('X static image URLs', () => {
  it.each(['jpg', 'jpeg', 'png', 'webp', 'avif'])('accepts a directly hosted %s image', extension => {
    expect(isAllowedImageUrl(`https://pbs.twimg.com/media/SampleAsset.${extension}?format=${extension}&name=small`)).toBe(true);
  });

  it.each([
    'https://pbs.twimg.com/media/Animation.gif?format=gif&name=small',
    'https://pbs.twimg.com/ext_tw_video_thumb/123.jpg?format=jpg&name=small',
    'https://pbs.twimg.com/media/Photo.jpg?format=gif&name=small',
    'https://example.com/media/Photo.jpg?format=jpg',
    'http://pbs.twimg.com/media/Photo.jpg?format=jpg',
  ])('rejects unsupported or non-X image URL %s', value => {
    expect(isAllowedImageUrl(value)).toBe(false);
  });

  it('preserves the current displayed URL and derives an original size candidate', () => {
    const displayedUrl = 'https://pbs.twimg.com/media/SampleAsset.webp?format=webp&name=small';
    const info = getStaticImageUrlInfo(displayedUrl);

    expect(info).toEqual({
      extension: 'webp',
      originalFilename: 'SampleAsset.webp',
      originalUrl: 'https://pbs.twimg.com/media/SampleAsset.webp?format=webp&name=orig',
    });
    expect(isAllowedImageUrl(info?.originalUrl ?? '')).toBe(true);
  });
});
