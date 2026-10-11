<?php
declare(strict_types=1);
/*
 * This file is part of the CitOmni framework.
 * Low overhead, high performance, ready for anything.
 *
 * For more information, visit https://github.com/citomni
 *
 * Copyright (c) 2012-present Lars Grove Mortensen
 * SPDX-License-Identifier: MIT
 *
 * For full copyright, trademark, and license information,
 * please see the LICENSE file distributed with this source code.
 */

namespace CitOmni\PdfViewer\Boot;

use CitOmni\PdfViewer\Command\VerifyCommand;
use CitOmni\PdfViewer\Constant\Route;
use CitOmni\PdfViewer\Controller\AssetController;
use CitOmni\PdfViewer\Controller\FrameController;
use CitOmni\PdfViewer\Service\PdfViewer;

/**
 * Declare this provider package's boot contributions.
 *
 * CitOmni reads these constants when composing the active HTTP or CLI app.
 *
 * Behavior:
 * - MAP_HTTP registers the pdfViewer service (URLs, host/reader configuration, CSP sources).
 * - CFG_HTTP ships the baseline of every pdf_viewer.* key the package reads, and the
 *   security.fetch_metadata exemption for the asset route (used only when the app
 *   switches on citomni/http's Fetch Metadata policy).
 * - ROUTES_HTTP registers the frame route and the asset route (one regex route per path
 *   depth below the asset base).
 * - COMMANDS_CLI registers pdf-viewer:verify.
 *
 * Notes:
 * - Route paths come from Constant\Route; the service builds its URLs from the same
 *   constants. Remapping the routes in the app is not supported.
 * - Enable by listing this class in /config/providers.php.
 */
final class Registry {

	/**
	 * Services available only in HTTP mode.
	 *
	 * @var array<string, class-string|array{class: class-string, options?: array<array-key, mixed>}>
	 */
	public const array MAP_HTTP = [
		'pdfViewer' => PdfViewer::class,
	];


	/**
	 * Configuration defaults used only in HTTP mode.
	 *
	 * Override in /config/citomni_http_cfg.php (deep merge, last wins; lists are replaced).
	 *
	 * @var array<string|int, mixed>
	 */
	public const array CFG_HTTP = [

		/*
		 *------------------------------------------------------------------
		 * PDF VIEWER (citomni/pdf-viewer)
		 *------------------------------------------------------------------
		 *
		 * The reader runs in <iframe sandbox="allow-scripts"> on the app's own domain and
		 * never sends documents anywhere: no cloud OCR, no CDN, no third-party host.
		 * See README.md and docs/security.md.
		 */
		'pdf_viewer' => [

			// UI language of the reader frame: 'en', 'da', or null to follow
			// locale.language (when that is 'en' or 'da'; otherwise 'en').
			'language' => null,

			// Limits enforced in the reader frame. The values below are the ones the
			// prototype was tested with (docs/security.md, "Resource limits").
			'limits' => [
				'max_file_bytes'            => 50 * 1024 * 1024, // Document size (bytes); also checked by the host against Content-Length.
				'max_pages'                 => 1000,             // Pages per PDF.
				'max_image_pixels'          => 50_000_000,       // JPEG/PNG documents (read from the header before decoding).
				'max_pdf_image_pixels'      => 50_000_000,       // Images inside PDFs (PDF.js maxImageSize).
				'max_display_canvas_pixels' => 16_777_216,       // Display canvas (PDFViewer maxCanvasPixels, 4096^2).
				'max_ocr_pixels'            => 10_000_000,       // OCR canvas; the scale is lowered below this.
				'ocr_dpi'                   => 300,              // OCR rendering resolution.
				'ocr_timeout_ms'            => 60_000,           // OCR of one page in the frame.
				'handshake_timeout_ms'      => 10_000,           // Frame waits this long for a valid 'connect'.
				'worker_start_timeout_ms'   => 20_000,           // Start of the PDF.js worker and of the OCR engine.
				'max_text_items_per_page'   => 20_000,           // Text items per page (frame truncates, host rejects more).
				'max_item_text_length'      => 2_000,            // Characters per text item.
			],

			// When a page's text layer counts as usable (no OCR needed):
			// alnum >= max(20, round(min_alnum * page area / A4)), alnum / non-space >= min_alnum_ratio
			// and junk / non-space <= max_junk_ratio.
			'usable_text' => [
				'min_alnum'       => 50,
				'min_alnum_ratio' => 0.6,
				'max_junk_ratio'  => 0.1,
			],

			// Host-side timeouts (the host owns the final timeout and removes the frame).
			'host' => [
				'ready_timeout_ms'            => 15_000,  // Frame creation until a valid 'ready'.
				'start_after_load_timeout_ms' => 5_000,   // Frame loaded but no 'ready' (e.g. a page older than the deploy).
				'inactivity_timeout_ms'       => 60_000,  // No message from a busy frame.
				'open_timeout_ms'             => 180_000, // 'open' until the first text (covers automatic OCR of two pages).
				'ocr_page_timeout_ms'         => 90_000,  // 'ocrPage' until that page's text.
			],

			'ocr' => [
				// Tesseract languages; a non-empty subset of the bundled data (dan, eng).
				'languages' => ['dan', 'eng'],
			],

			// Cache mitigation: the host page pushes the large library files to each new
			// frame from its own HTTP cache. 'auto' = Chromium-based browsers only (measured:
			// about 7 MB less per OCR document); WebKit reuses its cache anyway.
			// 'always' | 'never' force it.
			'preload' => 'auto',

			// Browser engines that get the reader. PdfViewerHost reports 'unsupported'
			// (detail 'engine_policy:<engine>') elsewhere, and the page offers the original.
			// - chromium: Chrome, Edge and other Chromium-based browsers. All isolation tests
			//   passed in the prototype (Chromium 141).
			// - webkit: Safari and every browser on iOS. WebKit sends the app's cookies with
			//   requests from the sandboxed frame, so the cookie layer of the isolation does not
			//   hold there (prototype tests A5, W1, W3; A13: shared worker CacheStorage).
			//   Enable only after the app rejects cross-site requests with Fetch Metadata
			//   (docs/security.md) and the remaining risk has been accepted.
			// - gecko: Firefox. Not tested yet; enable after running the isolation tests.
			// Other engines never get the reader.
			'engines' => [
				'chromium' => true,
				'webkit'   => false,
				'gecko'    => false,
			],

			// Verbose diagnostics from the frame (resource timing, worker console, overlay
			// details) as 'diagnostics' events on the host. CSP violations, storage attempts,
			// errors and decoder warnings are always reported.
			'diagnostics' => false,
		],


		/*
		 *------------------------------------------------------------------
		 * FETCH METADATA EXEMPTION (citomni/http security.fetch_metadata)
		 *------------------------------------------------------------------
		 *
		 * The reader frame has an opaque origin, so every request it and its workers make
		 * for the bundle is cross-site. When the app switches on citomni/http's Fetch
		 * Metadata policy, this rule keeps the asset route reachable: GET and HEAD below
		 * Route::ASSETS, nothing else. The frame route needs no rule (the host page loads
		 * it same-origin), and the app's document routes must not get one (only the host
		 * page fetches them). This package never switches the policy on.
		 */
		'security' => [
			'fetch_metadata' => [
				'exempt' => [
					'pdf_viewer_assets' => [
						'path'    => Route::ASSETS,
						'match'   => 'prefix',
						'methods' => ['GET', 'HEAD'],
					],
				],
			],
		],
	];


