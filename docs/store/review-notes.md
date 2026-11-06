# Chrome Web Store review notes

## Single purpose

Save static photos attached to posts currently displayed on X to the user's Chrome Downloads folder. The extension provides per-photo and complete-post saving when the full photo list is available, with local image-size, folder, and filename settings.

## Permissions and site access

- `downloads`: start user-selected image downloads and read Chrome's progress, completion, failure, and MIME status.
- `storage`: keep user settings in extension-local storage and temporary download-job state in session storage.
- `https://x.com/*`: inspect the visible post DOM to locate static photos and place the save controls beside them. The extension does not need access to unrelated websites.

## Remote code

No remote code is used. Executable JavaScript, CSS, and UI assets are packaged with the extension. The extension does not load scripts from a server or use `eval`/dynamic code generation. Photo bytes are requested through Chrome's Downloads API from X's media host; this is the product's user-requested download behavior, not remotely loaded executable code.

## Reviewer walkthrough

1. Use Chrome 123 or later and open `x.com` with posts visible.
2. Try a post with one static photo, then a post with multiple photos. Use the per-photo control and, when shown, the whole-post control.
3. Open the extension popup to review size, folder, and filename settings.

If X requires sign-in to show the relevant posts, use a reviewer-managed account and sign in directly to X. Do not request or share the user's password, authentication token, or session cookies.

## Privacy and support

- Public privacy policy: <https://raw.githubusercontent.com/ch4n33/Twitter-download/main/Privacy.md>
- Support: <https://github.com/ch4n33/Twitter-download/issues>
- Page information is processed locally to provide the requested photo-saving feature. The extension sends no post information or settings to a developer-operated backend and includes no analytics or advertising.
- Complete the Web Store dashboard's current data-handling declarations based on its own definitions and the shipped behavior. These notes do not decide whether the dashboard classifies locally processed page content as collection.
