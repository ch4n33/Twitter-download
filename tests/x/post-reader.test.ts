// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readPostSnapshot } from '../../src/x/post-reader';
import { findBulkMount, findPhotoMount } from '../../src/x/mount-points';
import { X_SELECTORS } from '../../src/x/selectors';

const fixture = readFileSync(resolve(process.cwd(), 'tests/fixtures/x/timeline-post.html'), 'utf8');

function mountFixture(): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = fixture;
  const post = host.querySelector<HTMLElement>(X_SELECTORS.post);
  if (!post) throw new Error('fixture has no tweet article');
  return post;
}

function read(post: HTMLElement) {
  const result = readPostSnapshot(post);
  if (!result) throw new Error('expected a readable image post');
  return result;
}

function photoWrappers(post: HTMLElement): HTMLElement[] {
  return Array.from(post.querySelectorAll<HTMLElement>(X_SELECTORS.photo));
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('readPostSnapshot', () => {
  it.each([1, 2, 3, 4])('reads a complete static post with %i photos from canonical photo links', count => {
    const post = mountFixture();
    const wrappers = photoWrappers(post);
    for (const wrapper of wrappers.slice(count)) wrapper.remove();
    if (count === 1) {
      const carousel = post.querySelector('[data-testid="carousel"]');
      carousel?.removeAttribute('data-testid');
      carousel?.removeAttribute('aria-roledescription');
    }

    const result = read(post);
    expect(result.snapshot.postId).toBe('9001001');
    expect(result.snapshot.authorHandle).toBe('@sample_author');
    expect(result.snapshot.expectedPhotoCount).toBe(count);
    expect(result.snapshot.completeness).toBe('complete');
    expect(result.snapshot.photos.map(photo => photo.index)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(result.snapshot.photos).toHaveLength(count);
  });

  it('prefers canonical /photo/n links to ambiguous data-index values after carousel reorder', () => {
    const post = mountFixture();
    const wrappers = photoWrappers(post);
    wrappers.forEach((wrapper, index) => wrapper.setAttribute('data-index', String(index)));
    const carousel = post.querySelector('[data-testid="carousel"]');
    if (!carousel) throw new Error('fixture has no carousel');
    wrappers.reverse().forEach(wrapper => carousel.append(wrapper));

    const result = read(post);
    expect(result.snapshot.photos.map(photo => [photo.index, photo.originalFilename])).toEqual([
      [1, 'CoastSceneA.jpg'],
      [2, 'RidgeSceneB.jpeg'],
      [3, 'LakeSceneC.png'],
      [4, 'FieldSceneD.webp'],
    ]);
    expect(result.snapshot.completeness).toBe('complete');
    expect(result.snapshot.expectedPhotoCount).toBe(4);
  });

  it('does not treat generic data-index as an original attachment index', () => {
    const post = mountFixture();
    const wrappers = photoWrappers(post).slice(0, 2);
    wrappers.forEach((wrapper, index) => {
      wrapper.setAttribute('data-index', String(index + 1));
      wrapper.querySelector('a.photo-link')?.removeAttribute('href');
    });
    const carousel = post.querySelector('[data-testid="carousel"]');
    if (!carousel) throw new Error('fixture has no carousel');
    for (const wrapper of photoWrappers(post).slice(2)) wrapper.remove();
    carousel.removeAttribute('aria-roledescription');
    carousel.setAttribute('data-testid', 'tweetPhotos');

    const result = read(post);
    expect(result.snapshot.expectedPhotoCount).toBeNull();
    expect(result.snapshot.completeness).toBe('partial');
  });

  it('filters an unmarked quote role-link by its different status owner', () => {
    const post = mountFixture();
    const quote = document.createElement('div');
    quote.setAttribute('role', 'link');
    quote.setAttribute('tabindex', '0');
    quote.innerHTML = `
      <a href="/quoted_author/status/8102002"><time datetime="2026-11-05T22:00:00.000Z">4h</time></a>
      <div aria-roledescription="carousel" aria-label="Photo 1 of 4">
        <div data-testid="tweetPhoto">
          <a href="/quoted_author/status/8102002/photo/1">
            <img src="https://pbs.twimg.com/media/QuotedPictureE.avif?format=avif&amp;name=small" alt="Quoted picture">
          </a>
        </div>
      </div>`;
    post.insertBefore(quote, post.querySelector('[role="group"]'));

    const result = read(post);
    expect(result.snapshot.postId).toBe('9001001');
    expect(result.snapshot.expectedPhotoCount).toBe(4);
    expect(result.snapshot.completeness).toBe('complete');
    expect(result.snapshot.photos.map(photo => photo.originalFilename)).toEqual([
      'CoastSceneA.jpg', 'RidgeSceneB.jpeg', 'LakeSceneC.png', 'FieldSceneD.webp',
    ]);
    expect(result.snapshot.photos.some(photo => photo.originalFilename === 'QuotedPictureE.avif')).toBe(false);
  });

  it('does not read a nested tweet article inside a status role-link as a separate post', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div role="link" tabindex="0">
        <a href="/quoted_author/status/8102002"><time>Quoted post</time></a>
        <article data-testid="tweet">
          <div data-testid="User-Name"><a href="/quoted_author">Quoted Author</a><span>@quoted_author</span></div>
          <a href="/quoted_author/status/8102002"><time>4h</time></a>
          <div data-testid="tweetPhoto">
            <a href="/quoted_author/status/8102002/photo/1">
              <img src="https://pbs.twimg.com/media/QuotedPictureE.avif?format=avif&amp;name=small">
            </a>
          </div>
          <div role="group">
            <button data-testid="reply"></button><button data-testid="retweet"></button>
            <button data-testid="like"></button><button data-testid="bookmark"></button>
            <button type="button" role="button" aria-label="Share">Share</button>
          </div>
        </article>
      </div>`;
    const quotedPost = host.querySelector<HTMLElement>(X_SELECTORS.post);
    if (!quotedPost) throw new Error('fixture has no nested tweet article');

    expect(readPostSnapshot(quotedPost)).toBeNull();
    expect(findBulkMount(quotedPost)).toBeNull();
  });

  it('marks a lazy photo placeholder as partial instead of a complete photo list', () => {
    const post = mountFixture();
    for (const wrapper of photoWrappers(post).slice(1)) wrapper.remove();
    const image = post.querySelector<HTMLImageElement>('img');
    if (!image) throw new Error('fixture has no photo image');
    const source = image.getAttribute('src');
    if (!source) throw new Error('fixture image needs a source');
    image.removeAttribute('src');
    image.setAttribute('data-src', source);
    const carousel = post.querySelector('[data-testid="carousel"]');
    carousel?.removeAttribute('aria-roledescription');
    carousel?.removeAttribute('data-testid');

    const result = read(post);
    expect(result.snapshot.expectedPhotoCount).toBe(1);
    expect(result.snapshot.completeness).toBe('partial');
  });

  it('uses the currently rendered carousel total as a hint, not the visible slide count', () => {
    const post = mountFixture();
    for (const wrapper of photoWrappers(post).slice(1)) wrapper.remove();
    const carousel = post.querySelector('[data-testid="carousel"]');
    if (!carousel) throw new Error('fixture has no carousel');
    carousel.setAttribute('aria-label', 'Photo 1 of 4');

    const result = read(post);
    expect(result.snapshot.photos).toHaveLength(1);
    expect(result.snapshot.expectedPhotoCount).toBe(4);
    expect(result.snapshot.completeness).toBe('partial');
  });

  it('ignores avatar, link preview, and video poster images outside owned tweetPhoto wrappers', () => {
    const post = mountFixture();
    for (const wrapper of photoWrappers(post).slice(1)) wrapper.remove();
    post.insertAdjacentHTML('afterbegin', '<img alt="avatar" src="https://pbs.twimg.com/media/Avatar.jpg?format=jpg">');
    post.insertAdjacentHTML('beforeend', '<div data-testid="card.wrapper"><img alt="link preview" src="https://pbs.twimg.com/media/Preview.jpg?format=jpg"></div>');
    post.insertAdjacentHTML('beforeend', '<div data-testid="videoPlayer"><div data-testid="tweetPhoto"><img alt="video poster" src="https://pbs.twimg.com/media/VideoPoster.jpg?format=jpg"></div></div>');

    const result = read(post);
    expect(result.snapshot.photos).toHaveLength(1);
    expect(result.snapshot.photos[0].originalFilename).toBe('CoastSceneA.jpg');
  });
});

describe('X mount points', () => {
  it('finds the reaction row with a testid-free share after bookmark without reordering native controls', () => {
    const post = mountFixture();
    const reaction = post.querySelector<HTMLElement>('[role="group"]');
    const wrapper = photoWrappers(post)[0];

    expect(findBulkMount(post)).toBe(reaction);
    expect(findPhotoMount(wrapper)).toBe(wrapper);

    if (!reaction) throw new Error('fixture has no reaction group');
    expect(Array.from(reaction.children).map(child => child.getAttribute('aria-label'))).toEqual([
      'Reply', 'Repost', 'Like', 'Bookmark', 'Share',
    ]);
    const extensionControl = document.createElement('button');
    extensionControl.setAttribute('aria-label', 'Save all photos');
    reaction.append(extensionControl);
    expect(Array.from(reaction.children).map(child => child.getAttribute('aria-label'))).toEqual([
      'Reply', 'Repost', 'Like', 'Bookmark', 'Share', 'Save all photos',
    ]);
  });

  it('does not select a role-link quote reaction group as the bulk mount', () => {
    const post = mountFixture();
    const ownReaction = post.querySelector('[role="group"]');
    const quote = document.createElement('div');
    quote.setAttribute('role', 'link');
    quote.innerHTML = `
      <a href="/quoted_author/status/8102002"><time>Quoted post</time></a>
      <div data-testid="tweetPhoto">
        <a href="/quoted_author/status/8102002/photo/1">
          <img src="https://pbs.twimg.com/media/QuotedPictureE.avif?format=avif&amp;name=small">
        </a>
      </div>
      <div role="group">
        <button data-testid="reply"></button><button data-testid="retweet"></button>
        <button data-testid="like"></button><button data-testid="bookmark"></button>
        <button type="button" role="button" aria-label="Share">Share</button>
      </div>`;
    post.insertBefore(quote, ownReaction);

    expect(findBulkMount(post)).toBe(ownReaction);
    const quotedPhoto = quote.querySelector<HTMLElement>(X_SELECTORS.photo);
    expect(quotedPhoto ? findPhotoMount(quotedPhoto) : null).toBeNull();
  });
});