	/**
	 * HTTP route dispatch entries contributed by this provider.
	 *
	 * Behavior:
	 * - The frame and every asset depth are regex routes; each placeholder matches one
	 *   path segment, so the asset route has one entry per depth (1..Route::MAX_ASSET_DEPTH).
	 * - GET only (HEAD and OPTIONS are added by the Router).
	 *
	 * @var array<string|int, mixed>
	 */
	public const array ROUTES_HTTP = [
		'regex' => [
			Route::FRAME . '/{bundle}' => [
				'controller' => FrameController::class,
				'action'     => 'frame',
				'methods'    => ['GET'],
			],
			Route::ASSETS . '/{bundle}/{p1}' => [
				'controller' => AssetController::class,
				'action'     => 'asset',
				'methods'    => ['GET'],
			],
			Route::ASSETS . '/{bundle}/{p1}/{p2}' => [
				'controller' => AssetController::class,
				'action'     => 'asset',
				'methods'    => ['GET'],
			],
			Route::ASSETS . '/{bundle}/{p1}/{p2}/{p3}' => [
				'controller' => AssetController::class,
				'action'     => 'asset',
				'methods'    => ['GET'],
			],
			Route::ASSETS . '/{bundle}/{p1}/{p2}/{p3}/{p4}' => [
				'controller' => AssetController::class,
				'action'     => 'asset',
				'methods'    => ['GET'],
			],
			Route::ASSETS . '/{bundle}/{p1}/{p2}/{p3}/{p4}/{p5}' => [
				'controller' => AssetController::class,
				'action'     => 'asset',
				'methods'    => ['GET'],
			],
		],
	];


	/**
	 * CLI command dispatch entries contributed by this provider.
	 *
	 * @var array<string|int, mixed>
	 */
	public const array COMMANDS_CLI = [
		'pdf-viewer:verify' => [
			'command'     => VerifyCommand::class,
			'description' => 'Check the installed PDF viewer assets against the bundle manifest.',
		],
	];
}
