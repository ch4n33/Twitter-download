import type { PhotoAsset, PostSnapshot, StaticImageExtension } from '../core/types';
import { getStaticImageUrlInfo, isAllowedImageUrl } from './media-urls';
import { belongsToPost, findOwningPost, isInsideQuote, X_SELECTORS } from './selectors';

export interface PostReadResult {
  snapshot: PostSnapshot;
  photoTargets: Map<string, HTMLElement>;
  fingerprint: string;
}

interface MediaSource {
  url: string;
  ready: boolean;
}

interface PhotoSlot {
  wrapper: HTMLElement;
  explicitIndex: number | null;
  source: MediaSource | null;
}

interface StatusLinkInfo {
  postId: string;
  photoIndex: number | null;
  authorHandle: string | null;
}

interface PostIdentity {
  postId: string | null;
  authorHandle: string | null;
  bodyText: string;
}

const COUNT_ATTRIBUTES = ['data-photo-count', 'data-image-count', 'data-media-count', 'data-count'] as const;
const INDEX_ATTRIBUTES = ['data-photo-index', 'data-image-index', 'data-media-index'] as const;
const EXCLUDED_SOURCE_SELECTORS = '[data-testid*="video"], [data-testid*="Video"], [data-testid*="gif"], [data-testid*="GIF"]';

function elementsWithin<T extends Element>(root: HTMLElement, selector: string): T[] {
  return Array.from(root.querySelectorAll(selector)) as T[];
}

function allOwnedElements(post: HTMLElement, identity: PostIdentity): Element[] {
  return [post, ...elementsWithin(post, '*')].filter(element => belongsToPostIdentity(element, post, identity));
}

