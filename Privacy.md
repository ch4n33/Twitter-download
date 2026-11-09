# Privacy Policy

Last updated: November 9, 2026

## Collecting and Using Your Personal Data

### Types of Data Collected

The extension reads information visible in posts on `x.com` to locate static photos. This may include the author's handle, post ID, photo URLs, photo order, and available photo count. If a post ID is unavailable, the extension temporarily processes visible post text and photo identifiers in memory to create a fallback hash. The post text itself is not stored, though the resulting hash may be included as a post identifier in a temporary download job record.

This information is used to identify the photos you select and build their save paths and filenames. Photo files are downloaded through Chrome directly from X's image host to your device. The extension does not send post information, settings, photos, or download job records to a developer-operated server. It has no backend, analytics, advertising, or tracking code. The extension is independent and is not affiliated with or endorsed by X Corp.

The extension's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

Settings you choose—including a subfolder, date or author folder grouping, filename mode, and image size—are stored in Chrome's extension-local `chrome.storage.local`. Download job state is held temporarily in `chrome.storage.session`. A job record may contain a post identifier or fallback hash, photo keys and order, the intended save path, an extension-generated request ID, browser tab and frame IDs, a Chrome download ID, timestamps, and status or error details. Job records do not contain photo URLs or the original post text.

Completed, partially completed, and failed job records are retained for up to one hour, with no more than 50 terminal records kept. Expired records are removed the next time job data is accessed. Active job state is temporary session data, not permanent download history. Downloaded files and Chrome's own download history are managed according to Chrome's settings.

Local settings are removed when the extension is uninstalled. Session records are cleared when the browser session ends.

## Children's Privacy

The extension does not collect or transmit personal information to the developer, including information about children. The processing described above takes place locally in your browser.

## Changes to this Privacy Policy

This policy may be updated from time to time. Updates will be posted on this page with a revised date and take effect when posted.

## Contact Us

For questions about this Privacy Policy, please use [GitHub Issues](https://github.com/ch4n33/Twitter-download/issues). Issues are public; do not include account details, private post content, passwords, or authentication tokens.
