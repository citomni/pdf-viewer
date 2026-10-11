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

namespace CitOmni\PdfViewer\Tests\Http;

use CitOmni\PdfViewer\Constant\Bundle;
use CitOmni\PdfViewer\Constant\PackagePath;
use CitOmni\PdfViewer\Controller\FrameController;
use CitOmni\PdfViewer\Tests\Support\FixtureServer;
use function CitOmni\PdfViewer\Tests\Support\check;
use function CitOmni\PdfViewer\Tests\Support\finish;
use function CitOmni\PdfViewer\Tests\Support\headerValues;
use function CitOmni\PdfViewer\Tests\Support\removeTree;
use function CitOmni\PdfViewer\Tests\Support\requireVendor;
use function CitOmni\PdfViewer\Tests\Support\same;
use function CitOmni\PdfViewer\Tests\Support\skip;
use function CitOmni\PdfViewer\Tests\Support\strictErrors;
use function CitOmni\PdfViewer\Tests\Support\tempDir;
use function CitOmni\PdfViewer\Tests\Support\writeApp;

/*
 * Integration suite for the frame and asset routes through the real CitOmni HTTP kernel
 * (router, error handler, this package as provider) in PHP's built-in web server.
 *
 * Needs `composer install` in the package root (citomni/kernel and citomni/http in vendor/).
 *
 * Usage:
 *   php tests/http/run.php
 */

if (\PHP_SAPI !== 'cli') {
	throw new \RuntimeException('CLI only.');
}

require \dirname(__DIR__) . '/support/fixtures.php';
strictErrors();
require requireVendor();

$key = Bundle::KEY;
$frame = '/_pdf-viewer/frame/' . $key;
$assets = '/_pdf-viewer/assets/' . $key . '/';
$root = tempDir('http');
$server = null;
$ciServer = null;
$fmServer = null;

/** First value of a header, or null. */
$header = static fn (array $r, string $name): ?string => headerValues($r['headers'], $name)[0] ?? null;

/** Reader configuration from the frame document's meta element. */
$readerConfig = static function (string $html): array {
	if (\preg_match('#<meta name="pdf-viewer-config" content="([^"]*)">#', $html, $m) !== 1) {
		throw new \RuntimeException('No reader configuration in the frame document.');
	}
	return \json_decode(\html_entity_decode($m[1], \ENT_QUOTES | \ENT_HTML5, 'UTF-8'), true, 512, \JSON_THROW_ON_ERROR);
};

