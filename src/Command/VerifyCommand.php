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

namespace CitOmni\PdfViewer\Command;

use CitOmni\Kernel\Command\BaseCommand;
use CitOmni\PdfViewer\Constant\Bundle;
use CitOmni\PdfViewer\Constant\PackagePath;
use CitOmni\PdfViewer\Util\BundleManifest;

/**
 * VerifyCommand: Check the installed reader bundle against its manifest.
 *
 * Usage:
 *   php bin/citomni pdf-viewer:verify
 *
 * Behavior:
 * - Every file in Bundle::FILES must exist with the listed size and SHA-256.
 * - The frame template must give the listed bundle key.
 * - Prints one line per problem and a summary; exit code 1 when anything differs.
 *
 * Notes:
 * - Run it after a deploy that copies files (FTP/SFTP). A transfer in text mode or a
 *   truncated upload corrupts the binary assets; the asset route only compares sizes.
 * - Read-only. Hashes about 22 MB.
 */
final class VerifyCommand extends BaseCommand {

	/**
	 * @return int  SUCCESS when the bundle is intact, FAILURE otherwise.
	 */
	protected function execute(): int {
		$problems = 0;
		$bytes = 0;

		foreach (Bundle::FILES as $path => [$size, $sha]) {
			$file = PackagePath::ASSET_DIR . '/' . $path;
			if (!\is_file($file)) {
				$this->error("missing   {$path}");
				$problems++;
				continue;
			}
			$actual = \filesize($file);
			if ($actual !== $size) {
				$this->error("size      {$path}: {$actual} bytes, expected {$size}");
				$problems++;
				continue;
			}
			if (\hash_file('sha256', $file) !== $sha) {
				$this->error("content   {$path}: SHA-256 differs");
				$problems++;
				continue;
			}
			$bytes += $size;
		}

		$templateSha = \is_file(PackagePath::FRAME_TEMPLATE) ? (string)\hash_file('sha256', PackagePath::FRAME_TEMPLATE) : '';
		$key = BundleManifest::key(BundleManifest::versionList(Bundle::FILES, PackagePath::FRAME_TEMPLATE_ID, $templateSha));
		if ($key !== Bundle::KEY) {
			$this->error('template  ' . PackagePath::FRAME_TEMPLATE_ID . ": gives bundle key {$key}, expected " . Bundle::KEY);
			$problems++;
		}

		if ($problems > 0) {
			$this->error("Bundle " . Bundle::KEY . ": {$problems} problem(s). Reinstall citomni/pdf-viewer (binary transfer).");
			return self::FAILURE;
		}

		$this->success('Bundle ' . Bundle::KEY . ': ' . \count(Bundle::FILES) . " files OK ({$bytes} bytes).");
		return self::SUCCESS;
	}
}
