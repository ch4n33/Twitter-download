import { isAllowedImageUrl, isAllowedVideoUrl } from './media-urls';

export type XMediaKind = 'image' | 'video' | 'animated_gif';

/** A small, URL-validated projection of one X post's own extended_entities.media list. */
export interface XPostMediaAssetMetadata {
  mediaId: string;
  index: number;
  kind: XMediaKind;
  /** Null when X supplied no usable static image or direct MP4 source. */
  url: string | null;
}

export interface XPostMediaMetadata {
  postId: string;
  /** Count of raw extended_entities.media entries, including unsupported entries. */
  expectedMediaCount: number;
  assets: XPostMediaAssetMetadata[];
}

export const MEDIA_METADATA_BRIDGE = 'x-media-metadata-v1';

const MAX_MEDIA_PER_POST = 100;
const MAX_POSTS_PER_RESPONSE = 200;
const MAX_VISITED_OBJECTS = 12_000;
const MAX_DEPTH = 32;
const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const POST_ID_PATTERN = /^\d{1,32}$/;
const TRAVERSABLE_KEYS = new Set([
  'data', 'home', 'home_timeline_urt', 'user', 'search_by_raw_query', 'search_timeline',
  'bookmark_timeline_v2', 'tweetResult', 'result', 'tweet_results', 'instructions', 'entries', 'entry',
  'content', 'itemContent', 'item_content', 'timeline', 'timeline_v2', 'moduleItems',
  'items', 'conversationThread', 'tweet', 'tweet_results', 'threaded_conversation_with_injections_v2',
]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && value.length <= 100 && pattern.test(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function finiteBitrate(value: unknown): number {
  return integer(value, 0, 1_000_000_000) ? value : 0;
}

function dimensionScore(value: unknown): number {
  if (!isRecord(value)) return 0;
  const width = integer(value.width, 1, 100_000) ? value.width : 0;
  const height = integer(value.height, 1, 100_000) ? value.height : 0;
  return width * height;
}

function directMp4Variant(videoInfo: unknown): string | null {
  if (!isRecord(videoInfo) || !Array.isArray(videoInfo.variants)) return null;
  const candidates: Array<{ url: string; bitrate: number; dimensions: number }> = [];
  for (const entry of videoInfo.variants.slice(0, 100)) {
    if (!isRecord(entry) || typeof entry.url !== 'string' || entry.url.length > 8192) continue;
    if (typeof entry.content_type !== 'string'
      || entry.content_type.split(';', 1)[0]?.trim().toLowerCase() !== 'video/mp4') continue;
    if (!isAllowedVideoUrl(entry.url)) continue;
    candidates.push({
      url: entry.url,
      bitrate: finiteBitrate(entry.bitrate),
      dimensions: dimensionScore(entry),
    });
  }
  candidates.sort((left, right) => right.bitrate - left.bitrate
    || right.dimensions - left.dimensions
    || left.url.localeCompare(right.url));
  return candidates[0]?.url ?? null;
}

function recordFromPost(value: JsonRecord): XPostMediaMetadata | null {
  if (!boundedId(value.rest_id, POST_ID_PATTERN) || !isRecord(value.legacy)
    || (value.legacy.id_str !== undefined && value.legacy.id_str !== value.rest_id)
    || !isRecord(value.legacy.extended_entities)
    || !Array.isArray(value.legacy.extended_entities.media)) return null;
  const rawMedia = value.legacy.extended_entities.media;
  if (rawMedia.length < 1 || rawMedia.length > MAX_MEDIA_PER_POST) return null;

  const assets: XPostMediaAssetMetadata[] = [];
  rawMedia.forEach((item, offset) => {
    if (!isRecord(item) || !boundedId(item.id_str, MEDIA_ID_PATTERN)) return;
    if (item.type !== 'photo' && item.type !== 'video' && item.type !== 'animated_gif') return;
    const kind: XMediaKind = item.type === 'photo' ? 'image' : item.type;
    let url: string | null = null;
    if (kind === 'image') {
      if (typeof item.media_url_https === 'string' && item.media_url_https.length <= 8192
        && isAllowedImageUrl(item.media_url_https)) url = item.media_url_https;
    } else {
      url = directMp4Variant(item.video_info);
    }
    assets.push({ mediaId: item.id_str, index: offset + 1, kind, url });
  });

  return { postId: value.rest_id, expectedMediaCount: rawMedia.length, assets };
}

function preferredDuplicate(previous: XPostMediaMetadata, next: XPostMediaMetadata): XPostMediaMetadata {
  const resolvedCount = (metadata: XPostMediaMetadata) => metadata.assets.filter(asset => asset.url !== null).length;
  if (next.expectedMediaCount > previous.expectedMediaCount) return next;
  if (next.expectedMediaCount < previous.expectedMediaCount) return previous;
  return resolvedCount(next) > resolvedCount(previous) ? next : previous;
}

/**
 * Extracts only bounded X post result nodes reached through known GraphQL response containers.
 * Post nodes are terminal: quoted/embedded posts beneath a post are never traversed.
 */
export function parseXPostMediaMetadata(payload: unknown): XPostMediaMetadata[] {
  const found = new Map<string, XPostMediaMetadata>();
  const visited = new WeakSet<object>();
  let visitedCount = 0;

  const visit = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH || visitedCount >= MAX_VISITED_OBJECTS || !value || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);
    visitedCount += 1;

    if (Array.isArray(value)) {
      for (const child of value) {
        if (visitedCount >= MAX_VISITED_OBJECTS) break;
        visit(child, depth + 1);
      }
      return;
    }
    const record = value as JsonRecord;
    if (typeof record.rest_id === 'string') {
      const metadata = recordFromPost(record);
      if (metadata) {
        const previous = found.get(metadata.postId);
        found.set(metadata.postId, previous ? preferredDuplicate(previous, metadata) : metadata);
        // Do not descend into legacy or any quoted status embedded inside this post.
        return;
      }
    }

    let propertyCount = 0;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      propertyCount += 1;
      if (propertyCount > 256) break;
      if (!TRAVERSABLE_KEYS.has(key)) continue;
      visit(record[key], depth + 1);
      if (found.size >= MAX_POSTS_PER_RESPONSE || visitedCount >= MAX_VISITED_OBJECTS) break;
    }
  };

  visit(payload, 0);
  return [...found.values()].slice(0, MAX_POSTS_PER_RESPONSE);
}

/** Defense-in-depth validation for data arriving through the page-to-isolated-world bridge. */
export function isXPostMediaMetadata(value: unknown): value is XPostMediaMetadata {
  if (!isRecord(value) || !boundedId(value.postId, POST_ID_PATTERN)
    || !integer(value.expectedMediaCount, 1, MAX_MEDIA_PER_POST)
    || !Array.isArray(value.assets) || value.assets.length > value.expectedMediaCount) return false;
  const seen = new Set<string>();
  for (const item of value.assets) {
    if (!isRecord(item) || !boundedId(item.mediaId, MEDIA_ID_PATTERN)
      || !integer(item.index, 1, value.expectedMediaCount)
      || (item.kind !== 'image' && item.kind !== 'video' && item.kind !== 'animated_gif')
      || !(item.url === null || typeof item.url === 'string' && item.url.length <= 8192)) return false;
    if (item.url === null) {
      if (item.kind === 'image') return false;
    } else if (item.kind === 'image' ? !isAllowedImageUrl(item.url) : !isAllowedVideoUrl(item.url)) {
      return false;
    }
    const identity = `${item.index}:${item.mediaId}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
  }
  return true;
}
