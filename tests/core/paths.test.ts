import { describe, expect, it } from 'vitest';
import { buildRelativePath, validateFolderName } from '../../src/core/paths';
import type { PhotoAsset, PostSnapshot, Settings } from '../../src/core/types';

const photo: PhotoAsset = {
  key: 'image-a',
  kind: 'image',
  index: 3,
  originalFilename: 'coast-3.webp',
  extension: 'webp',
  displayedUrl: 'https://example.invalid/coast?size=small',
  originalUrl: 'https://example.invalid/coast?size=original',
};

const video: PhotoAsset = {
  key: 'video-a',
  kind: 'video',
  index: 2,
  originalFilename: 'sample-clip.mp4',
  extension: 'mp4',
  displayedUrl: 'https://video.twimg.com/tweet_video/sample-clip.mp4',
  originalUrl: null,
};

const post: PostSnapshot = {
  key: 'post-a',
  postId: '9876543210123456789',
  authorHandle: '@trail_maker',
  photos: [photo],
  expectedPhotoCount: 1,
  completeness: 'complete',
};

const baseSettings: Settings = {
  version: 1,
  subdirectory: '',
  grouping: 'none',
  filename: 'original',
  originalSize: true,
  saveGifAsGif: false,
};

const context = { now: new Date(2026, 10, 6, 12) };

describe('validateFolderName', () => {
  it.each(['', 'somedir', 'folder with spaces', '@sample_photo'])('accepts one safe component: %j', name => {
    expect(validateFolderName(name)).toEqual({ ok: true, value: name });
  });

  it.each([
    ['folder/nested', 'invalid_folder_name'],
    ['folder\\nested', 'invalid_folder_name'],
    ['.', 'invalid_folder_name'],
    ['..', 'invalid_folder_name'],
    ['trailing.', 'invalid_folder_name'],
    ['trailing ', 'invalid_folder_name'],
    ['CON.txt', 'invalid_folder_name'],
    ['has*wildcard', 'invalid_folder_name'],
    ['has\u0001control', 'invalid_folder_name'],
  ])('rejects unsafe component %j', (name, code) => {
    expect(validateFolderName(name)).toMatchObject({ ok: false, error: { code } });
  });
});

describe('buildRelativePath', () => {
  it('uses the chosen GIF output extension for original and generated filenames', () => {
    const animation: PhotoAsset = { ...video, key: 'animated-8', kind: 'animated_gif' };
    const animationPost = { ...post, photos: [animation] };
    const enabled = { ...baseSettings, saveGifAsGif: true };
    expect(buildRelativePath(animationPost, animation, enabled, context))
      .toEqual({ ok: true, value: { relativePath: 'sample-clip.gif', warnings: [] } });
    expect(buildRelativePath(animationPost, animation, { ...enabled, filename: 'post' }, context))
      .toMatchObject({ ok: true, value: { relativePath: 'trail_maker-9876543210123456789-2.gif' } });
    expect(buildRelativePath(animationPost, animation, baseSettings, context))
      .toMatchObject({ ok: true, value: { relativePath: 'sample-clip.mp4' } });
  });

  it('composes manual, generated date, and filename components in order', () => {
    const result = buildRelativePath(post, photo, {
      ...baseSettings,
      subdirectory: 'somedir',
      grouping: 'date',
    }, context);

    expect(result).toEqual({ ok: true, value: { relativePath: 'somedir/2026-11-06/coast-3.webp', warnings: [] } });
  });

  it('creates an author folder and generated filename from the owning post', () => {
    const result = buildRelativePath(post, photo, {
      ...baseSettings,
      subdirectory: 'saved',
      grouping: 'author',
      filename: 'post',
    }, context);

    expect(result).toEqual({
      ok: true,
      value: { relativePath: 'saved/@trail_maker/trail_maker-9876543210123456789-3.webp', warnings: [] },
    });
  });

  it('uses the original filename with a warning when generated name metadata is missing', () => {
    const result = buildRelativePath({ ...post, authorHandle: null, postId: null }, photo, {
      ...baseSettings,
      filename: 'post',
    }, context);

    expect(result).toEqual({
      ok: true,
      value: {
        relativePath: 'coast-3.webp',
        warnings: ['작성자 핸들이나 게시물 ID를 확인하지 못해 원본 파일명으로 저장합니다.'],
      },
    });
  });

  it('does not create an author folder when its handle is unavailable or path-unsafe', () => {
    const settings = { ...baseSettings, grouping: 'author' as const };
    expect(buildRelativePath({ ...post, authorHandle: null }, photo, settings, context))
      .toMatchObject({ ok: false, error: { code: 'author_handle_unavailable' } });
    expect(buildRelativePath({ ...post, authorHandle: 'bad/handle' }, photo, settings, context))
      .toMatchObject({ ok: false, error: { code: 'author_handle_unavailable' } });
  });

  it('uses the confirmed actual image extension for the output name', () => {
    const mismatchedName = { ...photo, originalFilename: 'coast.jpeg', extension: 'png' as const };
    const result = buildRelativePath({ ...post, photos: [mismatchedName] }, mismatchedName, baseSettings, context);
    expect(result).toMatchObject({
      ok: true,
      value: {
        relativePath: 'coast.png',
        warnings: ['확인된 이미지 형식(.png)에 맞춰 파일 확장자를 사용합니다.'],
      },
    });
  });

  it('preserves MP4 names for video assets and uses the media extension in generated names', () => {
    const videoPost = { ...post, photos: [video] };
    expect(buildRelativePath(videoPost, video, baseSettings, context))
      .toMatchObject({ ok: true, value: { relativePath: 'sample-clip.mp4', warnings: [] } });
    expect(buildRelativePath(videoPost, video, { ...baseSettings, filename: 'post' }, context))
      .toMatchObject({ ok: true, value: { relativePath: 'trail_maker-9876543210123456789-2.mp4' } });
  });

  it('rejects a media kind paired with the wrong extension', () => {
    const invalid = { ...video, extension: 'jpg' as const };
    expect(buildRelativePath({ ...post, photos: [invalid] }, invalid, baseSettings, context))
      .toMatchObject({ ok: false, error: { code: 'invalid_photo' } });
  });

  it('never accepts a photo that is not part of the requested post', () => {
    expect(buildRelativePath(post, { ...photo, key: 'other' }, baseSettings, context))
      .toMatchObject({ ok: false, error: { code: 'photo_not_in_post' } });
  });
});
