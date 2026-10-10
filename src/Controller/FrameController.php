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

namespace CitOmni\PdfViewer\Controller;

use CitOmni\Kernel\Controller\BaseController;
use CitOmni\PdfViewer\Constant\Bundle;
use CitOmni\PdfViewer\Constant\PackagePath;

/**
 * FrameController: Serves the reader frame document.
 *
 * Routing:
 * - GET|HEAD /_pdf-viewer/frame/{bundle key} (Registry::ROUTES_HTTP).
 *
 * Behavior:
 * - The CSP starts with "sandbox allow-scripts", so the document gets an opaque origin
 *   even when the iframe attribute is missing or the URL is opened directly.
 * - Scripts, styles, fetches and images are limited to the bundle's asset path; workers to
 *   blob: URLs; 'wasm-unsafe-eval' allows WebAssembly compilation only. The document has no
 *   inline code, so the policy has no nonce. frame-ancestors is the app origin.
 * - Never starts a session, never sets a cookie, never redirects. Any Set-Cookie header
 *   queued earlier in the request is removed.
 * - Cache-Control: no-store (plus Expires, so mod_expires adds nothing): a cached frame
 *   could outlive a CSP or configuration change.
 * - A key other than the installed bundle's is a bare 404.
 *
 * Notes:
 * - Output buffers are discarded and the action exits after the body, so nothing else
 *   (e.g. the kernel's ?_perf footer) is appended.
 * - This is the smallest policy with which all test documents worked in the prototype
 *   (Chromium 141, WebKitGTK 2.52.6, iOS Safari 26.6.1); dropping any source breaks a
 *   document type. See docs/security.md.
 */
final class FrameController extends BaseController {

	/**
	 * GET /_pdf-viewer/frame/{bundle}
	 *
	 * @param  string  $bundle  Bundle key from the URL.
	 * @return never
	 */
	public function frame(string $bundle): never {
		if ($bundle !== Bundle::KEY) {
			self::notFound();
		}

		$viewer = $this->app->pdfViewer;
		$html = self::render($viewer->language(), $viewer->assetBaseUrl(), $viewer->readerConfig());

		while (\ob_get_level() > 0) {
			\ob_end_clean();
		}
		\header_remove('Set-Cookie');
		\http_response_code(200);
		\header('Content-Type: text/html; charset=utf-8');
		\header('Content-Security-Policy: ' . self::csp($viewer->assetBaseUrl(), $viewer->appOrigin()));
		\header('X-Content-Type-Options: nosniff');
		\header('Referrer-Policy: no-referrer');
		\header('Cache-Control: no-store');
		\header('Expires: 0');
		\header('X-Robots-Tag: noindex');
		\header('X-DNS-Prefetch-Control: off');
		\header('Content-Length: ' . \strlen($html));
		if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
			echo $html;
		}
		exit;
	}


	/**
	 * Content-Security-Policy of the frame document.
	 *
	 * @param  string  $assetBase  Absolute asset base URL (ends with "/").
	 * @param  string  $appOrigin  App origin (frame-ancestors).
	 * @return string
	 */
	public static function csp(string $assetBase, string $appOrigin): string {
		return 'sandbox allow-scripts'
			. "; default-src 'none'"
			. "; script-src {$assetBase} 'wasm-unsafe-eval'"
			. '; worker-src blob:'
			. "; connect-src {$assetBase}"
			. "; style-src {$assetBase}"
			. "; img-src {$assetBase} blob:"
			. "; base-uri 'none'"
			. "; form-action 'none'"
			. "; frame-ancestors {$appOrigin}";
	}


	/**
	 * Render templates/frame.php.
	 *
	 * @param  string                $lang       UI language.
	 * @param  string                $assetBase  Absolute asset base URL.
	 * @param  array<string, mixed>  $config     Reader configuration.
	 * @return string
	 * @throws \JsonException  When the configuration cannot be encoded.
	 */
	private static function render(string $lang, string $assetBase, array $config): string {
		$config = \json_encode($config, \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE | \JSON_THROW_ON_ERROR);
		\ob_start();
		try {
			require PackagePath::FRAME_TEMPLATE;
		} finally {
			$html = (string)\ob_get_clean();
		}
		return $html;
	}


	/**
	 * Bare 404: no session, no cookie, inert if opened as a document.
	 *
	 * @return never
	 */
	private static function notFound(): never {
		while (\ob_get_level() > 0) {
			\ob_end_clean();
		}
		\header_remove('Set-Cookie');
		\http_response_code(404);
		\header('Content-Type: text/plain; charset=utf-8');
		\header("Content-Security-Policy: default-src 'none'; sandbox");
		\header('X-Content-Type-Options: nosniff');
		\header('Cache-Control: no-store');
		\header('Expires: 0');
		\header('X-Robots-Tag: noindex');
		if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
			echo "Not found\n";
		}
		exit;
	}
}
