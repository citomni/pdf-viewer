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

namespace CitOmni\PdfViewer\Service;

use CitOmni\Kernel\Cfg;
use CitOmni\Kernel\Service\BaseService;
use CitOmni\PdfViewer\Constant\Bundle;
use CitOmni\PdfViewer\Constant\Route;

/**
 * PdfViewer: URLs, configuration and CSP sources for embedding the sandboxed reader.
 *
 * Responsibilities:
 * - Resolve the viewer URLs of the current bundle from CITOMNI_PUBLIC_ROOT_URL.
 *   1) Frame:  {root}/_pdf-viewer/frame/{key}
 *   2) Assets: {root}/_pdf-viewer/assets/{key}/
 *   3) Host module and stylesheet below the asset base.
 * - Derive the app origin used as postMessage target and in the frame CSP. It comes from
 *   CITOMNI_PUBLIC_ROOT_URL (http.base_url outside dev), never from the Host header.
 * - Turn cfg.pdf_viewer into the host configuration (JSON for PdfViewerHost) and the reader
 *   configuration (JSON in the frame document).
 * - List the CSP sources a host page needs.
 *
 * Collaborators:
 * - cfg.pdf_viewer (read): language, limits, usable_text, host, ocr, preload, engines,
 *   diagnostics.
 * - cfg.locale.language (read, optional): UI language when pdf_viewer.language is null.
 * - CITOMNI_PUBLIC_ROOT_URL: defined by the HTTP kernel.
 *
 * Configuration keys:
 * - See the CFG_HTTP baseline in \CitOmni\PdfViewer\Boot\Registry.
 *
 * Error handling:
 * - Objectively invalid configuration fails fast with \RuntimeException when the service
 *   is constructed: a relative or malformed public root URL, an unknown language, OCR
 *   languages without data in the bundle, an unknown preload mode, an unknown engine or a
 *   non-boolean engine flag, or a limit <= 0.
 *
 * Typical usage:
 *   // Host page controller (HTTP)
 *   $viewer = $this->app->pdfViewer;
 *   $data = [
 *       'pdfViewerModule' => $viewer->hostModuleUrl(),
 *       'pdfViewerConfig' => \json_encode($viewer->hostConfig(), \JSON_UNESCAPED_SLASHES | \JSON_THROW_ON_ERROR),
 *   ];
 *
 * Notes:
 * - HTTP mode only (CITOMNI_PUBLIC_ROOT_URL).
 * - All values are computed once in init(); the getters are plain reads.
 */
final class PdfViewer extends BaseService {

	/** UI languages of the reader frame (reader/i18n.mjs). */
	private const array LANGUAGES = ['en', 'da'];

	/** Host preload modes (cache mitigation). */
	private const array PRELOAD_MODES = ['auto', 'always', 'never'];

	/** Browser engines known to the host's engine policy (assets/host/pdf-viewer.mjs). */
	private const array ENGINES = ['chromium', 'webkit', 'gecko'];

	/** Iframe title per UI language (accessibility). */
	private const array FRAME_TITLES = ['en' => 'Document', 'da' => 'Dokument'];

	/** Host configuration format understood by assets/host/pdf-viewer.mjs. */
	private const int HOST_CONFIG_VERSION = 1;

	private string $rootUrl;
	private string $appOrigin;
	private string $language;

	/** @var array<string, mixed> */
	private array $hostConfig;

	/** @var array<string, mixed> */
	private array $readerConfig;


