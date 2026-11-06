export const X_SELECTORS = {
  post: 'article[data-testid="tweet"]',
  quote: '[data-testid="quoteTweet"], [data-testid="quotedTweet"], [data-testid="quotedTweetContainer"]',
  photo: '[data-testid="tweetPhoto"]',
  tweetText: '[data-testid="tweetText"]',
  userName: '[data-testid="User-Name"]',
  reply: '[data-testid="reply"]',
  repost: '[data-testid="retweet"], [data-testid="unretweet"]',
  like: '[data-testid="like"], [data-testid="unlike"]',
  share: '[data-testid="share"], [data-testid="shareButton"]',
  video: '[data-testid*="video"], [data-testid*="Video"], [data-testid*="gif"], [data-testid*="GIF"]',
} as const;

export function isInsideQuote(element: Element, owningPost?: Element): boolean {
  const quote = element.closest(X_SELECTORS.quote);
  if (!quote) return false;
  return !owningPost || quote !== owningPost;
}

export function belongsToPost(element: Element, post: HTMLElement): boolean {
  return element.closest(X_SELECTORS.post) === post && !isInsideQuote(element, post);
}

function isInsideStatusRoleLink(element: Element): boolean {
  let ancestor = element.parentElement;
  while (ancestor) {
    if (ancestor.matches('[role="link"]') && ancestor.tagName !== 'A'
      && ancestor.querySelector('a[href*="/status/"]')) return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}

export function findOwningPost(element: Element): HTMLElement | null {
  const post = element.closest(X_SELECTORS.post);
  if (!post || post.nodeType !== 1 || isInsideQuote(post) || isInsideStatusRoleLink(post)) return null;
  return post as HTMLElement;
}
