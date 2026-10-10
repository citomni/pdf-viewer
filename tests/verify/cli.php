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

/*
 * CLI entry point for tests/verify/run.php (like an app's bin/citomni). Not a suite.
 *
 * Usage:
 *   php tests/verify/cli.php <app root> <command> [args...]
 */

if (\PHP_SAPI !== 'cli') {
	throw new \RuntimeException('CLI only.');
}

$appRoot = $argv[1];
\define('CITOMNI_ENVIRONMENT', 'prod');
\define('CITOMNI_APP_PATH', $appRoot);

require \dirname(__DIR__, 2) . '/vendor/autoload.php';

\CitOmni\Cli\Kernel::run($appRoot . '/config', ['bin/citomni', ...\array_slice($argv, 2)]);
