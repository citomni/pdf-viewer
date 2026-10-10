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

namespace CitOmni\PdfViewer\Tests\Verify;

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
 * Suite for the pdf-viewer:verify command through the real CitOmni CLI kernel.
 *
 * Needs `composer install` in the package root (citomni/cli is a dev requirement).
 *
 * Usage:
 *   php tests/verify/run.php
 */

if (\PHP_SAPI !== 'cli') {
	throw new \RuntimeException('CLI only.');
}

require \dirname(__DIR__) . '/support/fixtures.php';
strictErrors();
require requireVendor();

$root = tempDir('verify');

try {
	writeApp($root);

	check('pdf-viewer:verify confirms every file of the installed bundle', function () use ($root): void {
		$r = runPhp([__DIR__ . '/cli.php', $root, 'pdf-viewer:verify']);
		same(0, $r['exit'], \trim($r['stderr']));
		same(true, \str_contains($r['stdout'], 'Bundle ' . Bundle::KEY . ': ' . \count(Bundle::FILES) . ' files OK'), $r['stdout']);
	});

	check('pdf-viewer:verify --help describes the command', function () use ($root): void {
		$r = runPhp([__DIR__ . '/cli.php', $root, 'pdf-viewer:verify', '--help']);
		same(0, $r['exit'], \trim($r['stderr']));
		same(true, \str_contains($r['stdout'], 'Check the installed PDF viewer assets'), $r['stdout']);
	});

} finally {
	removeTree($root);
}

finish();
