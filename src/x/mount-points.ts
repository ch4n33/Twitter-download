import { belongsToPost, findOwningPost, X_SELECTORS } from './selectors';

const REQUIRED_REACTION_CONTROLS = [X_SELECTORS.reply, X_SELECTORS.repost, X_SELECTORS.like] as const;
const EXCLUDED_MEDIA = '[data-testid*="video"], [data-testid*="Video"], [data-testid*="gif"], [data-testid*="GIF"]';

function hasOwnedControl(group: Element, selector: string, post: HTMLElement): boolean {
  return Array.from(group.querySelectorAll(selector)).some(control =>
    belongsToPost(control, post) && control.closest('[role="group"]') === group);
}

function isInsideStatusRoleLink(element: Element, post: HTMLElement): boolean {
  let ancestor: Element | null = element;
  while (ancestor && ancestor !== post) {
    if (ancestor.matches('[role="link"]') && ancestor.tagName !== 'A'
      && ancestor.querySelector('a[href*="/status/"]')) return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}

/** Find X's native reaction row without relying on a share-button test id. */
export function findBulkMount(post: HTMLElement): HTMLElement | null {
  if (!post.matches(X_SELECTORS.post) || findOwningPost(post) !== post) return null;

  const groups = Array.from(post.querySelectorAll<HTMLElement>('[role="group"]'))
    .filter(group => belongsToPost(group, post) && !isInsideStatusRoleLink(group, post))
    .filter(group => REQUIRED_REACTION_CONTROLS.every(selector => hasOwnedControl(group, selector, post)));
  if (groups.length === 0) return null;

  const explicitShareGroup = groups.find(group => hasOwnedControl(group, X_SELECTORS.share, post));
  return explicitShareGroup ?? groups[0];
}

/** Use an owned X image or direct-video wrapper as an overlay host for the per-media control. */
export function findPhotoMount(wrapper: HTMLElement): HTMLElement | null {
  const isPhoto = wrapper.matches(X_SELECTORS.photo);
  const isVideo = wrapper.matches(X_SELECTORS.videoMount) || wrapper.matches(X_SELECTORS.videoElement);
  if ((!isPhoto && !isVideo) || (isPhoto && wrapper.closest(EXCLUDED_MEDIA))) return null;
  const post = findOwningPost(wrapper);
  return post && belongsToPost(wrapper, post) && !isInsideStatusRoleLink(wrapper, post) ? wrapper : null;
}
