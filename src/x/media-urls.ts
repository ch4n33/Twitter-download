import type { StaticImageExtension } from '../core/types';

const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif'] as const satisfies readonly StaticImageExtension[];
const ALLOWED = new Set<string>(EXTENSIONS);
const VIDEO_THUMBNAIL_NAMES = /^(?:ext_tw_video_thumb|tweet_video_thumb|amplify_video_thumb|video_thumb)(?:[_-]|$)/i;

export interface StaticImageUrlInfo {
  extension: StaticImageExtension;
  originalFilename: string | null;
  originalUrl: string | null;
}

export interface VideoUrlInfo {
  originalFilename: string;
  mediaId: string | null;
}

function extensionFromPathSegment(segment: string): string | null {
  const match = /\.([a-z0-9]+)(?::[a-z0-9_-]+)?$/i.exec(segment);
  return match?.[1]?.toLowerCase() ?? null;
}

function parseMediaUrl(value: string): { url: URL; segment: string; extension: StaticImageExtension } | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'pbs.twimg.com'
    || url.port !== '' || url.username !== '' || url.password !== '') return null;

  const pathMatch = /^\/media\/([^/]+)$/i.exec(url.pathname);
  if (!pathMatch) return null;

  let segment: string;
  try {
    segment = decodeURIComponent(pathMatch[1]);
  } catch {
    return null;
  }
  if (!segment || segment.includes('/') || segment.includes('\\') || VIDEO_THUMBNAIL_NAMES.test(segment)) return null;

  const pathExtension = extensionFromPathSegment(segment);
  const formats = url.searchParams.getAll('format').map(format => format.toLowerCase());
  if (formats.length > 1 && new Set(formats).size !== 1) return null;
  const queryFormat = formats[0] ?? null;
  if (pathExtension && !ALLOWED.has(pathExtension)) return null;
  if (queryFormat && !ALLOWED.has(queryFormat)) return null;
  if (!pathExtension && !queryFormat) return null;

  if (pathExtension && queryFormat
    && !(pathExtension === queryFormat || (pathExtension === 'jpg' && queryFormat === 'jpeg')
      || (pathExtension === 'jpeg' && queryFormat === 'jpg'))) return null;

  const extension = (pathExtension ?? queryFormat) as StaticImageExtension;
  return { url, segment, extension };
}

/** Accepts only HTTPS static image files hosted directly by X's media origin. */
export function isAllowedImageUrl(value: string): boolean {
  return parseMediaUrl(value) !== null;
}

export function getStaticImageUrlInfo(value: string): StaticImageUrlInfo | null {
  const parsed = parseMediaUrl(value);
  if (!parsed) return null;

  const unvariedSegment = parsed.segment.replace(/:[a-z0-9_-]+$/i, '');
  const extensionMatch = /\.([a-z0-9]+)$/i.exec(unvariedSegment);
  const base = extensionMatch ? unvariedSegment.slice(0, -extensionMatch[0].length) : unvariedSegment;
  const originalFilename = /^[a-z0-9_-]{1,180}$/i.test(base) ? `${base}.${parsed.extension}` : null;

  let originalUrl: string | null = null;
  if (parsed.url.searchParams.has('name')) {
    parsed.url.searchParams.set('name', 'orig');
    originalUrl = parsed.url.toString();
  } else if (/\.[a-z0-9]+:[a-z0-9_-]+$/i.test(parsed.segment)) {
    parsed.url.pathname = parsed.url.pathname.replace(/:[a-z0-9_-]+$/i, ':orig');
    originalUrl = parsed.url.toString();
  } else {
    parsed.url.searchParams.set('name', 'orig');
    originalUrl = parsed.url.toString();
  }

  if (!originalUrl || !isAllowedImageUrl(originalUrl)) originalUrl = null;
  return { extension: parsed.extension, originalFilename, originalUrl };
}

function parseVideoUrl(value: string): { pathname: string; mediaId: string | null } | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || value.includes('\\')) return null;

  const rawPath = /^https:\/\/[^/?#]+([^?#]*)/i.exec(value)?.[1] ?? '/';
  if (rawPath.split('/').some(segment => segment === '.' || segment === '..')) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'video.twimg.com'
    || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '') return null;

  const pathname = url.pathname;
  // Encoded separators or dots can disguise path boundaries before URL normalization.
  if (/%(?:2f|5c|2e)/i.test(pathname)) return null;
  const segments = pathname.split('/').slice(1);
  if (segments.some(segment => !/^[a-z0-9_-][a-z0-9._~-]*$/i.test(segment))) return null;
  const filename = segments.at(-1);
  if (!filename || !/^[a-z0-9_-][a-z0-9._~-]{0,180}\.mp4$/i.test(filename)) return null;

  let mediaId: string | null = null;
  if (segments[0] === 'ext_tw_video' && /^\d{1,32}$/.test(segments[1] ?? '')) {
    const videoPath = segments.slice(2);
    const vidIndex = videoPath.indexOf('vid');
    if (vidIndex < 0 || vidIndex >= videoPath.length - 1) return null;
    mediaId = segments[1]!;
  } else if (segments[0] === 'amplify_video' && /^\d{1,32}$/.test(segments[1] ?? '')) {
    if (segments.length < 3) return null;
    mediaId = segments[1]!;
  } else if (segments[0] === 'tweet_video' && segments.length === 2) {
    // The legacy route uses its filename as the clip identifier.
    mediaId = filename.slice(0, -'.mp4'.length);
  } else {
    return null;
  }

  return { pathname, mediaId };
}

/** Accepts only direct MP4 files from the known X video URL path families. */
export function isAllowedVideoUrl(value: string): boolean {
  return parseVideoUrl(value) !== null;
}

/** Accepts media URLs supported by this downloader: static images or direct MP4 files. */
export function isAllowedMediaUrl(value: string): boolean {
  return isAllowedImageUrl(value) || isAllowedVideoUrl(value);
}

export function getVideoUrlInfo(value: string): VideoUrlInfo | null {
  const parsed = parseVideoUrl(value);
  if (!parsed) return null;
  const originalFilename = parsed.pathname.split('/').at(-1);
  return originalFilename ? { originalFilename, mediaId: parsed.mediaId } : null;
}
