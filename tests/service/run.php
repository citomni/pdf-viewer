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

namespace CitOmni\PdfViewer\Tests\Service;

use CitOmni\PdfViewer\Constant\Bundle;
use function CitOmni\PdfViewer\Tests\Support\check;
use function CitOmni\PdfViewer\Tests\Support\finish;
use function CitOmni\PdfViewer\Tests\Support\removeTree;
use function CitOmni\PdfViewer\Tests\Support\requireVendor;
use function CitOmni\PdfViewer\Tests\Support\runPhp;
use function CitOmni\PdfViewer\Tests\Support\same;
use function CitOmni\PdfViewer\Tests\Support\strictErrors;
use function CitOmni\PdfViewer\Tests\Support\tempDir;
use function CitOmni\PdfViewer\Tests\Support\writeApp;

/*
 * Suite for CitOmni\PdfViewer\Service\PdfViewer through the real kernel App: URLs and
 * origin from CITOMNI_PUBLIC_ROOT_URL, cfg.pdf_viewer mapping and the fail-fast checks.
 *
 * Each case runs tests/service/case.php in its own process with its own app root.
 * Needs `composer install` in the package root.
 *
 * Usage:
 *   php tests/service/run.php
 */

if (\PHP_SAPI !== 'cli') {
	throw new \RuntimeException('CLI only.');
}

require \dirname(__DIR__) . '/support/fixtures.php';
strictErrors();
require requireVendor();

$root = tempDir('service');
$n = 0;

/**
 * Run the service in a fresh app.
 *
 * @param  string                $rootUrl    CITOMNI_PUBLIC_ROOT_URL.
 * @param  array<string, mixed>  $pdfViewer  cfg.pdf_viewer overrides (deep-merged by the kernel).
 * @param  array<string, mixed>  $common     citomni_cfg.php top-level keys.
 * @return array<string, mixed>
 */
$service = static function (string $rootUrl, array $pdfViewer = [], array $common = []) use ($root, &$n): array {
	$dir = $root . '/case' . (++$n);
	writeApp($dir, $pdfViewer === [] ? [] : ['pdf_viewer' => $pdfViewer], $common);
	$r = runPhp([__DIR__ . '/case.php', $dir, $rootUrl]);
	if ($r['exit'] !== 0) {
		throw new \RuntimeException('case.php failed: ' . \trim($r['stderr'] . $r['stdout']));
	}
	return \json_decode($r['stdout'], true, 512, \JSON_THROW_ON_ERROR);
};

/** Assert that the service refused the configuration with a message containing $needle. */
$refused = static function (array $out, string $needle, string $label = ''): void {
	same(false, $out['ok'], $label . ' refused');
	same('RuntimeException', $out['error'], $label);
	same(true, \str_contains($out['message'], $needle), $label . ': ' . $out['message']);
};

$key = Bundle::KEY;

