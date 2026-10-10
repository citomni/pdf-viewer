# Maintenance

How the third-party files in `assets/vendor/` were chosen, how to update them, and what to
check in real browsers before an update ships. The security background is in
[security.md](security.md).


## Contents

- [What is vendored, and why](#what-is-vendored-and-why)
- [Updating PDF.js or Tesseract.js](#updating-pdfjs-or-tesseractjs)
- [Browser checks on every library update](#browser-checks-on-every-library-update)
- [Bundle key and deploys](#bundle-key-and-deploys)
- [Licenses](#licenses)


## What is vendored, and why

`tools/vendor-sync.sh` rebuilds `assets/vendor/` from five npm tarballs pinned by SHA-256
and copies only the runtime files the reader uses:

| Source | Files | Notes |
|---|---|---|
| `pdfjs-dist` 6.4.299 | `legacy/build/pdf.min.mjs`, `legacy/build/pdf.worker.min.mjs`, `legacy/web/pdf_viewer.mjs` | The legacy build: the modern build calls `Map.prototype.getOrInsertComputed` and `Math.sumPrecise` directly and fails in Chromium 141. The legacy build is the same code with core-js polyfills that are installed only where a feature is missing. |
| | `web/pdf_viewer.css`, `web/images/` | Byte-identical to the legacy copies (the script checks). The images are decorative. |
| | `wasm/openjpeg.wasm`, `wasm/jbig2.wasm`, `wasm/qcms_bg.wasm` | JPEG 2000, JBIG2 and ICC colour management. |
| | `wasm/openjpeg_nowasm_fallback.js` | Required in WebKit: `openjpeg.wasm` uses relaxed SIMD, which Safari, iOS and WebKitGTK reject. Without the fallback, JPEG 2000 images are missing (`decoder_missing`); with it they are decoded in JS (slower). |
| | `cmaps/`, `standard_fonts/`, `iccs/` | External CMaps (CJK), non-embedded standard fonts, CMYK/ICC. Loaded only when a document needs them. |
| | all license files | |
| `tesseract.js` 7.0.0 | `dist/tesseract.esm.min.js`, `dist/worker.min.js` | API in the frame, OCR worker script. |
| `tesseract.js-core` 7.0.0 | `tesseract-core-{,simd-,relaxedsimd-}lstm.wasm.js` | The three LSTM-only single-file cores. The reader picks one with the feature tests Tesseract.js uses (Chromium: relaxed SIMD; WebKit: SIMD). |
| `@tesseract.js-data/dan`, `/eng` 1.0.0 | `4.0.0_best_int/{dan,eng}.traineddata.gz` | Tesseract.js' default LSTM data (integerized tessdata_best). |

Left out on purpose: the modern PDF.js build; PDF scripting (`wasm/quickjs-eval.*`,
`pdf.sandbox*`), which the reader never enables; `wasm/jbig2_nowasm_fallback.js`
(`jbig2.wasm` loads in every tested engine); source maps; `image_decoders/`; `types/`; the
Tesseract cores with the legacy engine (OEM is locked to `LSTM_ONLY`).

How the reader uses them (`assets/reader/`):

- **PDF.js worker.** Fetched with CORS, converted to a classic script
  (`compat.mjs`, `toClassicWorkerScript()`) and started from a blob URL, because a module
  worker from a blob URL does not start in an opaque origin (Chromium 141). The conversion
  accepts exactly one `export{WorkerMessageHandler}` and at most four `import.meta.url`,
  and refuses anything else. `workerSrc` is never set, so PDF.js cannot fall back to a
  "fake worker" on the main thread.
- **Tesseract worker.** One classic blob worker per frame: a small prologue, the chosen
  core and `worker.min.js`, all fetched with CORS. With the core inlined, the global
  `TesseractCore` exists and Tesseract.js skips its own `importScripts()` of the core.
  `cacheMethod: 'none'`; `langPath` on the asset route.
- **Safari before 27.** `compat.mjs` installs `ReadableStream` async iteration when it is
  missing; PDF.js' `getTextContent()` needs it (upstream pdf.js issue #21557).
- **Decoder failures.** PDF.js 6.4 logs a warning and draws an empty image when a decoder
  cannot start. The PDF.js worker gets a prologue that forwards its console warnings to the
  frame. `Unable to decode image ...` from a decoder that failed to initialize becomes
  `decoder_missing` for that page (with the reason from the preceding
  `#instantiateWasm: ...` warning), other decode failures become `damaged`, and
  `Image exceeded maximum allowed size ...` becomes `too_large`. This depends on PDF.js'
  warning texts and `verbosity: 1`.


## Updating PDF.js or Tesseract.js

1. **Pin the new tarballs.** In `tools/vendor-sync.sh`, change the versions (they appear in
   the `PIN` table, the `npm pack` line and the extraction paths) and the SHA-256 pins.
   Get a tarball with `npm pack <package>@<version>`, check it against
   `npm view <package>@<version> dist.integrity`, then pin its `sha256sum`.
2. **Read the upstream changes** for anything that touches the reader's assumptions: the
   worker build (module constructs), new resource URLs or loaders, the options the reader
   sets (`getDocument`, `PDFViewer`, `createWorker`), warning texts, storage use, the
   Tesseract core loader.
3. **Replace the files:** `bash tools/vendor-sync.sh` (needs npm; `VENDOR_TGZ_DIR=/path`
   rebuilds from a verified tarball cache).
4. **Update the texts that name versions:** `README.md`, `NOTICE`, the module headers in
   `assets/reader/`. `grep -rn "6\.4\.299\|7\.0\.0" --exclude-dir=vendor --exclude-dir=.git .`
   finds them. For tesseract.js-core, also check the submodules it builds from and update
   `licenses/tesseract-core/` ([Licenses](#licenses)).
5. **Build and test:** `php tools/build-bundle.php` (the bundle key changes), then
   `php tests/run.php`. The JavaScript suite (Node.js 22+) fails first when the worker
   build changes shape (`tests/js/worker.test.mjs`) or a preloadable file outgrows its cap
   in `reader/protocol.mjs` (`tests/js/host.test.mjs`).
6. **Check in browsers** (next section). Any later change below `assets/` needs another
   `php tools/build-bundle.php`; `tests/bundle` fails until it is done.
7. **Commit together:** `assets/vendor/`, `src/Constant/Bundle.php`, the script and the
   texts. `.gitattributes` marks `assets/vendor/` as binary, so line endings are never
   touched; the manifest pins every file's SHA-256.

A new asset path deeper than `Route::MAX_ASSET_DEPTH` (5 segments) makes
`build-bundle.php` refuse to publish it. Raising the depth needs one more route in
`Registry::ROUTES_HTTP`; `tests/bundle` checks that the two match.


## Browser checks on every library update

The PHP and Node suites cannot render, decode or OCR. Before an update ships, open real
documents in real browsers through an app that integrates the viewer as the README shows,
with `pdf_viewer.diagnostics` on, and log the host's `error` and `diagnostics` events.
At least the current Chromium; also iOS Safari when an app has `webkit` enabled.

1. **Document matrix.** Text PDF; image-only PDF; scans with an invisible, a poor and
   almost no text layer; mixed pages (only the first and last page are examined
   automatically; manual OCR works on any page); JPEG 2000; JBIG2; external CMaps (CJK);
   non-embedded standard fonts; DeviceCMYK/ICC; `/Rotate`; owner password (opens);
   user password (`password_required`); JavaScript actions (nothing runs); HTML and script
   strings in the text (shown as text); 150 pages; more than `max_pages`
   (`too_large`); an image above `max_pdf_image_pixels` (`too_large` on that page);
   JPEG with EXIF orientation; PNG. Check the text, the OCR results and that the boxes sit
   on the displayed content.
2. **Nothing leaves the app.** Zero CSP violations and zero storage attempts in the
   `diagnostics` events; zero requests from the frame or its workers to other hosts in the
   browser's network log (workers included). The frame's CSP must not need a new source;
   if it does, find out which and why, and update [security.md](security.md).
3. **Safari before 27.** In Chromium, delete `ReadableStream.prototype[Symbol.asyncIterator]`
   and `ReadableStream.prototype.values` in every frame before any script runs (for example
   Playwright's `context.addInitScript()`). Every PDF must still give text, and the
   `compat` diagnostic must say `readableStreamIteration: 'installed'`.
4. **Decoder detection.** Remove `vendor/pdfjs/wasm/openjpeg.wasm` and
   `openjpeg_nowasm_fallback.js` locally, run `php tools/build-bundle.php`, and open a
   JPEG 2000 PDF: page 1 must report `decoder_missing` and be marked incomplete. Restore
   the files and rebuild. An oversized image must give `too_large` on its page.
5. **Workers.** The `pdfWorker` diagnostic shows `workerPortIsOurs: true`,
   `workerSrcSet: false` and `mainThreadWorkerCode: false` (a real worker from the blob
   URL, no fake worker). The OCR worker fetches the language data from the asset route
   and never requests `vendor/tesseract-core/` itself; if Tesseract.js stops honouring an
   existing `TesseractCore`, it would load the core with `importScripts()`, a no-cors
   request that a `Cross-Origin-Resource-Policy: same-origin` header blocks and that
   carries cookies in WebKit.
6. **Engine start failures.** Locally remove `'wasm-unsafe-eval'` from
   `FrameController::csp()`: OCR must fail with `unsupported` at once instead of hanging
   (the core only logs `Aborted(...)`), and JBIG2 must report `decoder_missing`. Restore it.
7. **Preload (Chromium).** With `preload` `auto`, the frame's `assets` diagnostic reports
   the pushed files (count and bytes), and the worker, OCR core and language data are not
   fetched again by the frame. With `preload` `never` the same documents still work.
8. **Lifecycle.** Cancel during OCR (frame removed, no late events); open a second
   document while the first runs; a frame URL with an old bundle key (`unavailable`).

The isolation tests in [security.md](security.md#test-results) (A, W and B) ran in a
separate harness and are not part of this package. Re-run them before enabling another
engine, after any change to the frame, its CSP or the routes, and on major library updates.


## Bundle key and deploys

- The key is the first 12 hex characters of SHA-256 over the version list: one line
  `assets/<path>\t<sha256>` per published file plus `templates/frame.php\t<sha256>`, sorted.
  A changed asset or template gives new URLs, so `immutable` caching is always safe.
- `php tools/build-bundle.php --check` (or `composer bundle:check`) exits 1 when
  `src/Constant/Bundle.php` is stale; `tests/bundle` runs it.
- A page that was open during a deploy still holds the old key: its next frame is a 404,
  and the host reports `unavailable` after `start_after_load_timeout_ms`. The page must be
  reloaded.
- After a deploy: `php bin/citomni pdf-viewer:verify` checks every file's size and SHA-256.
  The asset route itself compares sizes on every request and fails loudly on a mismatch.


## Licenses

`NOTICE` lists every vendored component with its version, license and license file. When a
component changes, update its entry. `tesseract.js-core` ships only its own Apache-2.0
license, but its WebAssembly builds statically link Leptonica, libjpeg, libpng, libtiff,
libwebp, giflib, zlib and OpenLibm, built from git submodules of the tesseract.js-core
repository. Their license texts are in `licenses/tesseract-core/`, taken from the
submodule commits of tag v7.0.0. On an update, check out the new tag, compare its committed
builds with the npm release, and refresh the texts and the commit list in `NOTICE`.
