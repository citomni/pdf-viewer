# citomni/pdf-viewer

Sandboxed document viewer for CitOmni apps: shows PDF, JPEG and PNG documents, extracts
the text with positions, and runs OCR on pages without usable text. PDF.js 6.4 and
Tesseract.js 7 run in an `<iframe sandbox="allow-scripts">` on the app's own domain.

Documents never leave the user's browser as part of the viewer's work: no cloud OCR, no
CDN, no third-party host. Every file the viewer needs ships in this package and is served
by the app itself.

- Repository: https://github.com/citomni/pdf-viewer
- Security model and test results: [`docs/security.md`](docs/security.md)
- Updating PDF.js / Tesseract.js: [`docs/maintenance.md`](docs/maintenance.md)


## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Integrate](#integrate)
- [Text output](#text-output)
- [Events and error codes](#events-and-error-codes)
- [Configuration](#configuration)
- [What the app must do (security)](#what-the-app-must-do-security)
- [Browser support](#browser-support)
- [Hosting and deploy](#hosting-and-deploy)
- [Tests](#tests)
- [License](#license)


## How it works

```
Host page (your controller, your template, your origin)
 └─ PdfViewerHost  (assets/host/pdf-viewer.mjs)
     ├─ fetches the document from your route (same origin, with the session cookie)
     └─ <iframe sandbox="allow-scripts" src="/_pdf-viewer/frame/{key}#n={nonce}">
          Reader frame: opaque origin, strict CSP, no cookies, no storage
          ├─ PDF.js: display, text layer, decoders (classic blob worker)
          └─ Tesseract.js: OCR, dan + eng (classic blob worker)
```

- **One frame per document.** The host creates a new frame for every document and removes
  the old one. A frame receives exactly one document.
- **Handshake.** The frame posts `ready` with the nonce from its URL fragment to the app
  origin; the host answers with `connect` and a `MessagePort`. The document bytes are
  transferred over the port. The frame can report progress, text and errors; it has no
  way to make the host fetch anything or act in the app.
- **Two routes**, both served by this package and neither touching sessions or cookies:

  | Route | Purpose |
  |---|---|
  | `/_pdf-viewer/frame/{key}` | The frame document. CSP `sandbox allow-scripts`, `no-store`. |
  | `/_pdf-viewer/assets/{key}/{path}` | Reader code, host module, PDF.js, Tesseract.js, language data. Exact manifest lookup, `public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *`. |

  `{key}` is the bundle key: a hash over every served file and the frame template. Any
  change gives new URLs, so the immutable responses never go stale.
- **Text.** Pages with a usable text layer give their text items; pages without one are
  OCR'ed (first and last page automatically, any page on request).


## Requirements

- PHP 8.5+, `citomni/kernel`, `citomni/http` (which needs `ext-intl`).
- HTTPS in production.
- `http.base_url` (or `CITOMNI_PUBLIC_ROOT_URL`) must be the exact origin users see.
  The viewer derives the app origin from it for the frame's CSP and the postMessage
  target. `https://www.example.com` and `https://example.com` are different origins: on
  the other one the handshake cannot complete, and `PdfViewerHost` throws.
- Optional: `citomni/cli` for `pdf-viewer:verify`.


## Install

```bash
composer require citomni/pdf-viewer
```

Enable the provider in `/config/providers.php`:

```php
<?php
declare(strict_types=1);

return [
	\CitOmni\PdfViewer\Boot\Registry::class,
];
```

The provider registers the `pdfViewer` service, the two routes, the `pdf_viewer` config
baseline and the `pdf-viewer:verify` command. If the app uses compiled caches, rebuild
them after enabling or updating the package (`php bin/citomni cache:warm`).


## Integrate

### 1. A route that returns the document

The app serves the document bytes from its own, authorized route. The host fetches it
with the user's session; the frame never sees the URL.

Requirements for that response:

- The user must be allowed to see the document (the route is yours; authorize as usual).
- `Content-Type`: `application/pdf`, `image/jpeg` or `image/png` (others are refused).
- `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
- Release the session lock before streaming a large file, so parallel requests of the same
  user do not wait for the download.

### 2. The host page

The page needs the host configuration (JSON, no secrets) and a CSP that allows the
viewer's paths. In the controller:

```php
$viewer = $this->app->pdfViewer;

$src = $viewer->cspSources();
$this->app->response->setHeader('Content-Security-Policy', \implode('; ', [
	"default-src 'none'",
	"script-src 'self' " . \implode(' ', $src['script-src']),
	"style-src 'self' " . \implode(' ', $src['style-src']),
	"connect-src 'self' " . \implode(' ', $src['connect-src']),
	'frame-src ' . \implode(' ', $src['frame-src']),
	"img-src 'self' data:",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'self'",
]));

// Pass these to the template:
$pdfViewerConfig = \json_encode($viewer->hostConfig(), \JSON_UNESCAPED_SLASHES | \JSON_HEX_TAG | \JSON_HEX_AMP | \JSON_THROW_ON_ERROR);
$pdfViewerStylesheet = $viewer->hostStylesheetUrl();
```

Adapt the CSP to the rest of your page; what matters for the viewer:

- `frame-src` should contain the frame path and nothing else. A narrow `frame-src` also
  stops a compromised frame from navigating itself to other paths of the app.
- `script-src`, `style-src` and `connect-src` need the asset base (host module, optional
  host stylesheet, preload fetches). `connect-src 'self'` also covers your document route.
- Never add `allow-same-origin` to the iframe. The host sets `sandbox="allow-scripts"` and
  the frame's own CSP sandboxes it again.

The page markup (template syntax is yours; the values come from the controller):

```html
<link rel="stylesheet" href="{pdfViewerStylesheet}">
<div id="document-viewer" class="document-viewer"></div>
<script type="application/json" id="pdf-viewer-config">{pdfViewerConfig}</script>
<script type="module" src="/js/documents.mjs"></script>
```

`.document-viewer` needs a height (the frame fills its container).

### 3. The page script

```js
// /js/documents.mjs (your file)
const config = JSON.parse(document.getElementById('pdf-viewer-config').textContent);
const { PdfViewerHost, linesFromPages } = await import(config.assetBase + 'host/pdf-viewer.mjs');

const viewer = new PdfViewerHost({ container: document.getElementById('document-viewer'), config });

viewer.addEventListener('text', (e) => {
	// Untrusted data from the frame: render with textContent/value only.
	for (const line of linesFromPages(e.detail.pages)) {
		console.log(line.page, line.text);
	}
});
viewer.addEventListener('error', (e) => {
	if (e.detail.terminal) {
		showOpenOriginalLink(e.detail.code); // your UI
	}
});

if (viewer.supported) {
	viewer.openUrl('/documents/42/file', { docId: 42 });
} else {
	showOpenOriginalLink('unsupported'); // e.g. an engine that is not enabled
}
```

API of `PdfViewerHost`:

| Member | Description |
|---|---|
| `new PdfViewerHost({container, config})` | `config` is `PdfViewer::hostConfig()`. Throws on an invalid config or when the page is not on the configured app origin. |
| `supported`, `unsupportedReason`, `engine` | Whether the reader runs in this browser (see [Browser support](#browser-support)). |
| `openUrl(url, {mime?, autoOcr?, docId?, init?})` | Fetch a document from the app (same origin, session cookie, `no-store`) and open it. The MIME type comes from the response unless given. Returns the session id. |
| `open({bytes, mime, autoOcr?, docId?})` | Open bytes you already have. `bytes` (an `ArrayBuffer` or a promise of one) is transferred to the frame and detached. |
| `ocrPage(page)` | OCR one page of the open document (also pages with a text layer). |
| `cancel()` | Stop the current document: the frame is removed and an `error` with code `cancelled` follows. |
| `close()` | Remove the frame without an error event. |
| `destroy()` | Remove the frame and stop listening. |
| `current` | Read-only summary of the open document: `{session, docId, state, mime, numPages, currentPage}`. |
| `preloading` | Whether the cache mitigation is active in this browser. |

Module exports besides the class: `linesFromPages(pages)`, `browserInfo()`,
`supportInfo(config)`, `mimeFromContentType(value)`.

`autoOcr: false` opens a document without automatic OCR, e.g. to show it again after the
user cancelled a slow OCR.


## Text output

The `text` event carries every page known so far, sorted by page number:

```js
{
	page: 1,
	examined: true,             // false: not looked at yet (only first and last page are automatic)
	ocr: 'not_needed',          // 'not_needed' | 'done' | 'skipped' | 'failed'
	items: [
		{ page: 1, text: 'I alt DKK', source: 'text', granularity: 'item', box: [0.554, 0.381, 0.638, 0.395] },
		{ page: 1, text: '4.646,69', source: 'ocr', granularity: 'word', box: [...], confidence: 94.1 },
	],
	rule: { usable: true, alnum: 461, ... },   // text-layer assessment (PDF pages)
	ocrMeta: { ocrMs: 1285, dpi: 300, meanConfidence: 94, ... } | null,
}
```

- `box` is `[x0, y0, x1, y1]` in 0..1 of the page as displayed (rotation applied), origin
  top left.
- Text-layer items keep the PDF's content order; OCR words come in reading order.
- `confidence` (0..100) exists for OCR words only. A low value marks a doubtful word, but
  OCR also misreads with high confidence (`l` vs `1`): validate extracted numbers.
- A page counts as having usable text when it has enough letters and digits for its size
  and little garbage (`pdf_viewer.usable_text`). A scan with only a digital page number
  gets OCR; a text layer with plausible but wrong letters does not (use `ocrPage()`).
- `linesFromPages(pages)` joins items into lines: `[{page, text}]`.


## Events and error codes

| Event | Detail |
|---|---|
| `state` | `{session, docId, state: 'pending'|'open'|'closed', readyMs?, reason?}` |
| `progress` | `{session, docId, stage, ...}`; stages `received`, `loaded` (`numPages`, `kind`), `rendered`, `examining`, `ocr` (`page`, `phase`, `ocrStatus`, `ocrProgress`), `busy`, `idle`, `view` (`page`) |
| `text` | `{session, docId, pages}` |
| `error` | `{session, docId, code, page?, detail, by: 'frame'|'host', terminal}` |
| `diagnostics` | `{session, docId, events, dropped}` |

| Code | Meaning | Suggested UI |
|---|---|---|
| `password_required` | The PDF needs a user password. The viewer never prompts. | Offer the original. |
| `too_large` | Above a limit (file size, pages, image pixels). With `page`: an image on that page was removed. | Offer the original. |
| `decoder_missing` | With `page`: an image needs a decoder that is not available; the page is incomplete. | Mark the page; offer the original. |
| `damaged` | The document could not be read (or one page could not, with `page`). | Offer the original. |
| `unsupported` | The browser cannot run the reader, its engine is not enabled (`detail` `engine_policy:<engine>`), or the document type is not supported. | Offer the original. |
| `timeout` | No progress within the host's timeouts, or OCR of a page took too long (with `page`). | Retry or offer the original. |
| `unavailable` | The document could not be fetched, or the frame loaded without starting the reader (typically a page opened before a deploy). | Reload the page. |
| `cancelled` | `cancel()` was called. | |

An error with `page` is not terminal: the document stays visible and the frame marks the
page. A terminal error removes the frame.

`diagnostics` events report CSP violations, attempts to use storage or cookies, uncaught
errors and decoder warnings from the frame. With `pdf_viewer.diagnostics` they also carry
resource timing and worker details. Logging CSP violations and storage attempts is
recommended: in a correct setup there are none.


## Configuration

Baseline in `\CitOmni\PdfViewer\Boot\Registry::CFG_HTTP`; override in
`/config/citomni_http_cfg.php` (deep merge, lists are replaced).

| Key | Default | Meaning |
|---|---|---|
| `pdf_viewer.language` | `null` | Frame texts: `'en'`, `'da'`, or `null` to follow `locale.language` (when `en`/`da`, else `en`). |
| `pdf_viewer.limits.*` | see Registry | File size (50 MiB), pages (1,000), image pixels (50 M), canvas pixels, OCR pixels and DPI (300), timeouts in the frame, text items per page. |
| `pdf_viewer.usable_text.*` | 50 / 0.6 / 0.1 | When a text layer makes OCR unnecessary. |
| `pdf_viewer.host.*` | 15 s / 5 s / 60 s / 180 s / 90 s | Host timeouts: ready, start after load, inactivity, open until first text, OCR of one page. |
| `pdf_viewer.ocr.languages` | `['dan', 'eng']` | Tesseract languages; a subset of the bundled data. |
| `pdf_viewer.preload` | `'auto'` | Cache mitigation: the host pushes the large library files to each new frame from its own HTTP cache. `'auto'` = Chromium only, `'always'`, `'never'`. |
| `pdf_viewer.engines` | `chromium: true`, `webkit: false`, `gecko: false` | Browser engines that get the reader. See [Browser support](#browser-support). |
| `pdf_viewer.diagnostics` | `false` | Verbose `diagnostics` events. |

Objectively invalid values (unknown language, OCR language without data, limit <= 0,
unknown engine) make the `pdfViewer` service throw when it is first used.


## What the app must do (security)

The viewer isolates documents from the app with the sandbox (opaque origin, no popups,
forms or top navigation), the frame's CSP (scripts, styles, fetches and images from the
asset path only), one frame per document, a nonce handshake, and validation of everything
the frame sends. The app completes it:

1. **Switch on citomni/http's Fetch Metadata policy** (`security.fetch_metadata.enabled`
   in `/config/citomni_http_cfg.php`, then rebuild the compiled config). It rejects
   requests from the frame and its workers to every app route, also in WebKit, where
   the frame's requests carry the app's cookies. This package adds one exemption to it:
   GET and HEAD below the asset route. It never switches the policy on, and the app's
   document routes need no exemption (only the host page fetches them). Required before
   you enable WebKit. A citomni/http version without the policy ignores the setting; see
   [`docs/security.md`](docs/security.md#fetch-metadata) for how to check that it is active.
2. **No state-changing GET routes**, and CSRF verification on every state-changing
   request. CitOmni's CSRF origin check treats `Origin: null` as absent and falls back
   to the Referer on HTTPS; it does not reject a null origin by itself.
3. **Session cookie `SameSite=Lax` or `Strict`**, never `None` (CitOmni's default is
   `Lax`). Chromium then sends no session cookie from the frame.
4. **Host page CSP** with a narrow `frame-src` (see above). Never `allow-same-origin`.
5. **Treat the text as untrusted**: show values from events with `textContent`/`value`.
6. **Authorize the document route**, `private, no-store`, `nosniff`.


## Browser support

| Engine | Browsers | Default | Status |
|---|---|---|---|
| `chromium` | Chrome, Edge, Brave, Opera, Chrome on Android | on | Prototype: all isolation, function and robustness tests pass (Chromium 141). Package: all 23 test documents pass, also with Safari 26's missing stream iteration emulated. |
| `webkit` | Safari (macOS), every browser on iOS/iPadOS | off | Function tests pass (iOS Safari 26.6.1, WebKitGTK 2.52.6). The cookie layer of the isolation does not hold: WebKit sends the app's cookies, also `SameSite=Strict`, with requests from the sandboxed frame. iOS Safari also shares worker CacheStorage between sandboxed frames. Enable after the Fetch Metadata check and an explicit decision. |
| `gecko` | Firefox (desktop and Android) | off | Not tested. Enable after running the isolation tests. |

Other engines never get the reader. The engine is inferred from the user agent: there is
no feature test for the cookie behaviour that matters.

Compatibility built in:

- **Safari before 27** lacks async iteration of `ReadableStream`, which PDF.js'
  `getTextContent()` needs; the frame installs it when missing (`reader/compat.mjs`).
- **JPEG 2000 in WebKit**: `openjpeg.wasm` uses relaxed SIMD, which WebKit rejects; PDF.js
  falls back to the JS decoder (slower, works).
- **Chromium** does not reuse its HTTP cache between opaque-origin frames: without the
  preload mitigation every document with OCR downloads about 7 MB.


## Hosting and deploy

- **Assets are served by PHP**, one request per file through the CitOmni kernel. All
  functional requests from the frame are CORS requests without cookies, and every asset
  response is `public` and `immutable`, so a shared cache in front of PHP (Varnish, a CDN
  you control) can serve them. The frame route is `no-store` and reaches PHP once per
  document.
- **`Cross-Origin-Resource-Policy: same-origin` added by the web server** (CitOmni's
  production `.htaccess` sets it for every response; under FastCGI `Header always set`
  replaces the header PHP sent): the viewer keeps working, because it loads everything
  functional with CORS. Only decorative images referenced by PDF.js' own CSS (loading
  spinner, annotation icons) are blocked.
- **Deploy binary-safe.** A text-mode FTP transfer or a truncated upload corrupts the
  wasm, fonts and language data. The asset route compares sizes on every request and fails
  with a logged exception; `php bin/citomni pdf-viewer:verify` checks every SHA-256.
- **After an update** rebuild the app caches (`cache:warm`) so the route table is current,
  and reset OPcache where `validate_timestamps=0`.
- **Request volume per document** (Chromium, with preload): about 10 requests from the
  frame plus the frame route; without preload 13 (text PDF) to 17 (OCR). WebKit serves
  repeated files from its own cache.


## Tests

```bash
composer install            # citomni/kernel, citomni/http, citomni/cli in vendor/
php tests/run.php           # all suites (each in its own process)
node --test tests/js/*.test.mjs
```

| Suite | Covers |
|---|---|
| `tests/bundle` | Generated manifest current and matching the files; publishable paths; routes per depth; config baseline. No Composer needed. |
| `tests/http` | Frame and asset routes through the real CitOmni HTTP kernel in PHP's built-in server: headers, CSP, 404/405/304, HEAD, traversal attempts, mount path, case-insensitive routing, and the asset exemption with citomni/http's Fetch Metadata policy on (skipped with a citomni/http version without the policy). |
| `tests/service` | `pdfViewer` service: URLs, origin, config mapping, fail-fast validation. |
| `tests/verify` | `pdf-viewer:verify` through the real CLI kernel. |
| `tests/js` | Protocol, host validation, text rule, stream-iteration shim, PDF.js worker build shape, engine policy, preload allowlist against the manifest (Node.js 22+). |

Browser behaviour (rendering, OCR, decoders, isolation) needs real browsers; see
[`docs/maintenance.md`](docs/maintenance.md) for the checks to repeat on every library
update.


## License

citomni/pdf-viewer is released under the MIT License. See [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE).

`assets/vendor/` contains unmodified third-party files under their own licenses (PDF.js,
Tesseract.js and tesseract.js-core: Apache-2.0; OpenJPEG, PDFium and Adobe CMaps: BSD;
qcms: MIT; Liberation fonts: GPL-2.0 with font exception; ICC profile: CC0; language data:
Apache-2.0 models, MIT packaging). The license files are next to the files; `NOTICE`
lists them. The tesseract.js-core builds statically link Leptonica, libjpeg, libpng,
libtiff, libwebp, giflib, zlib and OpenLibm; their license texts are in
[`licenses/tesseract-core/`](licenses/tesseract-core). This software is based in part on
the work of the Independent JPEG Group.

See [`TRADEMARKS.md`](TRADEMARKS.md) for the CitOmni trademark notice.
