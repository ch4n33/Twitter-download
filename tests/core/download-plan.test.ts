import { describe, expect, it } from 'vitest';
import { createDownloadPlan } from '../../src/core/download-plan';
import type { PhotoAsset, PostSnapshot, Settings } from '../../src/core/types';

function makePhoto(index: number, extension: PhotoAsset['extension'] = 'jpeg'): PhotoAsset {
  return {
    key: `photo-${index}`,
    kind: 'image',
    index,
    originalFilename: `image-${index}.${extension}`,
    extension,
    displayedUrl: `https://example.invalid/image-${index}?size=small`,
    originalUrl: `https://example.invalid/image-${index}?size=original`,
  };
}

function makePost(photos: PhotoAsset[]): PostSnapshot {
  return {
    key: 'post-990001122',
    postId: '990001122',
    authorHandle: 'lens_archive',
    photos,
    expectedPhotoCount: photos.length,
    completeness: 'complete',
  };
}

const settings: Settings = {
  version: 1,
  subdirectory: '',
  grouping: 'none',
  filename: 'original',
  originalSize: true,
  saveGifAsGif: false,
};

describe('createDownloadPlan', () => {
  it('converts only animated GIF sources when enabled and leaves the MP4 source identity intact', () => {
    const animation: PhotoAsset = { key: 'loop-48', kind: 'animated_gif', index: 2,
      originalFilename: 'motion-source.mp4', extension: 'mp4',
      displayedUrl: 'https://video.twimg.com/tweet_video/motion-source.mp4', originalUrl: null };
    const video: PhotoAsset = { ...animation, key: 'video-49', kind: 'video', index: 3 };
    const post = makePost([makePhoto(1), animation, video]);
    const result = createDownloadPlan(post, 'all', { ...settings, saveGifAsGif: true }, { now: new Date(2026, 10, 10) });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.tasks.map(task => [task.kind, task.outputFormat, task.transform])).toEqual([
      ['image', 'jpeg', undefined], ['animated_gif', 'gif', 'mp4-to-gif'], ['video', 'mp4', undefined],
    ]);
    expect(result.value.tasks[1]).toMatchObject({ url: animation.displayedUrl, extension: 'mp4', relativePath: 'motion-source.gif' });
    expect(animation.extension).toBe('mp4');
    const disabled = createDownloadPlan(post, { photoKeys: [animation.key] }, settings, { now: new Date(2026, 10, 10) });
    expect(disabled).toMatchObject({ ok: true, value: { tasks: [{ outputFormat: 'mp4', relativePath: 'motion-source.mp4' }] } });
    if (disabled.ok) expect(disabled.value.tasks[0]!.transform).toBeUndefined();
  });

  it('uses the original URL by default and records the injected request time', () => {
    const post = makePost([makePhoto(1)]);
    const result = createDownloadPlan(post, 'all', settings, { now: new Date(2026, 10, 6, 9, 30) });

    expect(result).toMatchObject({
      ok: true,
      value: {
        postKey: post.key,
        createdAt: new Date(2026, 10, 6, 9, 30).toISOString(),
        tasks: [{ photoKey: 'photo-1', index: 1, url: 'https://example.invalid/image-1?size=original', relativePath: 'image-1.jpeg' }],
        warnings: [],
      },
    });
  });

  it('sorts selected photos by original attachment index, regardless of key order', () => {
    const post = makePost([makePhoto(1), makePhoto(2), makePhoto(3)]);
    const result = createDownloadPlan(post, { photoKeys: ['photo-3', 'photo-1'] }, {
      ...settings,
      filename: 'post',
      originalSize: false,
    }, { now: new Date(2026, 10, 6) });

    expect(result).toMatchObject({
      ok: true,
      value: {
        tasks: [
          { photoKey: 'photo-1', index: 1, url: 'https://example.invalid/image-1?size=small', relativePath: 'lens_archive-990001122-1.jpeg' },
          { photoKey: 'photo-3', index: 3, url: 'https://example.invalid/image-3?size=small', relativePath: 'lens_archive-990001122-3.jpeg' },
        ],
      },
    });
  });

  it.each(['video', 'animated_gif'] as const)('plans %s as its displayed MP4 regardless of original-size setting', kind => {
    const media: PhotoAsset = {
      key: 'clip-1',
      kind,
      index: 1,
      originalFilename: 'clip-1.mp4',
      extension: 'mp4',
      displayedUrl: 'https://video.twimg.com/tweet_video/clip-1.mp4?tag=12',
      originalUrl: null,
    };
    const post = makePost([media]);
    const result = createDownloadPlan(post, 'all', { ...settings, originalSize: true }, {
      now: new Date(2026, 10, 6),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        tasks: [{
          photoKey: 'clip-1', kind, extension: 'mp4',
          url: media.displayedUrl, relativePath: 'clip-1.mp4',
        }],
      },
    });
  });

  it('rejects a media kind paired with the wrong output extension', () => {
    const invalid = { ...makePhoto(1), kind: 'video' as const };
    expect(createDownloadPlan(makePost([invalid]), 'all', settings, { now: new Date(2026, 10, 6) }))
      .toMatchObject({ ok: false, error: { code: 'invalid_photo_list' } });
  });

  it.each([
    [{ completeness: 'partial' as const, expectedPhotoCount: 2 }, 'incomplete_photo_list'],
    [{ completeness: 'complete' as const, expectedPhotoCount: 3 }, 'incomplete_photo_list'],
    [{ completeness: 'complete' as const, expectedPhotoCount: null }, 'incomplete_photo_list'],
  ])('rejects an all-photo plan unless completeness and total count agree: %j', (overrides, code) => {
    const post = { ...makePost([makePhoto(1), makePhoto(2)]), ...overrides };
    expect(createDownloadPlan(post, 'all', settings, { now: new Date(2026, 10, 6) }))
      .toMatchObject({ ok: false, error: { code } });
  });

  it('does not silently use the displayed image when the original image is missing', () => {
    const photo = { ...makePhoto(1), originalUrl: null };
    expect(createDownloadPlan(makePost([photo]), 'all', settings, { now: new Date(2026, 10, 6) }))
      .toMatchObject({ ok: false, error: { code: 'original_image_unavailable' } });
  });

  it('rejects an all-photo list whose original indices contain a gap', () => {
    const post = makePost([makePhoto(1), makePhoto(3)]);
    post.expectedPhotoCount = 2;
    expect(createDownloadPlan(post, 'all', settings, { now: new Date(2026, 10, 6) }))
      .toMatchObject({ ok: false, error: { code: 'incomplete_photo_list' } });
  });

  it('uses the device-local job-start date for date grouping', () => {
    const post = makePost([makePhoto(1)]);
    const result = createDownloadPlan(post, 'all', { ...settings, grouping: 'date' }, {
      now: new Date(2026, 10, 6, 23, 59),
    });
    expect(result).toMatchObject({
      ok: true,
      value: { tasks: [{ relativePath: '2026-11-06/image-1.jpeg' }] },
    });
  });

  it('rejects duplicate, unknown, and empty individual selections', () => {
    const post = makePost([makePhoto(1)]);
    const context = { now: new Date(2026, 10, 6) };
    expect(createDownloadPlan(post, { photoKeys: ['photo-1', 'photo-1'] }, settings, context))
      .toMatchObject({ ok: false, error: { code: 'duplicate_selection' } });
    expect(createDownloadPlan(post, { photoKeys: ['missing'] }, settings, context))
      .toMatchObject({ ok: false, error: { code: 'photo_not_in_post' } });
    expect(createDownloadPlan(post, { photoKeys: [] }, settings, context))
      .toMatchObject({ ok: false, error: { code: 'invalid_selection' } });
  });
});
