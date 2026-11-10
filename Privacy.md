# Privacy Policy

Last updated: November 10, 2026

## Collecting and Using Your Personal Data

### Types of Data Collected

The extension reads post elements on `x.com` and temporarily inspects known post-data responses already received by the page to locate photos and direct MP4 videos or animated GIFs. It extracts post and media identifiers, media types, file URLs, attachment order, count, and video bitrate information. It does not read request headers, cookies, or authentication tokens or make additional X API requests. Normalized media metadata is held only in bounded page memory. Response bodies and post text are not persisted. If a post ID is unavailable, the extension temporarily processes visible post text and photo identifiers in memory to create a fallback hash. That hash may be included as a post identifier in a temporary download job record.

This information is used to identify the attachments you select and build their save paths and filenames. Files are saved through Chrome from X's media hosts (`pbs.twimg.com` or `video.twimg.com`) to your device. By default, animated GIF attachments are fetched as MP4 from `video.twimg.com` and converted into actual GIF files locally in a hidden extension document and Worker. This byte fetch does not include cookies or authentication headers. Turning off GIF conversion saves the MP4 directly. Source bytes, conversion state and the generated GIF blob URL are held temporarily in extension memory and released when no longer needed for the download. The extension requests the `offscreen` permission and access only to `https://video.twimg.com/*` for this processing. The extension does not send post information, settings, media, or download job records to a developer-operated server. It has no backend, analytics, advertising, or tracking code. The extension is independent and is not affiliated with or endorsed by X Corp.

The extension's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

Settings you choose—including a subfolder, date or author folder grouping, filename mode, image size and GIF output format—are stored in Chrome's extension-local `chrome.storage.local`. Download job state is held temporarily in `chrome.storage.session`. A job record may contain a post identifier or fallback hash, media keys, input types, output formats and order, the intended save path, an extension-generated request ID, browser tab and frame IDs, a Chrome download ID, timestamps, conversion progress, and status or error details. Job records do not contain media URLs, media bytes, blob URLs, or the original post text. Successful attachment indicators are kept in current-page memory for up to 200 recent posts; refreshing the page clears them. They are not permanent download history.

Completed, partially completed, and failed job records are retained for up to one hour, with no more than 50 terminal records kept. Expired records are removed the next time job data is accessed. Active job state is temporary session data, not permanent download history. Downloaded files and Chrome's own download history are managed according to Chrome's settings.

Local settings are removed when the extension is uninstalled. Session records are cleared when the browser session ends.

## Children's Privacy

The extension does not collect or transmit personal information to the developer, including information about children. The processing described above takes place locally in your browser.

## Changes to this Privacy Policy

This policy may be updated from time to time. Updates will be posted on this page with a revised date and take effect when posted.

## Contact Us

For questions about this Privacy Policy, please use [GitHub Issues](https://github.com/ch4n33/Twitter-download/issues). Issues are public; do not include account details, private post content, passwords, or authentication tokens.
