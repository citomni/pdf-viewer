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

namespace CitOmni\PdfViewer\Util;

use CitOmni\PdfViewer\Constant\Route;

/**
 * Pure rules of the bundle manifest: publishable paths, version list and bundle key.
 *
 * Definitions:
 * - Asset manifest: the files the asset route may serve, as path below assets/ =>
 *   [bytes, sha256]. Everything else is 404.
 * - Version list: one line "<name>\t<sha256>\n" per file that determines the reader's
 *   behaviour (every asset as "assets/<path>", plus the frame template), sorted by name
 *   in byte order.
 * - Bundle key: the first 12 hex characters of SHA-256 over the version list. It is part
 *   of every asset URL, so a changed file always gets a new URL (immutable caching).
 *
 * Used by tools/build-bundle.php (writes Constant\Bundle), the pdf-viewer:verify command
 * and the tests. No App, no IO.
 */
final class BundleManifest {

	/** Path segment: starts with a letter or digit, then letters, digits, ".", "_" or "-". */
	private const string SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]*';


	/**
	 * Whether an asset path may be published under the asset route.
	 *
	 * Behavior:
	 * - Segments as in SEGMENT, separated by "/", at most Route::MAX_ASSET_DEPTH segments.
	 * - No dot files, no ".." and no PHP files.
	 *
	 * @param  string  $path  Path below assets/ with "/" separators.
	 * @return bool
	 */
	public static function isPublishablePath(string $path): bool {
		if (\preg_match('#^' . self::SEGMENT . '(?:/' . self::SEGMENT . ')*$#', $path) !== 1) {
			return false;
		}
		if (\str_contains($path, '..') || \str_ends_with(\strtolower($path), '.php')) {
			return false;
		}
		return \substr_count($path, '/') < Route::MAX_ASSET_DEPTH;
	}


	/**
	 * Build the version list.
	 *
	 * @param  array<string, array{0: int, 1: string}>  $files        Asset manifest.
	 * @param  string                                   $templateId   Version list name of the frame template.
	 * @param  string                                   $templateSha  SHA-256 of the frame template.
	 * @return string
	 */
	public static function versionList(array $files, string $templateId, string $templateSha): string {
		$lines = [];
		foreach ($files as $path => $entry) {
			$lines['assets/' . $path] = $entry[1];
		}
		$lines[$templateId] = $templateSha;
		\ksort($lines, \SORT_STRING);

		$out = '';
		foreach ($lines as $name => $sha) {
			$out .= $name . "\t" . $sha . "\n";
		}
		return $out;
	}


	/**
	 * Bundle key of a version list.
	 *
	 * @param  string  $versionList  Result of versionList().
	 * @return string  12 lowercase hex characters.
	 */
	public static function key(string $versionList): string {
		return \substr(\hash('sha256', $versionList), 0, 12);
	}
}
