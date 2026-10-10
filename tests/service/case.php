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

/*
 * One case of tests/service/run.php in its own process (constants can be defined once).
 * Not a suite of its own.
 *
 * Usage:
 *   php tests/service/case.php <app root> <public root URL>
 *
 * Prints JSON: {"ok": true, ...service output} or {"ok": false, "error": class, "message": ...}.
 */

if (\PHP_SAPI !== 'cli') {
	throw new \RuntimeException('CLI only.');
}

[, $appRoot, $rootUrl] = $argv;

\define('CITOMNI_ENVIRONMENT', 'prod');
\define('CITOMNI_APP_PATH', $appRoot);
\define('CITOMNI_PUBLIC_ROOT_URL', $rootUrl);

require \dirname(__DIR__, 2) . '/vendor/autoload.php';

try {
	$app = new \CitOmni\Kernel\App($appRoot . '/config', \CitOmni\Kernel\Mode::HTTP);
	$viewer = $app->pdfViewer;
	$out = [
		'ok'                => true,
		'bundleKey'         => $viewer->bundleKey(),
		'appOrigin'         => $viewer->appOrigin(),
		'frameUrl'          => $viewer->frameUrl(),
		'assetBaseUrl'      => $viewer->assetBaseUrl(),
		'hostModuleUrl'     => $viewer->hostModuleUrl(),
		'hostStylesheetUrl' => $viewer->hostStylesheetUrl(),
		'language'          => $viewer->language(),
		'hostConfig'        => $viewer->hostConfig(),
		'readerConfig'      => $viewer->readerConfig(),
		'cspSources'        => $viewer->cspSources(),
	];
} catch (\RuntimeException $e) {
	$out = ['ok' => false, 'error' => $e::class, 'message' => $e->getMessage()];
}

echo \json_encode($out, \JSON_UNESCAPED_SLASHES | \JSON_THROW_ON_ERROR);
