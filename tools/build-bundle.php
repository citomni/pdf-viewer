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

/*
 * Build (or check) src/Constant/Bundle.php from the files below assets/.
 *
 * Usage:
 *   php tools/build-bundle.php           Write src/Constant/Bundle.php.
 *   php tools/build-bundle.php --check   Exit 1 when Bundle.php is not what a build would write.
 *
 * Behavior:
 * - Every regular file below assets/ is published; the build fails on a path the asset
 *   route could not serve (see BundleManifest::isPublishablePath()) and on two paths that
 *   differ only in case (http.router_case_insensitive lowercases request paths).
 * - Files are hashed (SHA-256); the version list adds templates/frame.php; the bundle key
 *   is the first 12 hex characters of SHA-256 over the version list.
 * - OCR languages are the language data files present in assets/vendor/tessdata/.
 * - The output is deterministic: the same files give a byte-identical Bundle.php.
 *
 * Notes:
 * - Standalone: needs no Composer autoloader.
 * - Run after tools/vendor-sync.sh and after every change below assets/ or in
 *   templates/frame.php. tests/bundle checks that the committed file is current.
 */

namespace CitOmni\PdfViewer\Tools;

use CitOmni\PdfViewer\Constant\PackagePath;
use CitOmni\PdfViewer\Util\BundleManifest;

if (\PHP_SAPI !== 'cli') {
	throw new \RuntimeException('CLI only.');
}

require __DIR__ . '/../src/Constant/Route.php';
require __DIR__ . '/../src/Constant/PackagePath.php';
require __DIR__ . '/../src/Util/BundleManifest.php';


/**
 * Scan the asset directory.
 *
 * @param  string  $dir  Absolute asset directory.
 * @return array<string, array{0: int, 1: string}>  path => [bytes, sha256], sorted by path.
 * @throws \RuntimeException  On an unpublishable path or a case-insensitive collision.
 */
function scanAssets(string $dir): array {
	$root = \realpath($dir);
	if ($root === false) {
		throw new \RuntimeException("Asset directory not found: {$dir}");
	}
	$files = [];
	$lower = [];
	$it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS));
	foreach ($it as $file) {
		/** @var \SplFileInfo $file */
		if (!$file->isFile()) {
			continue;
		}
		$path = \str_replace(\DIRECTORY_SEPARATOR, '/', \substr($file->getPathname(), \strlen($root) + 1));
		if (!BundleManifest::isPublishablePath($path)) {
			throw new \RuntimeException("Refusing to publish asset with unexpected path: {$path}");
		}
		$key = \strtolower($path);
		if (isset($lower[$key])) {
			throw new \RuntimeException("Asset paths differ only in case: {$lower[$key]} and {$path}");
		}
		$lower[$key] = $path;
		$files[$path] = [(int)$file->getSize(), \hash_file('sha256', $file->getPathname())];
	}
	\ksort($files, \SORT_STRING);
	return $files;
}


/**
 * OCR languages present in the bundle (from vendor/tessdata/<lang>.traineddata.gz).
 *
 * @param  array<string, array{0: int, 1: string}>  $files
 * @return list<string>
 */
function ocrLanguages(array $files): array {
	$langs = [];
	foreach (\array_keys($files) as $path) {
		if (\preg_match('#^vendor/tessdata/([a-z_]+)\.traineddata\.gz$#', $path, $m) === 1) {
			$langs[] = $m[1];
		}
	}
	\sort($langs, \SORT_STRING);
	return $langs;
}


/**
 * Render src/Constant/Bundle.php.
 *
 * @param  array<string, array{0: int, 1: string}>  $files
 * @param  string                                   $key
 * @param  list<string>                             $langs
 * @return string
 */
function renderBundleClass(array $files, string $key, array $langs): string {
	$bytes = 0;
	$rows = '';
	foreach ($files as $path => [$size, $sha]) {
		$bytes += $size;
		$rows .= "\t\t'{$path}' => [{$size}, '{$sha}'],\n";
	}
	$langList = $langs === [] ? '[]' : "['" . \implode("', '", $langs) . "']";
	$count = \count($files);

	return <<<PHP
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

namespace CitOmni\PdfViewer\Constant;

/**
 * Generated manifest of the reader bundle: the files the asset route may serve.
 *
 * Do not edit. Regenerate with "php tools/build-bundle.php" after any change below
 * assets/ or in templates/frame.php; "php tools/build-bundle.php --check" fails while
 * this file is stale.
 *
 * Behavior:
 * - The asset route serves exactly the paths in FILES (exact lookup) and compares the file
 *   size on disk with the listed size on every request.
 * - KEY is part of every frame and asset URL. It changes whenever a listed file or the
 *   frame template changes, so the immutable asset responses never go stale.
 *
 * Notes:
 * - {$count} files, {$bytes} bytes.
 * - The pdf-viewer:verify command re-hashes the installed files against FILES.
 */
final class Bundle {

	/** Bundle key: first 12 hex characters of SHA-256 over the version list. */
	public const string KEY = '{$key}';

	/** OCR languages whose language data is in the bundle. */
	public const array OCR_LANGUAGES = {$langList};

	/** Total size of the files in bytes. */
	public const int BYTES = {$bytes};

	/**
	 * Files: path below assets/ => [bytes, sha256].
	 *
	 * @var array<string, array{0: int, 1: string}>
	 */
	public const array FILES = [
{$rows}	];
}

PHP;
}


// -- 1. Compute ---------------------------------------------------------------------

$files = scanAssets(PackagePath::ASSET_DIR);
$templateSha = \hash_file('sha256', PackagePath::FRAME_TEMPLATE);
$versionList = BundleManifest::versionList($files, PackagePath::FRAME_TEMPLATE_ID, $templateSha);
$key = BundleManifest::key($versionList);
$source = renderBundleClass($files, $key, ocrLanguages($files));

// -- 2. Write or check --------------------------------------------------------------

$target = PackagePath::BUNDLE_CLASS_FILE;
if (\in_array('--check', \array_slice($argv, 1), true)) {
	$current = \is_file($target) ? \file_get_contents($target) : '';
	if ($current !== $source) {
		\fwrite(\STDERR, "src/Constant/Bundle.php is stale (expected key {$key}). Run: php tools/build-bundle.php\n");
		exit(1);
	}
	\fwrite(\STDOUT, "src/Constant/Bundle.php is current (key {$key}, " . \count($files) . " files)\n");
	exit(0);
}

if (\file_put_contents($target, $source) === false) {
	throw new \RuntimeException("Cannot write {$target}");
}
\fwrite(\STDOUT, "Wrote src/Constant/Bundle.php: key {$key}, " . \count($files) . ' files, ' . \array_sum(\array_column($files, 0)) . " bytes\n");