function parsePositiveIndex(value: string | null): number | null {
  if (value === null || !/^\d{1,3}$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

function statusLinkInfo(href: string | null): StatusLinkInfo | null {
  if (!href) return null;
  let path: string;
  try { path = new URL(href, 'https://x.com').pathname; } catch { return null; }
  const match = /(?:^|\/)status\/(\d+)(?:\/photo\/(\d+))?(?:\/|$)/i.exec(path);
  if (!match) return null;
  const segments = path.split('/').filter(Boolean);
  const statusSegment = segments.findIndex((segment, index) =>
    segment.toLowerCase() === 'status' && /^\d+$/.test(segments[index + 1] ?? ''));
  const possibleAuthor = statusSegment > 0 ? segments[statusSegment - 1] : null;
  const isInternalStatusRoute = statusSegment >= 2
    && segments[statusSegment - 2].toLowerCase() === 'i'
    && possibleAuthor?.toLowerCase() === 'web';
  const decodedAuthor = possibleAuthor ? decodePathSegment(possibleAuthor) : null;
  const authorHandle = !isInternalStatusRoute && decodedAuthor && /^[a-z0-9_]{1,30}$/i.test(decodedAuthor)
    && !/^(?:i|home|explore|search|notifications|messages|compose|settings|photo)$/i.test(decodedAuthor)
    ? `@${decodedAuthor}`
    : null;
  return { postId: match[1], photoIndex: parsePositiveIndex(match[2] ?? null), authorHandle };
}

function decodePathSegment(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}

function statusLinkElements(root: Element): HTMLAnchorElement[] {
  const matches: Element[] = [];
  if (root.matches('a[href*="/status/"]')) matches.push(root);
  matches.push(...Array.from(root.querySelectorAll('a[href*="/status/"]')));
  return [...new Set(matches)].filter((element): element is HTMLAnchorElement => element.tagName === 'A');
}

function statusLinksForElement(element: Element, post: HTMLElement): StatusLinkInfo[] {
  const links = statusLinkElements(element);
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== post) {
    if (ancestor.matches('a[href*="/status/"]')) {
      links.push(ancestor as HTMLAnchorElement);
      break;
    }
    ancestor = ancestor.parentElement;
  }
  return [...new Set(links)]
    .filter(link => belongsToPost(link, post))
    .map(link => statusLinkInfo(link.getAttribute('href')))
    .filter((info): info is StatusLinkInfo => info !== null);
}

/** Quote cards without X's quote test id can still be bounded by their role=link wrapper. */
function statusRoleLinkBoundary(element: Element, post: HTMLElement): HTMLElement | null {
  let ancestor: Element | null = element;
  while (ancestor && ancestor !== post) {
    if (ancestor.matches('[role="link"]') && ancestor.tagName !== 'A'
      && statusLinkElements(ancestor).some(link => belongsToPost(link, post))) {
      return ancestor as HTMLElement;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function belongsToPostIdentity(element: Element, post: HTMLElement, identity: Pick<PostIdentity, 'postId'>): boolean {
  if (!belongsToPost(element, post)) return false;
  const localIds = new Set(statusLinksForElement(element, post).map(info => info.postId));
  const boundary = statusRoleLinkBoundary(element, post);
  const boundaryIds = boundary
    ? new Set(statusLinkElements(boundary).map(link => statusLinkInfo(link.getAttribute('href'))?.postId).filter((id): id is string => id !== undefined))
    : new Set<string>();

  if (identity.postId) {
    if (localIds.size > 0 && !localIds.has(identity.postId)) return false;
    if (boundaryIds.size > 0 && !boundaryIds.has(identity.postId)) return false;
  } else if (boundaryIds.size > 0 && (localIds.size === 0 || [...localIds].some(id => !boundaryIds.has(id)))) {
    return false;
  }
  return true;
}

function handleFromHref(href: string | null): string | null {
  if (!href) return null;
  let path = href;
  try { path = new URL(href, 'https://x.com').pathname; } catch { /* Use a relative href as supplied. */ }
  const match = /^\/([^/]+)\/?$/.exec(path);
  if (!match || /^(?:i|home|explore|search|notifications|messages|compose|settings|photo)$/i.test(match[1])) return null;
  let handle: string;
  try { handle = decodeURIComponent(match[1]); } catch { return null; }
  return /^[a-z0-9_]{1,30}$/i.test(handle) ? `@${handle}` : null;
}

function readAuthorHandle(post: HTMLElement): string | null {
  const nameBlock = elementsWithin(post, X_SELECTORS.userName)
    .find(element => belongsToPost(element, post) && !statusRoleLinkBoundary(element, post));
  if (!nameBlock) return null;
  const direct = nameBlock.getAttribute('data-screen-name') ?? nameBlock.getAttribute('data-username');
  if (direct && /^[a-z0-9_]{1,30}$/i.test(direct.replace(/^@/, ''))) return `@${direct.replace(/^@/, '')}`;

  for (const anchor of Array.from(nameBlock.querySelectorAll('a[href]'))) {
    const handle = handleFromHref(anchor.getAttribute('href'));
    if (handle) return handle;
  }
  const text = nameBlock.textContent ?? '';
  const match = /(?:^|\s)@([a-z0-9_]{1,30})(?:\s|$)/i.exec(text);
  return match ? `@${match[1]}` : null;
}

function readPostIdentity(post: HTMLElement): PostIdentity {
  const authorHandle = readAuthorHandle(post);
  const entries = statusLinkElements(post)
    .filter(anchor => belongsToPost(anchor, post)
      && !isInsideQuote(anchor, post)
      && !statusRoleLinkBoundary(anchor, post))
    .map(anchor => ({ anchor, info: statusLinkInfo(anchor.getAttribute('href')) }))
    .filter((entry): entry is { anchor: HTMLAnchorElement; info: StatusLinkInfo } => entry.info !== null);
  const nonPhotoEntries = entries.filter(entry => !entry.anchor.closest(X_SELECTORS.photo));
  const matchingAuthor = (list: typeof entries) => authorHandle
    ? list.filter(entry => entry.info.authorHandle?.toLowerCase() === authorHandle.toLowerCase())
    : [];
  const uniquePostId = (list: typeof entries): string | null => {
    const ids = [...new Set(list.map(entry => entry.info.postId))];
    return ids.length === 1 ? ids[0] : null;
  };
  const postId = uniquePostId(matchingAuthor(nonPhotoEntries))
    ?? uniquePostId(nonPhotoEntries)
    ?? uniquePostId(matchingAuthor(entries))
    ?? uniquePostId(entries);
  const body = elementsWithin(post, X_SELECTORS.tweetText).find(element => belongsToPost(element, post));
  return {
    postId,
    authorHandle,
    bodyText: (body?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  };
}

function readExplicitIndex(wrapper: HTMLElement, post: HTMLElement, identity: PostIdentity): number | null {
  const canonicalIndex = statusLinksForElement(wrapper, post)
    .find(info => !identity.postId || info.postId === identity.postId)?.photoIndex ?? null;
  if (canonicalIndex !== null) return canonicalIndex;

  for (const attribute of INDEX_ATTRIBUTES) {
    const index = parsePositiveIndex(wrapper.getAttribute(attribute));
    if (index !== null) return index;
  }

  const label = wrapper.getAttribute('aria-label') ?? wrapper.getAttribute('aria-description') ?? '';
  const labelMatch = /(?:photo|image|picture|사진)\s*(?:#\s*)?(\d+)/i.exec(label);
  if (labelMatch) return parsePositiveIndex(labelMatch[1]);
  return null;
}

function parseCountHint(text: string): number | null {
  const fraction = /(?:image|photo|picture|사진)?\s*\d{1,3}\s*(?:of|\/)\s*(\d{1,3})/i.exec(text);
  const count = fraction?.[1] ?? /^(\d{1,3})$/.exec(text.trim())?.[1];
  return parsePositiveIndex(count ?? null);
}

function readExpectedCount(post: HTMLElement, identity: PostIdentity): { count: number | null; conflict: boolean } {
  const counts = new Set<number>();
  for (const element of allOwnedElements(post, identity)) {
    for (const attribute of COUNT_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      const count = parsePositiveIndex(value);
      if (count !== null) counts.add(count);
    }
    const testId = element.getAttribute('data-testid') ?? '';
    for (const attribute of ['aria-label', 'aria-description', 'data-testid']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      if (attribute === 'data-testid' && !/carousel|photo|image|media/i.test(testId)) continue;
      const count = parseCountHint(value);
      if (count !== null) counts.add(count);
    }
  }
  return counts.size === 1 ? { count: [...counts][0], conflict: false } : { count: null, conflict: counts.size > 1 };
}

function isCarousel(post: HTMLElement, identity: PostIdentity, photoLinkIndices: number[]): boolean {
  if (photoLinkIndices.some(index => index > 1)) return true;
  return allOwnedElements(post, identity).some(element => {
    const testId = element.getAttribute('data-testid') ?? '';
    const role = element.getAttribute('aria-roledescription') ?? '';
    const label = `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('aria-description') ?? ''}`;
    return /carousel/i.test(testId) || /^carousel$/i.test(role) || /(?:next|previous|다음|이전)\s*(?:photo|image|사진)/i.test(label);
  });
}

function parseSrcset(value: string | null): string[] {
  if (!value) return [];
  return value.split(',').map(candidate => candidate.trim().split(/\s+/)[0]).filter(Boolean);
}

function firstAllowedSource(values: Array<{ value: string | null; ready: boolean }>): MediaSource | null {
  for (const candidate of values) {
    if (candidate.value && isAllowedImageUrl(candidate.value)) return { url: candidate.value, ready: candidate.ready };
  }
  return null;
}

function readMediaSource(wrapper: HTMLElement, post: HTMLElement): MediaSource | null {
  const rendered: Array<{ value: string | null; ready: boolean }> = [];
  const lazy: Array<{ value: string | null; ready: boolean }> = [];
  for (const image of Array.from(wrapper.querySelectorAll('img'))) {
    if (!belongsToPost(image, post) || image.closest(EXCLUDED_SOURCE_SELECTORS)) continue;
    const current = (image as HTMLImageElement).currentSrc;
    rendered.push({ value: current || null, ready: true });
    rendered.push({ value: image.getAttribute('src'), ready: true });
    rendered.push(...parseSrcset(image.getAttribute('srcset')).map(value => ({ value, ready: false })));
    for (const attribute of ['data-src', 'data-original', 'data-image-url']) {
      lazy.push({ value: image.getAttribute(attribute), ready: false });
    }
  }
  for (const source of Array.from(wrapper.querySelectorAll('source[srcset]'))) {
    if (!belongsToPost(source, post) || source.closest(EXCLUDED_SOURCE_SELECTORS)) continue;
    lazy.push(...parseSrcset(source.getAttribute('srcset')).map(value => ({ value, ready: false })));
  }
  for (const anchor of Array.from(wrapper.querySelectorAll('a[href]'))) {
    if (belongsToPost(anchor, post)) lazy.push({ value: anchor.getAttribute('href'), ready: false });
  }
  return firstAllowedSource([...rendered, ...lazy]);
}

function photoLinkIndices(post: HTMLElement, identity: PostIdentity): number[] {
  return Array.from(post.querySelectorAll('a[href*="/photo/"]'))
    .filter(anchor => belongsToPostIdentity(anchor, post, identity) && !statusRoleLinkBoundary(anchor, post))
    .map(anchor => statusLinkInfo(anchor.getAttribute('href'))?.photoIndex ?? null)
    .filter((index): index is number => index !== null);
}

function getPhotoIndex(slot: PhotoSlot): number | null {
  return slot.explicitIndex;
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function stableMediaIdentity(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/:[a-z0-9_-]+$/i, '');
    url.searchParams.delete('name');
    const params = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    url.search = '';
    for (const [key, parameter] of params) url.searchParams.append(key, parameter);
    return url.toString();
  } catch {
    return value;
  }
}

function assignIndices(slots: PhotoSlot[]): number[] {
  const reserved = new Set(slots.map(slot => slot.explicitIndex).filter((index): index is number => index !== null));
  const used = new Set<number>();
  let next = 1;
  return slots.map(slot => {
    if (slot.explicitIndex !== null) {
      used.add(slot.explicitIndex);
      next = Math.max(next, slot.explicitIndex + 1);
      return slot.explicitIndex;
    }
    while (reserved.has(next) || used.has(next)) next += 1;
    const index = next++;
    used.add(index);
    return index;
  });
}

function isContiguous(indices: number[], count: number): boolean {
  if (indices.length !== count) return false;
  const actual = new Set(indices);
  for (let index = 1; index <= count; index += 1) if (!actual.has(index)) return false;
  return actual.size === count;
}

export function readPostSnapshot(post: HTMLElement): PostReadResult | null {
  if (!post.matches(X_SELECTORS.post) || findOwningPost(post) !== post) return null;
  const identity = readPostIdentity(post);
  const wrappers = elementsWithin<HTMLElement>(post, X_SELECTORS.photo)
    .filter(wrapper => belongsToPostIdentity(wrapper, post, identity) && !wrapper.closest(EXCLUDED_SOURCE_SELECTORS));
  if (wrappers.length === 0) return null;

  const linkIndices = photoLinkIndices(post, identity);
  const expectedHint = readExpectedCount(post, identity);
  const slots: PhotoSlot[] = wrappers.map(wrapper => ({
    wrapper,
    explicitIndex: readExplicitIndex(wrapper, post, identity),
    source: readMediaSource(wrapper, post),
  }));
  const indices = assignIndices(slots);
  const seenIndices = new Set<number>();
  const duplicateIndex = indices.some(index => {
    if (seenIndices.has(index)) return true;
    seenIndices.add(index);
    return false;
  });

  const postSignature = [identity.authorHandle ?? '', identity.bodyText, ...slots.map((slot, index) => `${indices[index]}:${slot.source?.url ?? 'pending'}`)].join('|');
  const postKey = identity.postId ? `x:status:${identity.postId}` : `x:post:${hash(postSignature)}`;

  const photos: PhotoAsset[] = [];
  const photoTargets = new Map<string, HTMLElement>();
  const unresolvedSlots = slots.some(slot => !slot.source || !slot.source.ready);
  const usedAssetKeys = new Set<string>();
  slots.forEach((slot, slotIndex) => {
    if (!slot.source) return;
    const index = indices[slotIndex];
    const info = getStaticImageUrlInfo(slot.source.url);
    if (!info) return;
    const key = `${postKey}:photo:${index}:${hash(stableMediaIdentity(slot.source.url))}`;
    if (usedAssetKeys.has(key)) return;
    usedAssetKeys.add(key);
    photos.push({
      key,
      kind: 'image',
      index,
      originalFilename: info.originalFilename,
      extension: info.extension as StaticImageExtension,
      displayedUrl: slot.source.url,
      originalUrl: info.originalUrl,
    });
    photoTargets.set(key, slot.wrapper);
  });
  if (photos.length === 0) return null;

  const carousel = isCarousel(post, identity, linkIndices) || slots.length > 1;
  const allLinkIndices = [...new Set(linkIndices)].sort((a, b) => a - b);
  const fullPhotoLinkSequence = allLinkIndices.length > 1 && isContiguous(allLinkIndices, allLinkIndices.length);
  let expectedPhotoCount = expectedHint.conflict ? null : expectedHint.count;
  if (expectedPhotoCount === null && fullPhotoLinkSequence
    && slots.length === allLinkIndices.length && photos.length === allLinkIndices.length) {
    expectedPhotoCount = allLinkIndices.length;
  }
  if (expectedPhotoCount === null && !expectedHint.conflict && !carousel
    && photos.length === slots.length && !unresolvedSlots && !duplicateIndex
    && isContiguous(indices, slots.length)) {
    expectedPhotoCount = slots.length;
  }
  if (expectedPhotoCount === null && !expectedHint.conflict && slots.length === 1
    && photos.length === 1 && !carousel && indices[0] === 1 && linkIndices.every(index => index === 1)) {
    expectedPhotoCount = 1;
  }

  const hasIndexedGap = (indices.some(index => index > 1) && !isContiguous(indices, Math.max(...indices)))
    || (allLinkIndices.length > slots.length)
    || (carousel && expectedPhotoCount === null && !fullPhotoLinkSequence);
  let completeness: PostSnapshot['completeness'];
  if (expectedPhotoCount !== null) {
    completeness = photos.length === expectedPhotoCount
      && slots.length === expectedPhotoCount
      && !unresolvedSlots
      && !duplicateIndex
      && isContiguous(indices, expectedPhotoCount)
      ? 'complete'
      : 'partial';
  } else {
    completeness = expectedHint.conflict || unresolvedSlots || duplicateIndex || hasIndexedGap ? 'partial' : 'unknown';
  }

  photos.sort((left, right) => left.index - right.index);
  const snapshot: PostSnapshot = {
    key: postKey,
    postId: identity.postId,
    authorHandle: identity.authorHandle,
    photos,
    expectedPhotoCount,
    completeness,
  };
  const fingerprint = JSON.stringify({
    key: snapshot.key,
    postId: snapshot.postId,
    authorHandle: snapshot.authorHandle,
    expectedPhotoCount: snapshot.expectedPhotoCount,
    completeness: snapshot.completeness,
    bodyText: identity.bodyText,
    photos: snapshot.photos.map(photo => [photo.key, photo.index, photo.displayedUrl, photo.originalUrl]),
  });
  return { snapshot, photoTargets, fingerprint };
}
