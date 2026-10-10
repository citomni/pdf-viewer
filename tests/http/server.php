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

/*
 * Built-in web server router for tests/http/run.php. Not a suite of its own.
 *
 * Every request runs the real CitOmni HTTP kernel (vendor/) for the application root
 * above the document root, with this package enabled as a provider (see writeApp()).
 *
 * Request headers (test settings):
 * - X-Test-Base: <path>   Mount path of the app, e.g. "/sub". CITOMNI_PUBLIC_ROOT_URL is
 *                         http://<Host><path>; SCRIPT_NAME is <path>/index.php.
 */

if (\PHP_SAPI !== 'cli-server') {
	throw new \RuntimeException('Built-in web server router only.');
}

$publicDir = (string)$_SERVER['DOCUMENT_ROOT'];
$base = (string)($_SERVER['HTTP_X_TEST_BASE'] ?? '');

\define('CITOMNI_START_NS', \hrtime(true));
\define('CITOMNI_ENVIRONMENT', 'prod');
\define('CITOMNI_PUBLIC_PATH', $publicDir);
\define('CITOMNI_APP_PATH', \dirname($publicDir));
\define('CITOMNI_PUBLIC_ROOT_URL', 'http://' . $_SERVER['HTTP_HOST'] . $base);
$_SERVER['SCRIPT_NAME'] = $base . '/index.php';

require \dirname(__DIR__, 2) . '/vendor/autoload.php';

\CitOmni\Http\Kernel::run($publicDir);
