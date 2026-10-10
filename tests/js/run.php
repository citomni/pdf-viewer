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

namespace CitOmni\PdfViewer\Tests\Js;

/*
 * Suite wrapper for the JavaScript unit tests (tests/js/*.test.mjs, node:test).
 *
 * Runs `node --test` on the files and reports node's totals in the format tests/run.php
 * reads. Without Node.js 22+ on PATH (or in NODE_BINARY) the suite is skipped.
 *
 * Usage:
 *   php tests/js/run.php
 *   node --test tests/js/*.test.mjs      (the same tests, directly)
 */

if (\PHP_SAPI !== 'cli') {
	throw new \RuntimeException('CLI only.');
}

$node = (string)(\getenv('NODE_BINARY') ?: 'node');
$files = \glob(__DIR__ . '/*.test.mjs') ?: [];
\sort($files);

$probe = @\proc_open([$node, '--version'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
$version = '';
if (\is_resource($probe)) {
	$version = \trim((string)\stream_get_contents($pipes[1]));
	\fclose($pipes[1]);
	\fclose($pipes[2]);
	\proc_close($probe);
}
if (\preg_match('/^v(\d+)\./', $version, $m) !== 1 || (int)$m[1] < 22) {
	\fwrite(\STDOUT, "SKIP Node.js 22+ not found (set NODE_BINARY)\n");
	\fwrite(\STDOUT, "0 passed, 0 failed, 1 skipped\n");
	exit(0);
}

$proc = \proc_open([$node, '--test', '--test-reporter=tap', ...$files], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
if (!\is_resource($proc)) {
	throw new \RuntimeException('Cannot start node.');
}
\fclose($pipes[0]);
$out = (string)\stream_get_contents($pipes[1]);
$err = (string)\stream_get_contents($pipes[2]);
\fclose($pipes[1]);
\fclose($pipes[2]);
$exit = \proc_close($proc);

foreach (\explode("\n", $out) as $line) {
	if (\preg_match('/^ok \d+ - (.*)$/', $line, $m) === 1) {
		\fwrite(\STDOUT, "PASS {$m[1]}\n");
	} elseif (\preg_match('/^not ok \d+ - (.*)$/', $line, $m) === 1) {
		\fwrite(\STDERR, "FAIL {$m[1]}\n");
	}
}

$passed = \preg_match('/^# pass (\d+)$/m', $out, $p) === 1 ? (int)$p[1] : 0;
$failed = \preg_match('/^# fail (\d+)$/m', $out, $f) === 1 ? (int)$f[1] : 1;
if ($exit !== 0 && $failed === 0) {
	$failed = 1;
	\fwrite(\STDERR, "FAIL node exited with {$exit}\n" . $err);
}
\fwrite(\STDOUT, "{$passed} passed, {$failed} failed\n");
exit($failed === 0 ? 0 : 1);
