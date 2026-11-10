import { describe, expect, it } from 'vitest';
import { isDownloadStatusMessage, isExtensionRequest } from '../../src/platform/messaging';
import type { DownloadStartRequest } from '../../src/core/types';

const request: DownloadStartRequest = {
  type: 'download.start', requestId: 'request-another', selection: 'all',
  post: {
    key: 'post-987654321', postId: '987654321', authorHandle: 'another_author',
    expectedPhotoCount: 1, completeness: 'complete',
    photos: [{ key: 'second-media', kind: 'image', index: 1, originalFilename: 'different.png',
      extension: 'png', displayedUrl: 'https://pbs.twimg.com/media/different?format=png&name=small',
      originalUrl: 'https://pbs.twimg.com/media/different?format=png&name=orig' }],
  },
};

describe('extension boundary', () => {
  it('accepts serializable photo requests without depending on example identities', () => {
    expect(isExtensionRequest(structuredClone(request))).toBe(true);
    expect(isExtensionRequest({ ...request, selection: { photoKeys: ['second-media'] } })).toBe(true);
  });
  it('accepts direct MP4 media when kind and extension agree', () => {
    const photo = request.post.photos[0]!;
    for (const kind of ['video', 'animated_gif'] as const) {
      expect(isExtensionRequest({
        ...request,
        post: { ...request.post, photos: [{
          ...photo,
          kind,
          extension: 'mp4',
          displayedUrl: 'https://video.twimg.com/tweet_video/clip.mp4',
          originalFilename: 'clip.mp4',
          originalUrl: null,
        }] },
      })).toBe(true);
    }
  });
  it('rejects kind-extension mismatches and duplicate attachment identities', () => {
    const video = structuredClone(request);
    (video.post.photos[0] as { kind: string }).kind = 'video';
    expect(isExtensionRequest(video)).toBe(false);
    expect(isExtensionRequest({ ...request, post: { ...request.post, photos: [...request.post.photos, ...request.post.photos] } })).toBe(false);
  });
  it('rejects malformed runtime messages instead of trusting TypeScript alone', () => {
    expect(isExtensionRequest(null)).toBe(false);
    expect(isExtensionRequest({ ...request, selection: { photoKeys: [] } })).toBe(false);
    expect(isExtensionRequest({ type: 'download.getStatus', jobId: '' })).toBe(false);
    expect(isDownloadStatusMessage({ type: 'download.status', job: { id: 'x', items: [null] } })).toBe(false);
  });
});
