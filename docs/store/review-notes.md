# Chrome Web Store review notes

## Single purpose

Save photos and resolvable direct-MP4 video/GIF attachments from posts on X to the user's Chrome Downloads folder. The extension provides per-attachment and complete-post saving when the full media list is resolved, with local photo-size, folder, filename and GIF-format settings. In 0.3.0, animated GIF attachments are converted locally from MP4 to actual GIF by default; disabling the option preserves MP4. Ordinary videos are unaffected. HLS assembly and live recording are unsupported.

## Permissions and site access

- `downloads`: start user-selected media downloads and read Chrome's progress, completion, failure, and MIME status.
- `storage`: keep user settings in extension-local storage and temporary download-job state in session storage.
- `offscreen`: host a packaged hidden extension document, its GIF conversion Worker and temporary result Blob URLs. The popup may close while conversion continues. Results remain alive through native download completion and are then released.
- `https://video.twimg.com/*` host permission: fetch MP4 input bytes for the user's requested local GIF conversion. The request omits credentials, validates the exact X video host and supported paths, enforces size/time limits, and does not contact a conversion server.
- `https://x.com/*`: inspect the post DOM and known post-data responses already received by the page, extracting only normalized media metadata. An early packaged MAIN-world script and an isolated content script exchange that metadata locally. The extension does not read request headers, authentication tokens, or cookies, issue additional X API requests, or need access to unrelated websites. No debugger, webRequest, scripting, or native-messaging permissions are requested.

## Remote code

No remote code is used. Executable JavaScript, CSS, and UI assets are packaged with the extension. The extension does not load scripts from a server or use `eval`/dynamic code generation. Media bytes are requested through Chrome's Downloads API from X's exact image/video media hosts; this is the product's user-requested download behavior, not remotely loaded executable code. Google Material Symbols license text and adaptation notices ship in the package.

## Reviewer walkthrough

1. Use Chrome 123 or later and open `x.com` with posts visible.
2. Refresh the X tab after loading the extension. Try a post with one static photo, then multiple photos, a GIF, a direct-MP4 video, and a mixed-media post. Use per-attachment or whole-post saving. A missing MP4 keeps whole-post saving disabled rather than saving a poster.
3. Confirm completion text disappears after two seconds, successful attachments retain their compact saved icon, and errors remain visible. These markers are current-page memory only and reset on refresh.
4. Open the extension popup to review photo size, folder, filename and GIF output settings. Confirm the GIF option defaults ON, an animated GIF yields a looping .gif file, turning it OFF yields MP4, and a normal video remains MP4. Close the popup during conversion and confirm the conversion continues.

If X requires sign-in to show the relevant posts, use a reviewer-managed account and sign in directly to X. Do not request or share the user's password, authentication token, or session cookies.

## Privacy and support

- Public privacy policy: <https://raw.githubusercontent.com/ch4n33/Twitter-download/main/Privacy.md>
- Support: <https://github.com/ch4n33/Twitter-download/issues>
- Page information is processed locally to provide the requested media-saving feature. The extension sends no post information or settings to a developer-operated backend and includes no analytics or advertising.
- Complete the Web Store dashboard's current data-handling declarations based on its own definitions and the shipped behavior. These notes do not decide whether the dashboard classifies locally processed page content as collection.
