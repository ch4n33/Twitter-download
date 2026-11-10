import { describe, expect, it } from 'vitest';
import {
  getStaticImageUrlInfo,
  getVideoUrlInfo,
  isAllowedImageUrl,
  isAllowedMediaUrl,
  isAllowedVideoUrl,
} from '../../src/x/media-urls';

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

describe('X direct MP4 URLs', () => {
  it.each([
    'https://video.twimg.com/ext_tw_video/123456789/pu/vid/avc1/720x1280/Clip-A.mp4?tag=12',
    'https://video.twimg.com/amplify_video/987654321/vid/avc1/480x854/Clip-B.mp4',
    'https://video.twimg.com/tweet_video/Legacy_Clip-1.mp4',
  ])('accepts known direct MP4 path %s', value => {
    expect(isAllowedVideoUrl(value)).toBe(true);
    expect(isAllowedMediaUrl(value)).toBe(true);
  });

  it.each([
    'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/720x1280/Clip.m3u8',
    'https://video.twimg.com/ext_tw_video_thumb/123/Clip.mp4',
    'https://video.twimg.com/amplify_video/123/poster/Clip.jpg',
    'https://video.twimg.com/other/Clip.mp4',
    'https://example.com/tweet_video/Clip.mp4',
    'http://video.twimg.com/tweet_video/Clip.mp4',
    'https://user@video.twimg.com/tweet_video/Clip.mp4',
    'https://video.twimg.com:444/tweet_video/Clip.mp4',
    'https://video.twimg.com/ext_tw_video/123/pu/../vid/avc1/720x1280/Clip.mp4',
    'https://video.twimg.com/ext_tw_video/123/pu%2Fvid/avc1/720x1280/Clip.mp4',
  ])('rejects non-MP4, untrusted, or path-trick URL %s', value => {
    expect(isAllowedVideoUrl(value)).toBe(false);
  });

  it('extracts a safe original filename and an inferable media ID', () => {
    expect(getVideoUrlInfo('https://video.twimg.com/ext_tw_video/123456/pu/vid/720x1280/Clip-A.mp4?tag=12'))
      .toEqual({ originalFilename: 'Clip-A.mp4', mediaId: '123456' });
    expect(getVideoUrlInfo('https://video.twimg.com/tweet_video/legacy.mp4'))
      .toEqual({ originalFilename: 'legacy.mp4', mediaId: 'legacy' });
    expect(getVideoUrlInfo('blob:https://video.twimg.com/Clip.mp4')).toBeNull();
  });

  it('keeps the image-only and combined URL validators distinct', () => {
    const video = 'https://video.twimg.com/tweet_video/Clip.mp4';
    const image = 'https://pbs.twimg.com/media/Photo.jpg?format=jpg&name=small';
    expect(isAllowedImageUrl(video)).toBe(false);
    expect(isAllowedMediaUrl(video)).toBe(true);
    expect(isAllowedMediaUrl(image)).toBe(true);
  });
});
