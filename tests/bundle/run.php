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

namespace CitOmni\PdfViewer\Tests\Bundle;

use CitOmni\PdfViewer\Boot\Registry;
use CitOmni\PdfViewer\Constant\Bundle;
use CitOmni\PdfViewer\Constant\PackagePath;
use CitOmni\PdfViewer\Constant\Route;
use CitOmni\PdfViewer\Util\BundleManifest;
use function CitOmni\PdfViewer\Tests\Support\check;
use function CitOmni\PdfViewer\Tests\Support\finish;
use function CitOmni\PdfViewer\Tests\Support\runPhp;
use function CitOmni\PdfViewer\Tests\Support\same;
use function CitOmni\PdfViewer\Tests\Support\strictErrors;

/*
 * Isolated suite for the reader bundle: the generated manifest (Constant\Bundle) against
 * the files on disk, the manifest rules, and the route table built from Constant\Route.
 *
 * Needs no Composer autoloader.
 *
 * Usage:
 *   php tests/bundle/run.php
 */

if (\PHP_SAPI !== 'cli') {
	throw new \RuntimeException('CLI only.');
}

require \dirname(__DIR__) . '/support/fixtures.php';
strictErrors();

$src = \dirname(__DIR__, 2) . '/src';
foreach (['Constant/Route', 'Constant/PackagePath', 'Constant/Bundle', 'Util/BundleManifest', 'Boot/Registry'] as $file) {
	require $src . '/' . $file . '.php';
}


// -- 1. The committed manifest is current ---------------------------------------

check('tools/build-bundle.php --check passes (Bundle.php matches assets/ and the frame template)', function (): void {
	$r = runPhp([\dirname(__DIR__, 2) . '/tools/build-bundle.php', '--check']);
	same(0, $r['exit'], \trim($r['stderr'] . $r['stdout']));
});

check('every listed file exists with the listed size and SHA-256', function (): void {
	foreach (Bundle::FILES as $path => [$bytes, $sha]) {
		$file = PackagePath::ASSET_DIR . '/' . $path;
		same(true, \is_file($file), $path);
		same($bytes, \filesize($file), $path . ' size');
		same($sha, \hash_file('sha256', $file), $path . ' sha256');
	}
	same(\array_sum(\array_column(Bundle::FILES, 0)), Bundle::BYTES, 'BYTES');
});

check('the bundle key is the hash of the version list (assets + frame template)', function (): void {
	$versions = BundleManifest::versionList(Bundle::FILES, PackagePath::FRAME_TEMPLATE_ID, \hash_file('sha256', PackagePath::FRAME_TEMPLATE));
	same(Bundle::KEY, BundleManifest::key($versions));
	same(1, \preg_match('/^[0-9a-f]{12}$/', Bundle::KEY), 'key format');
	same(1, \substr_count($versions, "templates/frame.php\t"), 'template in the version list');
});

check('every file below assets/ is listed, and no PHP file is published', function (): void {
	$root = \realpath(PackagePath::ASSET_DIR);
	$onDisk = [];
	foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS)) as $f) {
		$onDisk[] = \str_replace(\DIRECTORY_SEPARATOR, '/', \substr($f->getPathname(), \strlen($root) + 1));
	}
	\sort($onDisk, \SORT_STRING);
	same(\array_keys(Bundle::FILES), $onDisk);
	foreach (\array_keys(Bundle::FILES) as $path) {
		same(false, \str_ends_with($path, '.php'), $path);
	}
});

check('OCR_LANGUAGES are the language data files in the bundle', function (): void {
	same(['dan', 'eng'], Bundle::OCR_LANGUAGES);
	foreach (Bundle::OCR_LANGUAGES as $lang) {
		same(true, isset(Bundle::FILES['vendor/tessdata/' . $lang . '.traineddata.gz']), $lang);
	}
});


// -- 2. Manifest rules ------------------------------------------------------------

check('publishable paths: plain segments, no dot files, no "..", no PHP, bounded depth', function (): void {
	foreach (['reader/reader.mjs', 'vendor/pdfjs/web/images/loading-icon.gif', 'a/b/c/d/e'] as $ok) {
		same(true, BundleManifest::isPublishablePath($ok), $ok);
	}
	foreach (['', '/reader.mjs', 'reader//x.mjs', '.htaccess', 'reader/.hidden', 'a/../b', 'x..y', 'x.php', 'x.PHP', 'a b', 'a\\b', 'a/b/c/d/e/f', "a\0b", 'æ.js'] as $bad) {
		same(false, BundleManifest::isPublishablePath($bad), \var_export($bad, true));
	}
	foreach (\array_keys(Bundle::FILES) as $path) {
		same(true, BundleManifest::isPublishablePath($path), $path);
	}
});

check('no two listed paths differ only in case (case-insensitive routing)', function (): void {
	$lower = \array_map('strtolower', \array_keys(Bundle::FILES));
	same(\count($lower), \count(\array_unique($lower)));
});

check('the frame template references only listed assets', function (): void {
	$tpl = (string)\file_get_contents(PackagePath::FRAME_TEMPLATE);
	\preg_match_all('#\$e\(\$assetBase\) \?>([A-Za-z0-9._/-]+)#', $tpl, $m);
	same(3, \count($m[1]), 'stylesheets and entry module');
	foreach ($m[1] as $path) {
		same(true, isset(Bundle::FILES[$path]), $path);
	}
});


// -- 3. Routes ----------------------------------------------------------------------

check('ROUTES_HTTP has the frame route and one asset route per depth, GET only', function (): void {
	$regex = Registry::ROUTES_HTTP['regex'];
	$expected = [Route::FRAME . '/{bundle}'];
	$segments = [];
	for ($depth = 1; $depth <= Route::MAX_ASSET_DEPTH; $depth++) {
		$segments[] = '{p' . $depth . '}';
		$expected[] = Route::ASSETS . '/{bundle}/' . \implode('/', $segments);
	}
	same($expected, \array_keys($regex));
	foreach ($regex as $path => $route) {
		same(['GET'], $route['methods'], $path);
	}
	same(\count(Registry::ROUTES_HTTP), 1, 'only regex routes');
});

check('the deepest listed asset fits the deepest route', function (): void {
	$max = 0;
	foreach (\array_keys(Bundle::FILES) as $path) {
		$max = \max($max, \substr_count($path, '/') + 1);
	}
	same(true, $max <= Route::MAX_ASSET_DEPTH, "depth {$max}");
});

check('CFG_HTTP ships a baseline for every pdf_viewer key the service reads', function (): void {
	$cfg = Registry::CFG_HTTP['pdf_viewer'];
	same(['language', 'limits', 'usable_text', 'host', 'ocr', 'preload', 'engines', 'diagnostics'], \array_keys($cfg));
	same(null, $cfg['language']);
	same(['chromium' => true, 'webkit' => false, 'gecko' => false], $cfg['engines'], 'only the engine that passed the isolation tests is on');
	same(false, $cfg['diagnostics']);
	same('auto', $cfg['preload']);
	same(Bundle::OCR_LANGUAGES, $cfg['ocr']['languages']);
});

finish();
