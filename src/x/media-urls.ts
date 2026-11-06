import type { StaticImageExtension } from '../core/types';

const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif'] as const satisfies readonly StaticImageExtension[];
const ALLOWED = new Set<string>(EXTENSIONS);
const VIDEO_THUMBNAIL_NAMES = /^(?:ext_tw_video_thumb|tweet_video_thumb|amplify_video_thumb|video_thumb)(?:[_-]|$)/i;

export interface StaticImageUrlInfo {
  extension: StaticImageExtension;
  originalFilename: string | null;
  originalUrl: string | null;
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