	/**
	 * Resolve URLs and validate cfg.pdf_viewer once per request.
	 *
	 * @return void
	 * @throws \RuntimeException  On objectively invalid configuration (see class doc).
	 */
	protected function init(): void {

		// -- 1. Public root URL and app origin ----------------------------------------
		$root = \rtrim((string)\CITOMNI_PUBLIC_ROOT_URL, '/');
		$parts = \parse_url($root);
		$scheme = \strtolower((string)($parts['scheme'] ?? ''));
		if (
			($scheme !== 'https' && $scheme !== 'http')
			|| !isset($parts['host'])
			|| isset($parts['query']) || isset($parts['fragment']) || isset($parts['user'])
			|| \preg_match('#[\s;,\'"\\\\]#', $root) === 1
		) {
			throw new \RuntimeException('PdfViewer: CITOMNI_PUBLIC_ROOT_URL must be an absolute http(s) URL without query, fragment or credentials: ' . $root);
		}
		$port = isset($parts['port']) ? (int)$parts['port'] : null;
		$defaultPort = $scheme === 'https' ? 443 : 80;
		$this->rootUrl = $root;
		$this->appOrigin = $scheme . '://' . \strtolower((string)$parts['host']) . ($port !== null && $port !== $defaultPort ? ':' . $port : '');

		// -- 2. Configuration -----------------------------------------------------------
		$cfg = $this->app->cfg->pdf_viewer;

		$language = $cfg->language;
		if ($language === null) {
			$appLanguage = (string)($this->app->cfg->locale->language ?? '');
			$language = \in_array($appLanguage, self::LANGUAGES, true) ? $appLanguage : 'en';
		} elseif (!\in_array($language, self::LANGUAGES, true)) {
			throw new \RuntimeException('PdfViewer: pdf_viewer.language must be null or one of: ' . \implode(', ', self::LANGUAGES));
		}
		$this->language = $language;

		$ocrLanguages = self::listValue($cfg->ocr->languages);
		if ($ocrLanguages === [] || \array_diff($ocrLanguages, Bundle::OCR_LANGUAGES) !== []) {
			throw new \RuntimeException('PdfViewer: pdf_viewer.ocr.languages must be a non-empty subset of the bundled languages: ' . \implode(', ', Bundle::OCR_LANGUAGES));
		}

		$preload = (string)$cfg->preload;
		if (!\in_array($preload, self::PRELOAD_MODES, true)) {
			throw new \RuntimeException('PdfViewer: pdf_viewer.preload must be one of: ' . \implode(', ', self::PRELOAD_MODES));
		}

		$engineCfg = $cfg->engines;
		$engineError = 'PdfViewer: pdf_viewer.engines must map ' . \implode(', ', self::ENGINES) . ' to true or false.';
		if (!$engineCfg instanceof Cfg) {
			throw new \RuntimeException($engineError);
		}
		$engineCfg = $engineCfg->toArray();
		foreach ($engineCfg as $engine => $enabled) {
			if (!\in_array($engine, self::ENGINES, true) || !\is_bool($enabled)) {
				throw new \RuntimeException($engineError);
			}
		}
		$engines = [];
		foreach (self::ENGINES as $engine) {
			$engines[$engine] = $engineCfg[$engine] ?? false;
		}

		$l = $cfg->limits;
		$limits = [
			'maxFileBytes'           => self::positiveInt($l->max_file_bytes, 'limits.max_file_bytes'),
			'maxPages'               => self::positiveInt($l->max_pages, 'limits.max_pages'),
			'maxImagePixels'         => self::positiveInt($l->max_image_pixels, 'limits.max_image_pixels'),
			'maxPdfImagePixels'      => self::positiveInt($l->max_pdf_image_pixels, 'limits.max_pdf_image_pixels'),
			'maxDisplayCanvasPixels' => self::positiveInt($l->max_display_canvas_pixels, 'limits.max_display_canvas_pixels'),
			'maxOcrPixels'           => self::positiveInt($l->max_ocr_pixels, 'limits.max_ocr_pixels'),
			'ocrDpi'                 => self::positiveInt($l->ocr_dpi, 'limits.ocr_dpi'),
			'ocrTimeoutMs'           => self::positiveInt($l->ocr_timeout_ms, 'limits.ocr_timeout_ms'),
			'handshakeTimeoutMs'     => self::positiveInt($l->handshake_timeout_ms, 'limits.handshake_timeout_ms'),
			'workerStartTimeoutMs'   => self::positiveInt($l->worker_start_timeout_ms, 'limits.worker_start_timeout_ms'),
			'maxTextItemsPerPage'    => self::positiveInt($l->max_text_items_per_page, 'limits.max_text_items_per_page'),
			'maxItemTextLength'      => self::positiveInt($l->max_item_text_length, 'limits.max_item_text_length'),
		];
		$u = $cfg->usable_text;
		$limits['usableText'] = [
			'minAlnum'      => self::positiveInt($u->min_alnum, 'usable_text.min_alnum'),
			'minAlnumRatio' => (float)$u->min_alnum_ratio,
			'maxJunkRatio'  => (float)$u->max_junk_ratio,
		];

		$h = $cfg->host;
		$timeouts = [
			'readyMs'          => self::positiveInt($h->ready_timeout_ms, 'host.ready_timeout_ms'),
			'startAfterLoadMs' => self::positiveInt($h->start_after_load_timeout_ms, 'host.start_after_load_timeout_ms'),
			'inactivityMs'     => self::positiveInt($h->inactivity_timeout_ms, 'host.inactivity_timeout_ms'),
			'openMs'           => self::positiveInt($h->open_timeout_ms, 'host.open_timeout_ms'),
			'ocrPageMs'        => self::positiveInt($h->ocr_page_timeout_ms, 'host.ocr_page_timeout_ms'),
		];

		// -- 3. Derived configurations --------------------------------------------------
		$assetBase = $this->assetBaseUrl();

		$this->readerConfig = [
			'appOrigin'    => $this->appOrigin,
			'assetBase'    => $assetBase,
			'bundle'       => Bundle::KEY,
			'language'     => $this->language,
			'ocrLanguages' => $ocrLanguages,
			'diagnostics'  => (bool)$cfg->diagnostics,
			'limits'       => $limits,
		];

		$this->hostConfig = [
			'version'      => self::HOST_CONFIG_VERSION,
			'bundle'       => Bundle::KEY,
			'appOrigin'    => $this->appOrigin,
			'frameUrl'     => $this->frameUrl(),
			'assetBase'    => $assetBase,
			'frameTitle'   => self::FRAME_TITLES[$this->language],
			'limits'       => [
				'maxPages'            => $limits['maxPages'],
				'maxTextItemsPerPage' => $limits['maxTextItemsPerPage'],
				'maxItemTextLength'   => $limits['maxItemTextLength'],
				'maxFileBytes'        => $limits['maxFileBytes'],
			],
			'timeouts'     => $timeouts,
			'ocrLanguages' => $ocrLanguages,
			'preload'      => $preload,
			'engines'      => $engines,
		];
	}


