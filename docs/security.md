# Security model

How citomni/pdf-viewer isolates documents from the app, what has been tested, and what
remains the app's responsibility. The integration checklist is in the
[README](../README.md#what-the-app-must-do-security).


## Contents

- [Scope](#scope)
- [Layers](#layers)
- [Frame CSP](#frame-csp)
- [Routes and headers](#routes-and-headers)
- [Handshake and messages](#handshake-and-messages)
- [What the reader never does](#what-the-reader-never-does)
- [Resource limits](#resource-limits)
- [Test results](#test-results)
- [WebKit](#webkit)
- [Fetch Metadata](#fetch-metadata)
- [Residual risks](#residual-risks)
- [Invariants for maintainers](#invariants-for-maintainers)


## Scope

The threat is a document that makes PDF.js, an image decoder or Tesseract.js run code
chosen by the document's author: a parser bug, a decoder bug, a font program
(CVE-2024-4367 in PDF.js was of this kind). The viewer assumes this can happen and confines
such code to one sandboxed frame that holds one document.

The design answers three questions:

1. **Session isolation.** Can code in the frame or its workers read the host page, read
   session data or trigger authorized actions in the app?
2. **Local processing.** Do display, text extraction and OCR use only the app's own
   resources?
3. **No leakage between documents.** Does code that took over the frame through one
   document get access to other documents or to app data?

Out of scope: whether code that took over a frame can send its own document out of the
browser ([Residual risks](#residual-risks)). The viewer itself never sends a document
anywhere: no cloud OCR, no CDN, no third-party host.


## Layers

| Layer | What it does | Where |
|---|---|---|
| Sandbox | `<iframe sandbox="allow-scripts">`: opaque origin; no popups, forms, top navigation or downloads. The frame response repeats it as CSP `sandbox allow-scripts`, so the document gets an opaque origin even without the attribute or when its URL is opened directly. | `PdfViewerHost`, `FrameController` |
| Frame CSP | Scripts, styles, fetches and images from the asset path only; workers from `blob:`; no inline code and no `eval`. | `FrameController::csp()` |
| Stateless routes | The frame and asset routes never start a session, set a cookie or redirect. Anything not in the manifest is a bare 404. | `FrameController`, `AssetController` |
| Host page `frame-src` | Limited to the frame path, so a frame cannot navigate itself to another path of the app. | The app ([README](../README.md#2-the-host-page)) |
| Handshake | Nonce in the URL fragment; `ready` posted to the app origin only; `connect` checked for source, origin, nonce and exactly one transferred port. All further traffic goes over that `MessagePort`. | `reader/protocol.mjs`, `host/pdf-viewer.mjs` |
| Message validation | The host accepts only known message types and fields for the current job, with bounded numbers, strings, arrays and boxes. No message type lets the frame make the host fetch a URL or act in the app. | `host/validate.mjs` |
| One frame per document | A new frame for every document. It is removed on close, cancel, a terminal error or a timeout, and its OCR worker dies with it. Messages from a removed frame are ignored. | `PdfViewerHost` |
| Host-owned timeouts | The host removes a frame that does not start, goes silent or takes too long. | `pdf_viewer.host.*` |
| Resource limits | File size, pages, image pixels, canvas size, text volume, OCR time. | `pdf_viewer.limits.*` |
| App: Fetch Metadata | citomni/http's `security.fetch_metadata` policy rejects cross-site requests to app routes; this package exempts its asset route. Required for WebKit, where the cookie layer does not hold. | The app ([below](#fetch-metadata)) |


## Frame CSP

```
sandbox allow-scripts;
default-src 'none';
script-src {assetBase} 'wasm-unsafe-eval';
worker-src blob:;
connect-src {assetBase};
style-src {assetBase};
img-src {assetBase} blob:;
base-uri 'none';
form-action 'none';
frame-ancestors {appOrigin}
```

`{assetBase}` is the absolute asset URL including the bundle key
(`https://app.example/_pdf-viewer/assets/{key}/`); `{appOrigin}` is the origin of the
public root URL. Origins are always written out, never as `'self'`.

This is the smallest policy with which every test document worked. The prototype removed
one source at a time and opened ten documents (Chromium):

| Source removed | Result |
|---|---|
| `'wasm-unsafe-eval'` | OCR `unsupported` (the engine cannot start); JBIG2 `decoder_missing`; JPEG 2000 falls back to the JS decoder; ICC colour management fails. |
| `worker-src blob:` | Every document `unsupported` (no worker). |
| `connect-src` | Every PDF `damaged` (the worker code cannot be fetched). |
| `style-src` | Every PDF `damaged` (PDF.js' viewer needs its CSS). |
| `blob:` in `img-src` | JPEG/PNG documents `damaged`. |
| The asset path in `img-src` | Documents work; the decorative images in PDF.js' CSS cause CSP violations. |
| `Access-Control-Allow-Origin` on asset responses | The reader does not start: its module is blocked by CORS. |

`sandbox allow-scripts`, `default-src 'none'`, `base-uri`, `form-action` and
`frame-ancestors` are not needed for function; they are there for security. A nonce and
`data:` were tested and dropped: the reader has no inline code and loads no `data:` images.
The same policy produced no CSP violations in WebKitGTK and iOS Safari.


## Routes and headers

| Route | Response |
|---|---|
| `GET /_pdf-viewer/frame/{key}` | The CSP above; `Content-Type: text/html; charset=utf-8`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `Cache-Control: no-store` and `Expires: 0`; `X-Robots-Tag: noindex`; `X-DNS-Prefetch-Control: off`. Any queued `Set-Cookie` is removed. A key other than the installed bundle's is a bare 404 with `Content-Security-Policy: default-src 'none'; sandbox`. |
| `GET /_pdf-viewer/assets/{key}/{path}` | Exact lookup of the path in the generated manifest (`Constant\Bundle::FILES`); only listed files are opened, and the manifest never lists PHP files. `Content-Type` by extension, otherwise `application/octet-stream`; `nosniff`; `Content-Security-Policy: default-src 'none'; sandbox` (inert when opened as a document); `Access-Control-Allow-Origin: *` (required: the frame has an opaque origin); `Cross-Origin-Resource-Policy: cross-origin`; `Cache-Control: public, max-age=31536000, immutable`; `ETag`. Everything else is a 404 with `Access-Control-Allow-Origin: *`. |

Both routes serve GET and HEAD (the router answers OPTIONS with 204 and `Allow`, and other
methods with 405), never redirect, and never touch the session. The bundle key is a hash
over every served file and the frame template, so a changed file always gets a new URL.

The host page sets `sandbox="allow-scripts"` and `referrerpolicy="no-referrer"` on the
iframe. The app must never add `allow-same-origin`: with it, the frame's scripts would
run with the app's origin and could remove their own sandbox.


## Handshake and messages

1. The host creates the iframe with a random nonce in the URL fragment (`#n=...`). The
   fragment is not sent to the server.
2. The frame posts `{type: 'ready', nonce}` to the app origin only.
3. The host accepts `ready` only from the content window of the frame it is waiting for,
   with origin `null` and that frame's nonce, and answers `{type: 'connect', nonce}` with
   one transferred `MessagePort`.
4. The frame accepts `connect` once, only from its parent window and the app origin, with
   its own nonce and exactly one port. Then it accepts one `open` (and, before it, one
   optional `assets` message with preloaded library files).
5. The document bytes are transferred over the port. The frame never gets the document's
   URL, cookies or anything else from the app.

Frame to host: `progress`, `text`, `error` and `diagnostics`, all for the current job.
Everything the frame sends is untrusted: the host validates and copies it
(`host/validate.mjs`), and the app must render text with `textContent`/`value` only.


## What the reader never does

- **No storage.** The reader, PDF.js and Tesseract.js (with `cacheMethod: 'none'`) use no
  `localStorage`, `sessionStorage`, IndexedDB, CacheStorage or cookies. The frame wraps
  these APIs and reports every attempt as a `storage` diagnostic. In the tests there were
  none. This matters in iOS Safari, where workers in different sandboxed frames share
  CacheStorage ([WebKit](#webkit)).
- **No no-cors loads of functional files.** Module scripts, stylesheets
  (`crossorigin="anonymous"`) and fetches (`credentials: 'omit'`) are CORS requests
  without credentials. The PDF.js worker and the Tesseract worker and core are fetched
  this way and started from blob URLs instead of `importScripts`. Two reasons: a
  `Cross-Origin-Resource-Policy: same-origin` header added by the web server blocks no-cors
  loads from the opaque origin, and WebKit attaches the app's cookies to no-cors requests
  from the frame.
- **No other hosts.** Tesseract.js' `workerPath`, `corePath` and `langPath`, and PDF.js'
  `wasmUrl`, `cMapUrl`, `standardFontDataUrl` and `iccUrl`, all point to the asset route;
  the libraries' default CDN is never used.
- **No PDF scripting.** No `PDFScriptingManager`, no `pdf.sandbox`, no QuickJS (not in the
  bundle); XFA is off; external links are disabled.


## Resource limits

Enforced in the frame (`pdf_viewer.limits.*`) and by the host (`pdf_viewer.host.*`). The
defaults are the values the prototype was tested with.

| Limit | Default | Behaviour |
|---|---|---|
| File size | 50 MiB | Frame: `too_large` on `open`. Host: `too_large` when `Content-Length` is larger. |
| Pages | 1,000 | `too_large` after the document is parsed. |
| Image inside a PDF | 50 M pixels | PDF.js removes the image; the page is marked incomplete (`too_large` with `page`). |
| JPEG/PNG document | 50 M pixels | Dimensions are read from the header before decoding: `too_large`. |
| Display canvas | 16,777,216 pixels (4096²) | PDF.js `maxCanvasPixels`. |
| OCR canvas | 10 M pixels, 300 dpi | The scale is lowered below the limit (A4 at 300 dpi is about 8.7 M). |
| OCR of one page | 60 s in the frame, 90 s in the host | `timeout` with `page`; the OCR worker is terminated. |
| Worker and OCR engine start | 20 s | `unsupported` at once if the engine aborts, otherwise `timeout`. |
| Handshake | 10 s in the frame | Without a valid `connect` the frame refuses to work. |
| Text | 20,000 items per page, 2,000 characters per item | The frame truncates; the host rejects more. |
| Host timeouts | ready 15 s, start after load 5 s, inactivity 60 s, open until first text 180 s | The host removes the frame. |


## Test results

### Prototype isolation tests

The isolation tests ran against a prototype with the same frame design, CSP and libraries.
Each test that takes over the frame runs attacker code inside the sandboxed frame and its
workers, against probe endpoints on the app's origin that record which cookies arrive.

| Test | What it checks | Chromium 141 | WebKitGTK 2.52.6 | iOS Safari 26.6.1 |
|---|---|---|---|---|
| A1 | The frame has an opaque origin (`self.origin === 'null'`). | PASS | PASS | PASS |
| A2 | `document.cookie` is not readable in the frame. | PASS | PASS | PASS |
| A3 | `localStorage`, `sessionStorage`, IndexedDB and CacheStorage fail in the frame. | PASS | PASS | PASS |
| A4 | `parent.document` and `top.document` are not accessible. | PASS | PASS | PASS |
| A5 | With the CSP relaxed: requests from the frame (`fetch` with credentials, `<img>`) reach the app without `SameSite=Lax`/`Strict` cookies. | PASS | **FAIL** | **FAIL** |
| A6 | With the real CSP: the same requests are blocked before they reach the app. | PASS | PASS | PASS |
| A7-A9 | `window.open`, top navigation and form submission are blocked (each with a non-sandboxed control that works). | PASS | PASS | PASS |
| A10 | The frame cannot navigate itself to an app path outside the frame path (host `frame-src`). | PASS | PASS | PASS |
| A11 | The host ignores a forged `ready` from another frame. | PASS | PASS | PASS |
| A12 | The frame rejects invalid `connect` attempts (wrong nonce, 0 or 2 ports, a second `connect`) and a second `open`. | PASS | PASS | PASS |
| A13 | No leakage between documents: markers left by a taken-over frame (`window.name`, BroadcastChannel, `localStorage`, worker CacheStorage) are not visible to the next frame; each frame gets exactly one document; messages from the old frame are ignored. | PASS | PASS | **FAIL** |
| W1 | Workers: requests carry no `Lax`/`Strict` cookies (CSP relaxed) and are blocked (real CSP). | PASS | **FAIL** | **FAIL** |
| W2 | Workers: an actual IndexedDB operation fails. | PASS | PASS | PASS |
| W3 | Nested workers are refused or pass W1 and W2 themselves. | PASS | **FAIL** | **FAIL** |
| W4 | PDF.js runs in a real worker, not the fake worker on the main thread. | PASS | PASS | PASS |
| B1 | The frame URL opened directly has origin `null` and refuses to work. | PASS | PASS | PASS |
| B2 | The frame response has `sandbox allow-scripts` and no `Set-Cookie`; the frame and asset routes never redirect. | PASS | PASS | PASS |
| C11 | Every request from the frame and its workers goes to the app's asset path; no CSP violations. | PASS | PASS | PASS |

- Chromium 141 ran twice, with third-party cookies allowed and blocked: PASS in both.
- A `SameSite=None` cookie was sent from the frame in Chromium when third-party cookies
  were allowed. The app's session cookie must therefore never be `SameSite=None`.
- iOS Safari 26.6.1 (iOS 26.6.2) ran against a production deployment with "Prevent
  Cross-Site Tracking" on. WebKitGTK is WebKit, not Safari (different network stack).
- Local processing: across all runs, zero requests from the frame or its workers went to
  any other host (resource timing in the frame, a request log in Chromium, a trap proxy
  for WebKitGTK).
- Not tested: Firefox, Safari on macOS, Chrome on Android.

### Package verification

The package's reader is a port of the prototype's. It was verified in a CitOmni app under
Apache with PHP as FastCGI and CitOmni's production `.htaccess`, which sets
`Cross-Origin-Resource-Policy: same-origin` on every response (under FastCGI this replaces
the header PHP sends):

- **Chromium 141:** all 23 test documents pass (text PDF, image-only PDF, scans with an
  invisible, a poor or almost no text layer, mixed pages, JPEG 2000, JBIG2, external CMaps,
  non-embedded standard fonts, DeviceCMYK/ICC, rotation, owner and user passwords,
  JavaScript actions, HTML/script strings in the text, 150 and 1,001 pages, a 49 and a 203
  megapixel image, receipts as JPEG, JPEG with EXIF orientation and PNG). Zero requests to
  other hosts, zero CSP violations, zero storage attempts. The only blocked requests are
  the decorative images referenced by PDF.js' CSS (no-cors, blocked by the server's CORP
  header).
- The same in Chromium with `ReadableStream` async iteration removed (Safari 26
  emulation; the frame's shim was installed). With `preload` set to `never`, a subset of
  seven documents (text, OCR, JPEG 2000, JBIG2, the three receipts) passed as well.
- **WebKitGTK 2.52.6:** with the default engine policy the host reports `unsupported`
  (`engine_policy:webkit`) and creates no frame; with `webkit` enabled all 23 documents
  pass with zero requests to other hosts.
- **Scenarios:** manual OCR of a page; cancel during OCR (frame removed, no late events);
  a frame URL from before a deploy (`unavailable` after the start-after-load timeout);
  a page on another origin than the configured one (`PdfViewerHost` throws); a document
  route returning another content type (`unsupported`); a bundle without the JPEG 2000
  decoders (`decoder_missing` on page 1, not terminal).
- **With citomni/http's Fetch Metadata policy on:** see [Fetch Metadata](#fetch-metadata).
- iOS Safari ran against the prototype only.


## WebKit

**Finding.** WebKit sends all of the app's cookies, also `SameSite=Strict`, with requests
from the sandboxed frame and its workers to the app's domain (A5, W1, W3). iOS Safari did
so with "Prevent Cross-Site Tracking" on, and the requests carried
`Sec-Fetch-Site: cross-site`. Every browser on iOS and iPadOS uses WebKit.

**Against the cookie specification.** For the frame's own requests (A5), WebKit does what
the draft prescribes: [RFC 6265bis](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html)
(section 5.2.1) takes a sandboxed document's "site for cookies" from its URL, not from its
opaque origin, so a frame on the app's own site is same-site with the app. Chromium, which
withholds the cookies, is stricter than the draft, and untested engines may behave like
WebKit. The workers are different. For a dedicated worker the draft (section 5.2.2.1) uses
the document's site for cookies only when the worker's origin is same-site with it. The
frame's blob workers inherit its opaque origin, so under the draft their requests are
cross-site and carry no `Lax` or `Strict` cookies. In W1 and W3 WebKit deviates from the
draft.

**What still holds in WebKit.** With the real CSP no tested path reached the app (A6 and
the production part of W1 pass). Session isolation in WebKit rests on:

1. the frame's CSP, which allows the asset path only;
2. the sandbox (no forms, popups or top navigation);
3. the host page's narrow `frame-src`;
4. frame and asset routes that never use the session;
5. the app's Fetch Metadata policy (below), which also stops these requests in WebKit
   (measured in WebKitGTK).

One layer fewer than in Chromium. Whether a frame on a separate site would restore the
cookie layer in WebKit is not tested. Under the draft it would: a frame whose URL is on
another registrable domain gets an opaque site for cookies, so its requests carry no `Lax`
or `Strict` cookies. The tests cannot show whether WebKit follows the draft here, because
the frame and the top-level page were on the same site. A subdomain is same-site and would
not help.

**Shared CacheStorage (iOS Safari).** A marker that a taken-over frame wrote to
CacheStorage from a worker could be read from a worker in a later frame (A13). It is not
the app's CacheStorage (the host page did not see the marker), so it cannot poison a
service worker of the app. The reader and the libraries do not use CacheStorage, so no
document data goes that way. What remains is a channel between two frames that both run
hostile code. Whether the data outlives the browser session was not measured.

**Default.** `pdf_viewer.engines.webkit` is `false`: WebKit browsers get `unsupported`
and the app offers the original document. Enable it after the app rejects cross-site
requests with Fetch Metadata and the remaining risk above has been accepted.


## Fetch Metadata

All requests from the frame and its workers carried `Sec-Fetch-Site: cross-site` in every
tested browser, including WebKit, where the cookies came along. A server-side check on
that header closes the gap the cookie layer leaves in WebKit, and is good practice in any
case.

citomni/http has this check as an optional, global policy that runs in `Kernel::run()`
before maintenance and routing. Switch it on in the app's `/config/citomni_http_cfg.php`
and rebuild the compiled config:

```php
return [
	'security' => [
		'fetch_metadata' => [
			'enabled'         => true,
			'allow_same_site' => false,
			'allow_missing'   => true,
		],
	],
];
```

With this configuration the kernel lets through same-origin requests, requests the user
started (`Sec-Fetch-Site: none`), requests without Fetch Metadata (older browsers,
server-to-server calls) and cross-site GET/HEAD top-level navigations. Everything else
from another site is a 403 unless a named exemption matches its path and method. It is
independent of `security.csrf.fetch_metadata`, which only runs inside CSRF verification.
The citomni/http README describes the policy in full.

This package contributes one exemption, `pdf_viewer_assets`: GET and HEAD below
`Route::ASSETS`. The frame route needs none, because the host page loads it same-origin,
and the app's document routes must not get one, because only the host page fetches them.
Keep the asset prefix for this package's stateless route. The package never switches the
policy on.

Check after every deploy that the policy is active. A citomni/http version without it
ignores the setting, and a compiled config from an older version counts as off until it
is rebuilt:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Sec-Fetch-Site: cross-site' \
  -H 'Sec-Fetch-Mode: no-cors' -H 'Sec-Fetch-Dest: image' https://www.example.com/
# 403
```

Measured with the policy on (Apache with PHP as FastCGI, Chromium 141 and WebKitGTK
2.52.6): from a sandboxed opaque-origin frame, credentialed requests to app routes
(fetch, image, POST, a document route) were 403 in both engines, while the viewer's
asset route answered. Without the policy, the same requests reached the app in WebKitGTK.
From another site, images, fetches, iframes and POST form submissions were 403; links
and GET form navigations went through. The viewer passed all 23 test documents in both
engines with the policy on.

Watch for browser-based cross-site POST returns the app expects (payment or identity
providers that come back with an auto-submitted form): they need an exemption for that
route, and that route still needs its own verification. Also:

- No state-changing GET routes: cross-site top-level navigations are allowed.
- CSRF verification on every state-changing request. CitOmni's CSRF origin check treats
  `Origin: null` as absent and falls back to the Referer on HTTPS; it does not reject a
  null origin by itself.
- Session cookie `SameSite=Lax` or `Strict`, never `None`.
- Fetch Metadata does not address the shared CacheStorage or the exfiltration risks below.


## Residual risks

- **Sending the document out of the browser.** Out of scope, and not prevented. In
  Chromium 141, code in the frame could use `RTCPeerConnection` under the frame's CSP and
  get a STUN answer from an arbitrary address (tested against a local STUN server);
  `connect-src` does not cover ICE/STUN, and Chromium 141 does not know the CSP directive
  `webrtc 'block'`. iOS Safari 26.6.1 exposes `RTCPeerConnection` in the sandboxed frame as
  well (the round trip was not verified there). This does not depend on the frame's
  domain.
- **WebKit's cookie behaviour and shared CacheStorage**, see [WebKit](#webkit).
- **Requests under the asset path.** A taken-over frame can request arbitrary paths below
  the asset prefix. They are 404s and end up in the server's access log.
- **DNS prefetching** from the frame is not tested; the frame response sends
  `X-DNS-Prefetch-Control: off`.
- **Library vulnerabilities** stay inside the frame, but keep PDF.js and Tesseract.js
  current ([maintenance](maintenance.md)).
- **Wrong text.** OCR misreads, also with high confidence (`l` vs `1`), and a PDF's text
  layer can differ from what is displayed. Treat extracted values as suggestions and
  validate them.


## Invariants for maintainers

Changing any of these needs the browser checks in [maintenance.md](maintenance.md) and,
for the first five, the isolation tests:

- Never `allow-same-origin`, neither on the iframe nor in the frame's CSP.
- Keep the frame CSP minimal. A new source needs a measured reason.
- The frame and asset routes never start a session, set a cookie or redirect; the asset
  route only serves files listed in the manifest.
- No storage APIs in the frame; Tesseract.js keeps `cacheMethod: 'none'`.
- One frame and one OCR worker per document; never reuse either for another document.
- No no-cors loads of functional files (no `importScripts` of asset URLs, no
  stylesheets without `crossorigin`).
- The host validates every message from the frame. No message type may make the host
  fetch a URL or act in the app on the frame's behalf.
