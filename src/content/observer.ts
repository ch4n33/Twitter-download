import { findOwningPost, X_SELECTORS } from '../x/selectors';

const OWNED_CONTROL_SELECTOR = '[data-x-download-control]';
const OBSERVED_ATTRIBUTES = [
  'src', 'srcset', 'data-src', 'data-original', 'data-image-url',
  'data-testid', 'aria-label', 'aria-description', 'aria-roledescription', 'href',
  'data-photo-count', 'data-image-count', 'data-media-count', 'data-count',
  'data-photo-index', 'data-image-index', 'data-media-index', 'data-index',
  'data-screen-name', 'data-username',
];

export interface PostMutationObserverOptions {
  document: Document;
  onPostChanged(post: HTMLElement): void;
  onPostRemoved(post: HTMLElement): void;
}

/** Watches only affected X post trees and ignores mutations made by our controls. */
export class PostMutationObserver {
  private readonly knownPosts = new Set<HTMLElement>();
  private observer: MutationObserver | null = null;

  constructor(private readonly options: PostMutationObserverOptions) {}

  start(): void {
    if (this.observer) return;
    const root = this.options.document.documentElement;
    if (!root) return;
    const MutationObserverConstructor = this.options.document.defaultView?.MutationObserver
      ?? globalThis.MutationObserver;
    if (!MutationObserverConstructor) return;
    this.observer = new MutationObserverConstructor(records => this.onMutations(records));
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
    for (const post of Array.from(root.querySelectorAll<HTMLElement>(X_SELECTORS.post))) {
      this.knownPosts.add(post);
      this.options.onPostChanged(post);
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const post of this.knownPosts) this.options.onPostRemoved(post);
    this.knownPosts.clear();
  }

  private onMutations(records: MutationRecord[]): void {
    const changed = new Set<HTMLElement>();
    for (const record of records) {
      if (this.isOwnedControlMutation(record)) continue;
      this.collectOwningPost(record.target, changed);
      for (const node of Array.from(record.addedNodes)) this.collectAffectedPosts(node, changed);
      for (const node of Array.from(record.removedNodes)) this.collectAffectedPosts(node, changed);
    }

    for (const post of [...this.knownPosts]) {
      if (!post.isConnected) {
        this.knownPosts.delete(post);
        this.options.onPostRemoved(post);
      }
    }

    for (const post of changed) {
      if (!post.isConnected) continue;
      this.knownPosts.add(post);
      this.options.onPostChanged(post);
    }
  }

  private collectOwningPost(node: Node, result: Set<HTMLElement>): void {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    if (!element) return;
    const ownPost = element.matches(X_SELECTORS.post)
      ? element as HTMLElement
      : findOwningPost(element);
    if (ownPost) result.add(ownPost);
  }

  private collectAffectedPosts(node: Node, result: Set<HTMLElement>): void {
    this.collectOwningPost(node, result);
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    if (!element) return;
    for (const candidate of Array.from(element.querySelectorAll<HTMLElement>(X_SELECTORS.post))) {
      result.add(candidate);
    }
  }

  private isOwnedControlMutation(record: MutationRecord): boolean {
    const target = record.target.nodeType === 1
      ? record.target as Element
      : record.target.parentElement;
    if (target?.closest(OWNED_CONTROL_SELECTOR)) return true;

    const added = Array.from(record.addedNodes);
    const removed = Array.from(record.removedNodes);
    return added.length > 0 && removed.length === 0 && added.every(node => {
      if (node.nodeType !== 1) return false;
      const element = node as Element;
      return element.matches(OWNED_CONTROL_SELECTOR) || Boolean(element.querySelector(OWNED_CONTROL_SELECTOR));
    });
  }
}

export function observePosts(options: PostMutationObserverOptions): PostMutationObserver {
  const observer = new PostMutationObserver(options);
  observer.start();
  return observer;
}