try {
	writeApp($root . '/app');
	writeApp($root . '/ci', ['http' => ['router_case_insensitive' => true]]);
	$server = new FixtureServer($root . '/app/public', __DIR__ . '/server.php');
	$ciServer = new FixtureServer($root . '/ci/public', __DIR__ . '/server.php');
	// citomni/http's Fetch Metadata policy exists from the version that ships this class.
	$fetchMetadata = \class_exists(\CitOmni\Http\Policy\FetchMetadataPolicy::class);
	if ($fetchMetadata) {
		writeApp($root . '/fm', ['security' => ['fetch_metadata' => ['enabled' => true]]]);
		$fmServer = new FixtureServer($root . '/fm/public', __DIR__ . '/server.php');
	}
	$origin = $server->baseUrl;


	// -- 1. Frame ---------------------------------------------------------------------

	check('The frame document has the sandbox CSP, no-store, no cookie and the reader configuration', function () use ($server, $frame, $origin, $header, $readerConfig): void {
		$r = $server->request('GET', $frame, ['Cookie' => 'CITSESSID=abc123; other=1']);
		same(200, $r['status']);
		same('text/html; charset=utf-8', $header($r, 'Content-Type'));
		same(FrameController::csp($origin . '/_pdf-viewer/assets/' . Bundle::KEY . '/', $origin), $header($r, 'Content-Security-Policy'));
		same('nosniff', $header($r, 'X-Content-Type-Options'));
		same('no-referrer', $header($r, 'Referrer-Policy'));
		same('no-store', $header($r, 'Cache-Control'));
		same('noindex', $header($r, 'X-Robots-Tag'));
		same([], headerValues($r['headers'], 'Set-Cookie'), 'Set-Cookie');
		same((string)\strlen($r['body']), $header($r, 'Content-Length'));
		$cfg = $readerConfig($r['body']);
		same($origin, $cfg['appOrigin']);
		same($origin . '/_pdf-viewer/assets/' . Bundle::KEY . '/', $cfg['assetBase']);
		same(Bundle::KEY, $cfg['bundle']);
		same('da', $cfg['language'], 'language follows locale.language');
		same(['dan', 'eng'], $cfg['ocrLanguages']);
		same(false, $cfg['diagnostics']);
		same(1000, $cfg['limits']['maxPages']);
		same(50, $cfg['limits']['usableText']['minAlnum']);
		same(3, \preg_match_all('#(?:href|src)="' . \preg_quote($cfg['assetBase'], '#') . '#', $r['body']), 'stylesheets and entry module from the asset base');
		same(2, \substr_count($r['body'], 'crossorigin="anonymous"'), 'stylesheets are CORS requests');
		same(1, \preg_match('#<html lang="da">#', $r['body']));
	});

	check('HEAD on the frame sends the headers without a body', function () use ($server, $frame, $header): void {
		$get = $server->request('GET', $frame);
		$head = $server->request('HEAD', $frame);
		same(200, $head['status']);
		same('', $head['body']);
		same((string)\strlen($get['body']), $header($head, 'Content-Length'));
	});

	check('Another bundle key gives a bare, inert 404 for the frame', function () use ($server, $header): void {
		$r = $server->request('GET', '/_pdf-viewer/frame/000000000000');
		same(404, $r['status']);
		same('text/plain; charset=utf-8', $header($r, 'Content-Type'));
		same("default-src 'none'; sandbox", $header($r, 'Content-Security-Policy'));
		same("Not found\n", $r['body']);
	});

	check('The frame route allows GET, HEAD and OPTIONS only', function () use ($server, $frame, $header): void {
		$r = $server->request('POST', $frame);
		same(405, $r['status']);
		same('GET, HEAD, OPTIONS', $header($r, 'Allow'));
		$o = $server->request('OPTIONS', $frame);
		same(204, $o['status']);
		same('GET, HEAD, OPTIONS', $header($o, 'Allow'));
	});


	// -- 2. Assets ----------------------------------------------------------------------

	check('An asset is the file, byte for byte, with immutable caching, CORS and an inert CSP', function () use ($server, $assets, $header): void {
		$path = 'reader/reader.mjs';
		[$bytes, $sha] = Bundle::FILES[$path];
		$r = $server->request('GET', $assets . $path, ['Cookie' => 'CITSESSID=abc123']);
		same(200, $r['status']);
		same(\file_get_contents(PackagePath::ASSET_DIR . '/' . $path), $r['body']);
		same('text/javascript; charset=utf-8', $header($r, 'Content-Type'));
		same((string)$bytes, $header($r, 'Content-Length'));
		same('public, max-age=31536000, immutable', $header($r, 'Cache-Control'));
		same('"' . \substr($sha, 0, 32) . '"', $header($r, 'ETag'));
		same('*', $header($r, 'Access-Control-Allow-Origin'));
		same('cross-origin', $header($r, 'Cross-Origin-Resource-Policy'));
		same('nosniff', $header($r, 'X-Content-Type-Options'));
		same("default-src 'none'; sandbox", $header($r, 'Content-Security-Policy'));
		same('none', $header($r, 'Accept-Ranges'));
		same([], headerValues($r['headers'], 'Set-Cookie'), 'Set-Cookie');
		$expires = \strtotime((string)$header($r, 'Expires'));
		same(true, $expires !== false && $expires > \time() + 364 * 86400, 'Expires about a year ahead');
	});

	check('Content-Type by extension; everything else is application/octet-stream', function () use ($server, $assets, $header): void {
		$cases = [
			'reader/reader.css'                         => 'text/css; charset=utf-8',
			'vendor/pdfjs/wasm/openjpeg.wasm'           => 'application/wasm',
			'vendor/pdfjs/web/images/loading-icon.gif'  => 'image/gif',
			'vendor/pdfjs/web/images/checkmark.svg'     => 'image/svg+xml',
			'vendor/tesseract/worker.min.js'            => 'text/javascript; charset=utf-8',
			'vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap'    => 'application/octet-stream',
			'vendor/tessdata/dan.traineddata.gz'        => 'application/octet-stream',
			'vendor/pdfjs/LICENSE'                      => 'application/octet-stream',
		];
		foreach ($cases as $path => $type) {
			$r = $server->request('HEAD', $assets . $path);
			same(200, $r['status'], $path);
			same($type, $header($r, 'Content-Type'), $path);
		}
	});

	check('Every path depth of the bundle is routed', function () use ($server, $assets): void {
		$byDepth = [];
		foreach (\array_keys(Bundle::FILES) as $path) {
			$byDepth[\substr_count($path, '/') + 1] ??= $path;
		}
		same(true, \count($byDepth) >= 4, 'depths present');
		foreach ($byDepth as $depth => $path) {
			$r = $server->request('GET', $assets . $path);
			same(200, $r['status'], "depth {$depth}: {$path}");
			same(Bundle::FILES[$path][0], \strlen($r['body']), $path);
		}
	});

	check('HEAD on an asset sends the headers without a body', function () use ($server, $assets, $header): void {
		$path = 'vendor/pdfjs/build/pdf.min.mjs';
		$r = $server->request('HEAD', $assets . $path);
		same(200, $r['status']);
		same('', $r['body']);
		same((string)Bundle::FILES[$path][0], $header($r, 'Content-Length'));
	});

	check('If-None-Match with the ETag (strong, weak or in a list) gives 304 without a body', function () use ($server, $assets, $header): void {
		$path = 'reader/protocol.mjs';
		$etag = '"' . \substr(Bundle::FILES[$path][1], 0, 32) . '"';
		foreach ([$etag, 'W/' . $etag, '"other", ' . $etag, '*'] as $inm) {
			$r = $server->request('GET', $assets . $path, ['If-None-Match' => $inm]);
			same(304, $r['status'], $inm);
			same('', $r['body'], $inm);
			same($etag, $header($r, 'ETag'), $inm);
		}
		same(200, $server->request('GET', $assets . $path, ['If-None-Match' => '"other"'])['status']);
	});

	check('Anything outside the manifest is 404, with CORS so the frame sees the status', function () use ($server, $assets, $header, $key): void {
		$cases = [
			$assets . 'reader/nope.mjs',
			'/_pdf-viewer/assets/000000000000/reader/reader.mjs',
			$assets . '%2e%2e/templates/frame.php',
			$assets . 'reader/%2e%2e/%2e%2e/composer.json',
			$assets . 'reader%5Creader.mjs',
			$assets . 'READER/reader.mjs',
			$assets . 'reader/reader.mjs%00',
			$assets . 'reader/reader.mjs.php',
		];
		foreach ($cases as $target) {
			$r = $server->request('GET', $target);
			same(404, $r['status'], $target);
			same('*', $header($r, 'Access-Control-Allow-Origin'), $target);
			same('no-store', $header($r, 'Cache-Control'), $target);
			same("Not found\n", $r['body'], $target);
		}
		// Deeper than any asset route, or empty segments: the router's own 404.
		foreach ([$assets . 'a/b/c/d/e/f', $assets . 'reader//reader.mjs', '/_pdf-viewer/assets/' . $key] as $target) {
			same(404, $server->request('GET', $target)['status'], $target);
		}
	});

	check('Asset routes are GET only', function () use ($server, $assets, $header): void {
		$r = $server->request('POST', $assets . 'reader/reader.mjs');
		same(405, $r['status']);
		same('GET, HEAD, OPTIONS', $header($r, 'Allow'));
	});

	check('The kernel\'s ?_perf footer is never appended to an asset or the frame', function () use ($server, $assets, $frame): void {
		$path = 'reader/i18n.mjs';
		same(\file_get_contents(PackagePath::ASSET_DIR . '/' . $path), $server->request('GET', $assets . $path . '?_perf=1')['body']);
		same(false, \str_contains($server->request('GET', $frame . '?_perf=1')['body'], 'Execution time'));
	});


	// -- 3. Mount path and case-insensitive routing --------------------------------------

	check('Under a mount path, URLs and CSP carry the path and the routes still match', function () use ($server, $frame, $assets, $readerConfig, $header): void {
		$r = $server->request('GET', '/sub' . $frame, ['X-Test-Base' => '/sub']);
		same(200, $r['status']);
		$cfg = $readerConfig($r['body']);
		same($server->baseUrl . '/sub/_pdf-viewer/assets/' . Bundle::KEY . '/', $cfg['assetBase']);
		same($server->baseUrl, $cfg['appOrigin'], 'origin without the path');
		same(true, \str_contains((string)$header($r, 'Content-Security-Policy'), "script-src {$cfg['assetBase']} "));
		same(200, $server->request('GET', '/sub' . $assets . 'reader/reader.mjs', ['X-Test-Base' => '/sub'])['status']);
	});

	check('With http.router_case_insensitive the lowercased path still finds mixed-case assets', function () use ($ciServer, $assets): void {
		$path = 'vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap';
		$r = $ciServer->request('GET', $assets . $path);
		same(200, $r['status']);
		same(\file_get_contents(PackagePath::ASSET_DIR . '/' . $path), $r['body']);
		same(200, $ciServer->request('GET', $assets . 'READER/READER.MJS')['status']);
	});


	// -- 4. With citomni/http's Fetch Metadata policy on --------------------------------

	$fmName = 'With the Fetch Metadata policy on, the frame\'s asset requests pass and other cross-site requests are refused';
	if (!$fetchMetadata) {
		skip($fmName, 'citomni/http without Policy\FetchMetadataPolicy');
	} else {
		check($fmName, function () use ($fmServer, $frame, $assets): void {
			// Requests of the opaque-origin frame and its workers are cross-site.
			$frameRequest = ['Sec-Fetch-Site' => 'cross-site', 'Sec-Fetch-Mode' => 'cors', 'Sec-Fetch-Dest' => 'script', 'Accept' => 'application/json'];
			same(200, $fmServer->request('GET', $assets . 'reader/reader.mjs', $frameRequest)['status'], 'asset');
			same(200, $fmServer->request('HEAD', $assets . 'vendor/tessdata/dan.traineddata.gz', $frameRequest)['status'], 'asset HEAD');
			same(404, $fmServer->request('GET', $assets . 'reader/missing.mjs', $frameRequest)['status'], 'unknown asset still reaches the route');
			// The host page loads the frame same-origin; nothing else is exempt.
			$embed = ['Sec-Fetch-Mode' => 'navigate', 'Sec-Fetch-Dest' => 'iframe', 'Accept' => 'application/json'];
			same(200, $fmServer->request('GET', $frame, ['Sec-Fetch-Site' => 'same-origin'] + $embed)['status'], 'frame from the host page');
			same(403, $fmServer->request('GET', $frame, ['Sec-Fetch-Site' => 'cross-site'] + $embed)['status'], 'frame embedded by another site');
			same(403, $fmServer->request('POST', $assets . 'reader/reader.mjs', $frameRequest)['status'], 'only GET and HEAD are exempt');
			same(403, $fmServer->request('GET', '/_pdf-viewer/other', $frameRequest)['status'], 'only the asset prefix is exempt');
		});
	}

} finally {
	$server?->stop();
	$ciServer?->stop();
	$fmServer?->stop();
	removeTree($root);
}

finish();