try {

	// -- 1. URLs and origin -------------------------------------------------------------

	check('URLs are built from the public root URL and the bundle key', function () use ($service, $key): void {
		$o = $service('https://app.test');
		same(true, $o['ok']);
		same($key, $o['bundleKey']);
		same('https://app.test', $o['appOrigin']);
		same("https://app.test/_pdf-viewer/frame/{$key}", $o['frameUrl']);
		same("https://app.test/_pdf-viewer/assets/{$key}/", $o['assetBaseUrl']);
		same("https://app.test/_pdf-viewer/assets/{$key}/host/pdf-viewer.mjs", $o['hostModuleUrl']);
		same("https://app.test/_pdf-viewer/assets/{$key}/host/pdf-viewer.css", $o['hostStylesheetUrl']);
		same([
			'script-src'  => ["https://app.test/_pdf-viewer/assets/{$key}/"],
			'style-src'   => ["https://app.test/_pdf-viewer/assets/{$key}/"],
			'connect-src' => ["https://app.test/_pdf-viewer/assets/{$key}/"],
			'frame-src'   => ['https://app.test/_pdf-viewer/frame/'],
		], $o['cspSources']);
	});

	check('The origin is serialized like the browser does: lowercase host, no default port, no path', function () use ($service, $key): void {
		$o = $service('https://App.Test:443/');
		same('https://app.test', $o['appOrigin']);
		same("https://App.Test:443/_pdf-viewer/frame/{$key}", $o['frameUrl']);
		$o = $service('http://localhost:8080/base');
		same('http://localhost:8080', $o['appOrigin']);
		same("http://localhost:8080/base/_pdf-viewer/assets/{$key}/", $o['assetBaseUrl']);
		same(['http://localhost:8080/base/_pdf-viewer/frame/'], $o['cspSources']['frame-src']);
	});

	check('A public root URL that is not an absolute http(s) URL without query/fragment/credentials is refused', function () use ($service, $refused): void {
		foreach (['app.test', 'ftp://app.test', 'https://app.test/?x=1', 'https://app.test/#x', 'https://user:pw@app.test', 'https://app.test/a b', 'https://app.test/a;b', "https://app.test/a'b"] as $url) {
			$refused($service($url), 'CITOMNI_PUBLIC_ROOT_URL', $url);
		}
	});


	// -- 2. Configuration mapping -------------------------------------------------------

	check('The host configuration carries URLs, limits, timeouts and policies (baseline values)', function () use ($service, $key): void {
		$h = $service('https://app.test')['hostConfig'];
		same(['version', 'bundle', 'appOrigin', 'frameUrl', 'assetBase', 'frameTitle', 'limits', 'timeouts', 'ocrLanguages', 'preload', 'engines'], \array_keys($h));
		same(1, $h['version']);
		same($key, $h['bundle']);
		same('Dokument', $h['frameTitle']);
		same(['maxPages' => 1000, 'maxTextItemsPerPage' => 20000, 'maxItemTextLength' => 2000, 'maxFileBytes' => 52428800], $h['limits']);
		same(['readyMs' => 15000, 'startAfterLoadMs' => 5000, 'inactivityMs' => 60000, 'openMs' => 180000, 'ocrPageMs' => 90000], $h['timeouts']);
		same(['dan', 'eng'], $h['ocrLanguages']);
		same('auto', $h['preload']);
		same(['chromium' => true, 'webkit' => false, 'gecko' => false], $h['engines']);
	});

	check('The reader configuration carries the frame limits and the usable-text rule', function () use ($service): void {
		$r = $service('https://app.test')['readerConfig'];
		same(['appOrigin', 'assetBase', 'bundle', 'language', 'ocrLanguages', 'diagnostics', 'limits'], \array_keys($r));
		same([
			'maxFileBytes' => 52428800, 'maxPages' => 1000, 'maxImagePixels' => 50000000, 'maxPdfImagePixels' => 50000000,
			'maxDisplayCanvasPixels' => 16777216, 'maxOcrPixels' => 10000000, 'ocrDpi' => 300, 'ocrTimeoutMs' => 60000,
			'handshakeTimeoutMs' => 10000, 'workerStartTimeoutMs' => 20000, 'maxTextItemsPerPage' => 20000, 'maxItemTextLength' => 2000,
			'usableText' => ['minAlnum' => 50, 'minAlnumRatio' => 0.6, 'maxJunkRatio' => 0.1],
		], $r['limits']);
	});

	check('Overrides reach both configurations', function () use ($service): void {
		$o = $service('https://app.test', ['engines' => ['webkit' => true], 'diagnostics' => true, 'preload' => 'never', 'ocr' => ['languages' => ['dan']], 'limits' => ['max_pages' => 50]]);
		same(['chromium' => true, 'webkit' => true, 'gecko' => false], $o['hostConfig']['engines']);
		same(['chromium' => false, 'webkit' => false, 'gecko' => false], $service('https://app.test', ['engines' => ['chromium' => false]])['hostConfig']['engines']);
		same('never', $o['hostConfig']['preload']);
		same(['dan'], $o['hostConfig']['ocrLanguages']);
		same(['dan'], $o['readerConfig']['ocrLanguages']);
		same(true, $o['readerConfig']['diagnostics']);
		same(50, $o['hostConfig']['limits']['maxPages']);
		same(50, $o['readerConfig']['limits']['maxPages']);
	});

	check('Language: explicit setting, else locale.language when supported, else English', function () use ($service): void {
		$locale = static fn (string $lang): array => ['locale' => ['language' => $lang, 'icu_locale' => 'en_US', 'timezone' => 'UTC', 'charset' => 'UTF-8']];
		same('da', $service('https://app.test')['language']);
		same('en', $service('https://app.test', [], $locale('fr'))['language']);
		same('Document', $service('https://app.test', [], $locale('fr'))['hostConfig']['frameTitle']);
		same('en', $service('https://app.test', ['language' => 'en'])['language']);
		same('da', $service('https://app.test', ['language' => 'da'], $locale('en'))['language']);
	});


	// -- 3. Fail fast on invalid configuration ------------------------------------------

	check('Invalid configuration fails fast with a message naming the key', function () use ($service, $refused): void {
		$refused($service('https://app.test', ['language' => 'de']), 'pdf_viewer.language');
		$refused($service('https://app.test', ['ocr' => ['languages' => ['deu']]]), 'pdf_viewer.ocr.languages');
		$refused($service('https://app.test', ['ocr' => ['languages' => []]]), 'pdf_viewer.ocr.languages');
		$refused($service('https://app.test', ['preload' => 'sometimes']), 'pdf_viewer.preload');
		$refused($service('https://app.test', ['limits' => ['max_pages' => 0]]), 'pdf_viewer.limits.max_pages');
		$refused($service('https://app.test', ['limits' => ['max_pages' => '1000']]), 'pdf_viewer.limits.max_pages');
		$refused($service('https://app.test', ['usable_text' => ['min_alnum' => -1]]), 'pdf_viewer.usable_text.min_alnum');
		$refused($service('https://app.test', ['host' => ['ready_timeout_ms' => 1.5]]), 'pdf_viewer.host.ready_timeout_ms');
		$refused($service('https://app.test', ['engines' => ['trident' => true]]), 'pdf_viewer.engines');
		$refused($service('https://app.test', ['engines' => ['webkit' => 'yes']]), 'pdf_viewer.engines');
		$refused($service('https://app.test', ['engines' => ['chromium']]), 'pdf_viewer.engines');
	});

} finally {
	removeTree($root);
}

finish();
