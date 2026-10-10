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
 * Host side - mitigation for the missing cache reuse between reader frames.
 *
 * Measured in Chromium: resources requested by a sandboxed (opaque origin) frame and its
 * workers are never served from or stored in the HTTP cache, so every new frame downloads
 * PDF.js' worker and Tesseract (core + language data) again: about 7 MB for a document
 * that needs OCR. WebKit reuses its cache between frames, so the mitigation gains nothing
 * there (measured on iOS Safari 26.6.1).
 *
 * The host fetches the heavy, fixed asset files with its own normal HTTP cache (the asset
 * route sends "public, max-age=31536000, immutable") and pushes the bytes to the new frame
 * in one 'assets' message before 'open'. Rules:
 * - The host chooses the files from a fixed list of asset-manifest paths. The frame cannot
 *   ask for anything; it accepts only paths on its own allowlist, once, before open.
 * - Nothing is kept in host memory between frames: each frame gets a fresh read from the
 *   browser's HTTP cache, transferred (not copied) to the frame.
 * - The frame's CSP is unchanged: the bytes are only used inside workers.
 */

const PDF_FILES = Object.freeze([
	'vendor/pdfjs/build/pdf.worker.min.mjs',
	'vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
	'vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
	'vendor/pdfjs/wasm/jbig2.wasm',
]);

// Same feature tests as wasm-feature-detect (used by Tesseract.js to pick a core).
const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const RELAXED_SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11]);

/** Path of the LSTM core variant Tesseract.js would choose in this browser. */
export function coreVariantPath() {
	let name = 'tesseract-core-lstm.wasm.js';
	try {
		if (WebAssembly.validate(RELAXED_SIMD)) {
			name = 'tesseract-core-relaxedsimd-lstm.wasm.js';
		} else if (WebAssembly.validate(SIMD)) {
			name = 'tesseract-core-simd-lstm.wasm.js';
		}
	} catch {
		// No WebAssembly: Tesseract.js will fail on its own; send nothing special.
	}
	return 'vendor/tesseract-core/' + name;
}

/**
 * Asset paths to push for one frame: the PDF set for PDFs, the OCR set when OCR can start
 * automatically (images always need OCR to give text).
 *
 * @param {{mime: string, autoOcr: boolean, ocrLanguages: string[]}} doc
 * @returns {string[]}
 */
export function preloadPaths({ mime, autoOcr, ocrLanguages }) {
	const paths = [];
	if (mime === 'application/pdf') {
		paths.push(...PDF_FILES);
	}
	if (autoOcr) {
		paths.push('vendor/tesseract/worker.min.js', coreVariantPath());
		for (const lang of ocrLanguages) {
			paths.push('vendor/tessdata/' + lang + '.traineddata.gz');
		}
	}
	return paths;
}

export class AssetPreloader {
	#assetBase;
	#ocrLanguages;
	stats = { frames: 0, files: 0, bytes: 0, ms: 0 };

	/**
	 * @param {string} assetBase  Bundle asset base URL (ends with "/").
	 * @param {string[]} ocrLanguages  OCR languages of the reader configuration.
	 */
	constructor(assetBase, ocrLanguages) {
		this.#assetBase = assetBase;
		this.#ocrLanguages = ocrLanguages;
	}

	/**
	 * Read the files for one frame from the host's HTTP cache (or the network).
	 *
	 * @param {{mime: string, autoOcr: boolean}} doc
	 * @returns {Promise<{files: Object<string, ArrayBuffer>, transfer: ArrayBuffer[]}>}
	 */
	async filesFor({ mime, autoOcr }) {
		const t0 = performance.now();
		const paths = preloadPaths({ mime, autoOcr, ocrLanguages: this.#ocrLanguages });
		const entries = await Promise.all(paths.map(async (p) => {
			const r = await fetch(this.#assetBase + p, { credentials: 'omit' });
			if (!r.ok) {
				throw new Error('preload ' + p + ': HTTP ' + r.status);
			}
			return [p, await r.arrayBuffer()];
		}));
		const files = Object.fromEntries(entries);
		const transfer = Object.values(files);
		this.stats.frames++;
		this.stats.files += transfer.length;
		this.stats.bytes += transfer.reduce((n, b) => n + b.byteLength, 0);
		this.stats.ms += Math.round(performance.now() - t0);
		return { files, transfer };
	}
}
