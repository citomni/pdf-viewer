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
 * AssetController: Serves the files of the reader bundle (reader, host module, PDF.js,
 * Tesseract.js and language data).
 *
 * Routing:
 * - GET|HEAD /_pdf-viewer/assets/{bundle key}/{path}, one regex route per path depth
 *   (Registry::ROUTES_HTTP). The router passes the key and the path segments.
 *
 * Behavior:
 * - Exact lookup of the joined path in Bundle::FILES. Anything else is a bare 404 with
 *   Access-Control-Allow-Origin, so the frame sees "404" instead of a CORS error: other
 *   bundle keys, files on disk that are not listed, encoded or relative variants.
 * - The file size on disk must equal the listed size; otherwise the deploy is incomplete
 *   and the request fails with a \RuntimeException (the error handler logs it). The full
 *   SHA-256 check is the pdf-viewer:verify command.
 * - Responses: correct Content-Type, Content-Length, ETag (first 32 hex of the SHA-256),
 *   "public, max-age=31536000, immutable" (the bundle key changes with every file change),
 *   Expires (so mod_expires adds nothing), Access-Control-Allow-Origin: * (the frame has an
 *   opaque origin; its module scripts, stylesheets and fetches are CORS requests),
 *   Cross-Origin-Resource-Policy: cross-origin, nosniff, and
 *   "Content-Security-Policy: default-src 'none'; sandbox" (inert if opened as a document).
 * - If-None-Match with the ETag gives 304. No range support.
 * - Never starts a session, never sets a cookie, never redirects.
 *
 * Notes:
 * - With http.router_case_insensitive (local convenience) the router lowercases the path;
 *   the lookup then falls back to a lowercase index of the manifest.
 * - Output buffers are discarded before the file is streamed and the action exits after
 *   it, so the body is exactly the file.
 * - Responses carry no cookies and are public: a shared cache in front of PHP (e.g.
 *   Varnish) may serve them for requests without cookies.
 */
final class AssetController extends BaseController {

	/** Content-Type by extension; everything else is application/octet-stream. */
	private const array TYPES = [
		'mjs'  => 'text/javascript; charset=utf-8',
		'js'   => 'text/javascript; charset=utf-8',
		'css'  => 'text/css; charset=utf-8',
		'wasm' => 'application/wasm',
		'svg'  => 'image/svg+xml',
		'png'  => 'image/png',
		'gif'  => 'image/gif',
		'jpg'  => 'image/jpeg',
	];

	/** Lifetime of the immutable asset responses (seconds). */
	private const int MAX_AGE = 31_536_000;


	/**
	 * GET /_pdf-viewer/assets/{bundle}/{path}
	 *
	 * @param  string  $bundle    Bundle key from the URL.
	 * @param  string  ...$segments  Path segments below the asset base.
	 * @return never
	 * @throws \RuntimeException  When a listed file is missing or has another size on disk.
	 */
	public function asset(string $bundle, string ...$segments): never {
		$path = \implode('/', $segments);
		$entry = null;
		if ($bundle === Bundle::KEY) {
			$entry = Bundle::FILES[$path] ?? null;
			if ($entry === null && (bool)($this->app->cfg->http->router_case_insensitive ?? false)) {
				$path = self::caseInsensitivePath($path);
				$entry = $path !== null ? Bundle::FILES[$path] : null;
			}
		}
		if ($entry === null) {
			self::notFound();
		}

		[$bytes, $sha] = $entry;
		$file = PackagePath::ASSET_DIR . '/' . $path;
		$size = \is_file($file) ? \filesize($file) : false;
		if ($size !== $bytes) {
			throw new \RuntimeException("PDF viewer asset '{$path}' is " . ($size === false ? 'missing' : "{$size} bytes") . " on disk; the bundle lists {$bytes} bytes. Reinstall citomni/pdf-viewer, then run pdf-viewer:verify.");
		}

		$etag = '"' . \substr($sha, 0, 32) . '"';

		while (\ob_get_level() > 0) {
			\ob_end_clean();
		}
		\header_remove('Set-Cookie');
		\header('Cache-Control: public, max-age=' . self::MAX_AGE . ', immutable');
		\header('Expires: ' . \gmdate('D, d M Y H:i:s', \time() + self::MAX_AGE) . ' GMT');
		\header('ETag: ' . $etag);
		\header('Access-Control-Allow-Origin: *');
		\header('Cross-Origin-Resource-Policy: cross-origin');
		\header('X-Content-Type-Options: nosniff');
		\header("Content-Security-Policy: default-src 'none'; sandbox");

		if (self::etagMatches((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''), $etag)) {
			\http_response_code(304);
			exit;
		}

		$ext = \strtolower(\pathinfo($path, \PATHINFO_EXTENSION));
		\http_response_code(200);
		\header('Content-Type: ' . (self::TYPES[$ext] ?? 'application/octet-stream'));
		\header('Content-Length: ' . $bytes);
		\header('Accept-Ranges: none');
		if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
			\readfile($file);
		}
		exit;
	}


	/**
	 * Manifest path for a lowercased request path (case-insensitive routing only).
	 *
	 * @param  string  $path  Lowercased path.
	 * @return string|null  The listed path, or null.
	 */
	private static function caseInsensitivePath(string $path): ?string {
		foreach (Bundle::FILES as $listed => $_) {
			if (\strtolower($listed) === $path) {
				return $listed;
			}
		}
		return null;
	}


	/**
	 * Whether an If-None-Match header matches the ETag (weak comparison, RFC 9110).
	 *
	 * @param  string  $header  If-None-Match value.
	 * @param  string  $etag    Quoted ETag of the response.
	 * @return bool
	 */
	private static function etagMatches(string $header, string $etag): bool {
		if ($header === '') {
			return false;
		}
		foreach (\explode(',', $header) as $candidate) {
			$candidate = \trim($candidate);
			if ($candidate === '*') {
				return true;
			}
			if (\str_starts_with($candidate, 'W/')) {
				$candidate = \substr($candidate, 2);
			}
			if ($candidate === $etag) {
				return true;
			}
		}
		return false;
	}


	/**
	 * Bare 404 with CORS, so the frame sees the status: no session, no cookie, inert.
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
		\header('Access-Control-Allow-Origin: *');
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