	// ----------------------------------------------------------------
	// URLs
	// ----------------------------------------------------------------

	/**
	 * Key of the installed reader bundle (part of every frame and asset URL).
	 *
	 * @return string  12 lowercase hex characters.
	 */
	public function bundleKey(): string {
		return Bundle::KEY;
	}


	/**
	 * Origin of the app as the browser sees it, e.g. "https://example.com".
	 *
	 * @return string
	 */
	public function appOrigin(): string {
		return $this->appOrigin;
	}


	/**
	 * Absolute URL of the reader frame document (without the handshake fragment).
	 *
	 * @return string
	 */
	public function frameUrl(): string {
		return $this->rootUrl . Route::FRAME . '/' . Bundle::KEY;
	}


	/**
	 * Absolute asset base URL of the bundle; ends with "/".
	 *
	 * @return string
	 */
	public function assetBaseUrl(): string {
		return $this->rootUrl . Route::ASSETS . '/' . Bundle::KEY . '/';
	}


	/**
	 * Absolute URL of the host module (exports PdfViewerHost).
	 *
	 * @return string
	 */
	public function hostModuleUrl(): string {
		return $this->assetBaseUrl() . 'host/pdf-viewer.mjs';
	}


	/**
	 * Absolute URL of the optional host stylesheet (sizes the frame to its container).
	 *
	 * @return string
	 */
	public function hostStylesheetUrl(): string {
		return $this->assetBaseUrl() . 'host/pdf-viewer.css';
	}


	// ----------------------------------------------------------------
	// Configurations
	// ----------------------------------------------------------------

	/**
	 * UI language of the reader frame ('en' or 'da').
	 *
	 * @return string
	 */
	public function language(): string {
		return $this->language;
	}


	/**
	 * Configuration for PdfViewerHost (pass it to the page as JSON).
	 *
	 * Notes:
	 * - Contains no secrets: URLs, limits, timeouts and policies only.
	 *
	 * @return array<string, mixed>
	 */
	public function hostConfig(): array {
		return $this->hostConfig;
	}


	/**
	 * Configuration of the reader frame (JSON in the frame document's meta element).
	 *
	 * @return array<string, mixed>
	 */
	public function readerConfig(): array {
		return $this->readerConfig;
	}


	/**
	 * CSP sources a host page needs, by directive.
	 *
	 * Behavior:
	 * - script-src:  the asset base (host module and its imports).
	 * - style-src:   the asset base (optional host stylesheet).
	 * - connect-src: the asset base (preload fetches in Chromium).
	 * - frame-src:   the frame path only. A narrow frame-src also stops the frame from
	 *                navigating itself to other paths of the app.
	 *
	 * Notes:
	 * - The page fetches the documents from its own routes; add those to connect-src
	 *   ('self' covers them).
	 *
	 * @return array<string, list<string>>
	 */
	public function cspSources(): array {
		$assets = $this->assetBaseUrl();
		return [
			'script-src'  => [$assets],
			'style-src'   => [$assets],
			'connect-src' => [$assets],
			'frame-src'   => [$this->rootUrl . Route::FRAME . '/'],
		];
	}


	// ----------------------------------------------------------------
	// Helpers
	// ----------------------------------------------------------------

	/**
	 * A cfg value that should be a list (an empty array arrives as a Cfg node).
	 *
	 * @param  mixed  $value
	 * @return list<mixed>
	 */
	private static function listValue(mixed $value): array {
		if ($value instanceof Cfg) {
			$value = $value->toArray();
		}
		return \is_array($value) ? \array_values($value) : [];
	}


	/**
	 * A positive integer cfg value.
	 *
	 * @param  mixed   $value
	 * @param  string  $key    Key below pdf_viewer (for the error message).
	 * @return int
	 * @throws \RuntimeException  When the value is not a positive integer.
	 */
	private static function positiveInt(mixed $value, string $key): int {
		if (!\is_int($value) || $value <= 0) {
			throw new \RuntimeException("PdfViewer: pdf_viewer.{$key} must be a positive integer.");
		}
		return $value;
	}
}
