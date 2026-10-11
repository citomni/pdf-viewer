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
 * Fixtures for the suites. Not a suite of its own.
 *
 * - check() and same() record and print one result line per case; skip() records a case
 *   that cannot run in this installation.
 * - FixtureServer runs PHP's built-in web server with a suite's router script, for
 *   behavior that only exists in a real request: status line, response headers, bodies.
 * - writeApp() creates a minimal CitOmni application root (config, public, var) that
 *   enables this package as a provider.
 * - requireVendor() points at the package's Composer autoloader; the integration suites
 *   run the real citomni/kernel, citomni/http and citomni/cli from vendor/.
 * - tempDir() and removeTree() manage per-run directories.
 */

namespace CitOmni\PdfViewer\Tests\Support;

/** Package root (the directory holding composer.json). */
const PACKAGE_ROOT = __DIR__ . '/../..';

/** @var array{passed: int, failed: int, skipped: int} */
$GLOBALS['citomniPdfViewerTestTotals'] = ['passed' => 0, 'failed' => 0, 'skipped' => 0];


/**
 * Run one named case and print PASS/FAIL.
 *
 * @param  string    $name
 * @param  callable  $test  Throws on failure.
 * @return void
 */
function check(string $name, callable $test): void {
	try {
		$test();
		$GLOBALS['citomniPdfViewerTestTotals']['passed']++;
		\fwrite(\STDOUT, "PASS {$name}\n");
	} catch (\Throwable $error) {
		$GLOBALS['citomniPdfViewerTestTotals']['failed']++;
		\fwrite(\STDERR, "FAIL {$name} - " . $error->getMessage() . "\n");
	}
}


/**
 * Record a case that cannot run in this installation and print SKIP.
 *
 * @param  string  $name
 * @param  string  $reason
 * @return void
 */
function skip(string $name, string $reason): void {
	$GLOBALS['citomniPdfViewerTestTotals']['skipped']++;
	\fwrite(\STDOUT, "SKIP {$name}: {$reason}\n");
}


/**
 * Strict comparison with a readable failure message.
 *
 * @throws \RuntimeException  When the values differ.
 */
function same(mixed $expected, mixed $actual, string $label = ''): void {
	if ($expected !== $actual) {
		throw new \RuntimeException(($label !== '' ? $label . ': ' : '') . 'Expected ' . \var_export($expected, true) . '; got ' . \var_export($actual, true));
	}
}


/**
 * Print the summary line read by tests/run.php and exit.
 *
 * @return never
 */
function finish(): never {
	$t = $GLOBALS['citomniPdfViewerTestTotals'];
	\fwrite(\STDOUT, "{$t['passed']} passed, {$t['failed']} failed" . ($t['skipped'] > 0 ? ", {$t['skipped']} skipped" : '') . "\n");
	exit($t['failed'] === 0 ? 0 : 1);
}


/**
 * Fail fast on every diagnostic, like the production error handler; @ is honored.
 *
 * @return void
 */
function strictErrors(): void {
	\set_error_handler(static function (int $errno, string $errstr, string $errfile, int $errline): bool {
		if ((\error_reporting() & $errno) === 0) {
			return false;
		}
		throw new \ErrorException($errstr, 0, $errno, $errfile, $errline);
	});
}


/**
 * Path of the package's Composer autoloader; exits with a FAIL line when it is missing.
 *
 * @return string
 */
function requireVendor(): string {
	$autoload = PACKAGE_ROOT . '/vendor/autoload.php';
	if (!\is_file($autoload)) {
		\fwrite(\STDERR, "FAIL vendor/autoload.php is missing - run composer install in the package root\n");
		\fwrite(\STDOUT, "0 passed, 1 failed\n");
		exit(1);
	}
	return $autoload;
}


/**
 * PHP binary arguments with the same php.ini as this process (the loaded file, the
 * default lookup, or none at all), as in tests/run.php.
 *
 * @return list<string>
 */
