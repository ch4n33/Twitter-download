import { describe, expect, it } from 'vitest';
import { isXPostMediaMetadata, parseXPostMediaMetadata } from '../../src/x/media-metadata';

const authorPhoto = (id: string, url: string) => ({ id_str: id, type: 'photo', media_url_https: url });
const directVideo = (id: string, url: string) => ({ id_str: id, type: 'video', video_info: { variants: [
  { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/88/pu/pl/live.m3u8', bitrate: 9000000 },
  { content_type: 'video/mp4', url, bitrate: 128000 },
] } });

function postResult(id: string, media: unknown[], quoted?: unknown) {
  return {
    rest_id: id,
    legacy: {
      id_str: id,
      extended_entities: { media },
      ...(quoted ? { quoted_status_result: { result: quoted } } : {}),
    },
  };
}

function timelineEntry(result: unknown) {
  return { content: { itemContent: { tweet_results: { result } } } };
}

describe('parseXPostMediaMetadata', () => {
  it('finds the owning post through home, user media, search, and bookmark timeline roots', () => {
    const id = '731002';
    const result = postResult(id, [
      authorPhoto('73101', 'https://pbs.twimg.com/media/HarborLight.jpg?format=jpg&name=small'),
      directVideo('73102', 'https://video.twimg.com/ext_tw_video/73102/pu/vid/640x360/harbor.mp4?tag=1'),
    ]);
    const entry = timelineEntry(result);
    const userResult = {
      __typename: 'User',
      rest_id: '991100',
      legacy: { id_str: '991100', name: 'Timeline Owner', screen_name: 'timeline_owner' },
      timeline_v2: { timeline: { instructions: [{ entries: [entry] }] } },
    };
    const payloads = [
      { data: { home: { home_timeline_urt: { instructions: [{ entries: [entry] }] } } } },
      { data: { user: { result: userResult } } },
      { data: { user: { result: userResult } } },
      { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ entries: [entry] }] } } } } },
      { data: { bookmark_timeline_v2: { timeline: { instructions: [{ entries: [entry] }] } } } },
    ];

    for (const payload of payloads) {
      const [metadata] = parseXPostMediaMetadata(payload);
      expect(metadata).toMatchObject({ postId: id, expectedMediaCount: 2 });
      expect(metadata?.assets.map(asset => [asset.mediaId, asset.index, asset.kind])).toEqual([
        ['73101', 1, 'image'], ['73102', 2, 'video'],
      ]);
      expect(metadata?.assets[1]?.url).toContain('harbor.mp4');
    }
  });

  it('selects the highest direct MP4 and never descends into a quoted post', () => {
    const quoted = postResult('992211', [directVideo('882211', 'https://video.twimg.com/ext_tw_video/882211/pu/vid/640x360/quote.mp4')]);
    const outer = postResult('881100', [{
      id_str: '88111', type: 'animated_gif', video_info: { variants: [
        { content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/loop-low.mp4', bitrate: 0 },
        { content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/loop-high.mp4', bitrate: 512000 },
        { content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/88111/pu/vid/bad.m3u8', bitrate: 9999999 },
      ] },
    }], quoted);

    const result = parseXPostMediaMetadata({ data: { tweetResult: { result: outer } } });
    expect(result.map(item => item.postId)).toEqual(['881100']);
    expect(result[0]?.assets).toEqual([{
      mediaId: '88111', index: 1, kind: 'animated_gif',
      url: 'https://video.twimg.com/tweet_video/loop-high.mp4',
    }]);
  });

  it('keeps raw mixed attachment count when a video has no direct MP4', () => {
    const payload = { data: { tweetResult: { result: postResult('650044', [
      authorPhoto('65001', 'https://pbs.twimg.com/media/Current.jpg?format=jpg&name=small'),
      { id_str: '65002', type: 'video', video_info: { variants: [
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/65002/pu/pl/clip.m3u8', bitrate: 1000000 },
      ] } },
      { id_str: '65003', type: 'space' },
    ]) } } };
    const [metadata] = parseXPostMediaMetadata(payload);
    expect(metadata?.expectedMediaCount).toBe(3);
    expect(metadata?.assets).toEqual([
      { mediaId: '65001', index: 1, kind: 'image', url: 'https://pbs.twimg.com/media/Current.jpg?format=jpg&name=small' },
      { mediaId: '65002', index: 2, kind: 'video', url: null },
    ]);
    expect(isXPostMediaMetadata(metadata)).toBe(true);
    expect(isXPostMediaMetadata({ ...metadata!, assets: [{ ...metadata!.assets[1]!, url: 'blob:https://x.com/clip' }] })).toBe(false);
  });

  it('uses rest_id when legacy.id_str is absent and rejects a conflicting legacy owner ID', () => {
    const withoutLegacyId = postResult('440077', [
      authorPhoto('44001', 'https://pbs.twimg.com/media/Identity.jpg?format=jpg'),
    ]);
    delete (withoutLegacyId.legacy as { id_str?: string }).id_str;
    expect(parseXPostMediaMetadata({ data: { tweetResult: { result: withoutLegacyId } } })[0]?.postId).toBe('440077');

    const conflicting = postResult('550088', [
      authorPhoto('55001', 'https://pbs.twimg.com/media/Conflict.jpg?format=jpg'),
    ]);
    conflicting.legacy.id_str = '550099';
    expect(parseXPostMediaMetadata({ data: { tweetResult: { result: conflicting } } })).toEqual([]);
  });
});