function phpCommand(): array {
	return match (true) {
		\php_ini_loaded_file() !== false   => [\PHP_BINARY, '-c', \php_ini_loaded_file()],
		\php_ini_scanned_files() !== false => [\PHP_BINARY],
		default                            => [\PHP_BINARY, '-n'],
	};
}


/**
 * Run a PHP script in its own process.
 *
 * @param  list<string>  $args
 * @return array{exit: int, stdout: string, stderr: string}
 */
function runPhp(array $args): array {
	$proc = \proc_open([...phpCommand(), ...$args], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
	if (!\is_resource($proc)) {
		throw new \RuntimeException('Cannot start PHP: ' . \implode(' ', $args));
	}
	\fclose($pipes[0]);
	$stdout = (string)\stream_get_contents($pipes[1]);
	$stderr = (string)\stream_get_contents($pipes[2]);
	\fclose($pipes[1]);
	\fclose($pipes[2]);
	return ['exit' => \proc_close($proc), 'stdout' => $stdout, 'stderr' => $stderr];
}


/**
 * Create a minimal CitOmni application root that enables this package.
 *
 * Behavior:
 * - config/citomni_cfg.php: locale (da, Europe/Copenhagen, UTF-8).
 * - config/citomni_http_cfg.php: logs below the root, plus $httpCfg (deep overrides are
 *   the caller's job: pass the complete subtrees to replace).
 * - config/providers.php: \CitOmni\PdfViewer\Boot\Registry.
 * - public/ and var/{logs,cache,flags,state} exist.
 *
 * @param  string                $root       Empty directory.
 * @param  array<string, mixed>  $httpCfg    Top-level keys for citomni_http_cfg.php.
 * @param  array<string, mixed>  $commonCfg  Top-level keys for citomni_cfg.php (replace the defaults).
 * @return void
 */
function writeApp(string $root, array $httpCfg = [], array $commonCfg = []): void {
	foreach (['config', 'public', 'var/logs', 'var/cache', 'var/flags', 'var/state/php_sessions'] as $dir) {
		if (!\is_dir($root . '/' . $dir)) {
			\mkdir($root . '/' . $dir, 0700, true);
		}
	}
	$common = $commonCfg + [
		'identity' => ['app_name' => 'citomni/pdf-viewer tests'],
		'locale'   => ['language' => 'da', 'icu_locale' => 'da_DK', 'timezone' => 'Europe/Copenhagen', 'charset' => 'UTF-8'],
	];
	$http = $httpCfg + [
		'error_handler' => ['log' => ['path' => $root . '/var/logs']],
	];
	\file_put_contents($root . '/config/citomni_cfg.php', "<?php\nreturn " . \var_export($common, true) . ";\n");
	\file_put_contents($root . '/config/citomni_http_cfg.php', "<?php\nreturn " . \var_export($http, true) . ";\n");
	\file_put_contents($root . '/config/citomni_cli_cfg.php', "<?php\nreturn ['error_handler' => ['log' => ['path' => " . \var_export($root . '/var/logs', true) . "]]];\n");
	\file_put_contents($root . '/config/providers.php', "<?php\nreturn [\\CitOmni\\PdfViewer\\Boot\\Registry::class];\n");
	\file_put_contents($root . '/public/index.php', "<?php\n// Not used: the suites boot the kernel from their own router script.\n");
}


/**
 * PHP's built-in web server on a free local port, serving one router script.
 *
 * Behavior:
 * - Starts `php -S 127.0.0.1:<port> -t <docroot> <router>` with the same PHP binary and
 *   php.ini as the calling suite. The environment is inherited.
 * - Waits up to 5 seconds until the port accepts connections.
 * - Server output goes to <docroot>/../server.out and server.err.
 */
final class FixtureServer {
	public readonly string $baseUrl;

	/** @var resource|null */
	private mixed $process = null;

	public function __construct(string $docroot, string $router) {
		$socket = \stream_socket_server('tcp://127.0.0.1:0');
		$address = \stream_socket_get_name($socket, false);
		\fclose($socket);

		$logDir = \dirname($docroot);
		$process = \proc_open([...phpCommand(), '-S', $address, '-t', $docroot, $router], [
			0 => ['pipe', 'r'],
			1 => ['file', $logDir . '/server.out', 'w'],
			2 => ['file', $logDir . '/server.err', 'w'],
		], $pipes);
		if (!\is_resource($process)) {
			throw new \RuntimeException('Cannot start the fixture server.');
		}
		\fclose($pipes[0]);
		$this->process = $process;

		$deadline = \microtime(true) + 5;
		while (($probe = @\stream_socket_client('tcp://' . $address, $errno, $errstr, 0.1)) === false) {
			if (\microtime(true) >= $deadline) {
				$this->stop();
				throw new \RuntimeException("Fixture server did not start on {$address}: {$errstr}");
			}
			\usleep(10_000);
		}
		\fclose($probe);
		$this->baseUrl = 'http://' . $address;
	}

	/**
	 * Send one request and return the response without following redirects.
	 *
	 * @param  string                $method   HTTP method.
	 * @param  string                $target   Path and query.
	 * @param  array<string, string> $headers  Request headers by name.
	 * @return array{status: int, headers: list<string>, body: string}
	 */
	public function request(string $method, string $target, array $headers = []): array {
		$lines = '';
		foreach ($headers as $name => $value) {
			$lines .= $name . ': ' . $value . "\r\n";
		}
		$context = \stream_context_create(['http' => [
			'method'          => $method,
			'header'          => $lines,
			'ignore_errors'   => true,
			'follow_location' => 0,
			'timeout'         => 10,
		]]);
		$body = \file_get_contents($this->baseUrl . $target, false, $context);
		$responseHeaders = \http_get_last_response_headers() ?? [];
		if ($body === false || $responseHeaders === []) {
			throw new \RuntimeException("No response for {$method} {$target}");
		}
		$statusLine = \array_shift($responseHeaders);
		if (\preg_match('#^HTTP/\S+ (\d{3})#', $statusLine, $m) !== 1) {
			throw new \RuntimeException('Malformed status line: ' . $statusLine);
		}
		return ['status' => (int)$m[1], 'headers' => $responseHeaders, 'body' => $body];
	}

	public function stop(): void {
		if (\is_resource($this->process)) {
			\proc_terminate($this->process);
			\proc_close($this->process);
		}
		$this->process = null;
	}
}


/**
 * Values of one response header, matched case-insensitively.
 *
 * @param  list<string> $headers  Header lines as returned by FixtureServer::request().
 * @return list<string>
 */
function headerValues(array $headers, string $name): array {
	$values = [];
	$prefix = \strtolower($name) . ':';
	foreach ($headers as $line) {
		if (\str_starts_with(\strtolower($line), $prefix)) {
			$values[] = \trim(\substr($line, \strlen($prefix)));
		}
	}
	return $values;
}


/** Create an empty, uniquely named directory under the system temp directory. */
function tempDir(string $suite): string {
	$dir = \sys_get_temp_dir() . '/citomni_pdf_viewer_' . $suite . '_test_' . \bin2hex(\random_bytes(6));
	\mkdir($dir, 0700, true);
	return $dir;
}


/** Remove a directory created by tempDir(), including everything below it. */
function removeTree(string $dir): void {
	if (!\is_dir($dir)) {
		return;
	}
	foreach (\scandir($dir) as $entry) {
		if ($entry === '.' || $entry === '..') {
			continue;
		}
		$path = $dir . '/' . $entry;
		if (\is_dir($path) && !\is_link($path)) {
			removeTree($path);
		} else {
			\unlink($path);
		}
	}
	\rmdir($dir);
}
