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
 * Reader frame - OCR with Tesseract.js 7 (one worker per frame, one page at a time).
 *
 * Configuration:
 * - The worker is a classic blob worker built by the reader: worker prologue + the LSTM core
 *   + vendor/tesseract/worker.min.js. Core and worker script are fetched with CORS and no
 *   credentials (or taken from the bytes the host pushed), never loaded with importScripts():
 *   importScripts() is a no-cors request, which carries the app's cookies in WebKit and is
 *   blocked by "Cross-Origin-Resource-Policy: same-origin". With the core inlined, the global
 *   TesseractCore exists and Tesseract.js skips its own importScripts() of the core.
 * - The core variant is picked with the same WebAssembly feature tests Tesseract.js uses:
 *   relaxed SIMD, SIMD or plain (all LSTM-only).
 * - langPath: vendor/tessdata on the asset route; languages from the configuration;
 *   gzip: true; cacheMethod: 'none' (the default stores language data in IndexedDB, which
 *   does not exist in an opaque origin). The worker fetches the language data itself (CORS).
 * - OEM 1 (LSTM_ONLY). Output: text + blocks (words with bbox and confidence).
 * - Input: a grayscale PGM built from the canvas (avoids PNG encoding; Leptonica reads PNM).
 * - Engine start is bounded: Tesseract.createWorker() never settles when the core's
 *   WebAssembly cannot be compiled (e.g. 'wasm-unsafe-eval' missing: the core only logs
 *   "Aborted(...)"). The start fails with 'unsupported' on that message, or with 'timeout'
 *   after startTimeoutMs; a failed start is not retried.
 */

import { workerPrologue, diag } from './diag.mjs';
import { normaliseBox } from './textrule.mjs';

// Same feature tests as wasm-feature-detect (used by Tesseract.js to pick a core).
const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const RELAXED_SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11]);

/** Asset path of the LSTM core variant Tesseract.js would pick in this browser. */
export function coreVariantPath() {
	let name = 'tesseract-core-lstm.wasm.js';
	if (WebAssembly.validate(RELAXED_SIMD)) {
		name = 'tesseract-core-relaxedsimd-lstm.wasm.js';
	} else if (WebAssembly.validate(SIMD)) {
		name = 'tesseract-core-simd-lstm.wasm.js';
	}
	return 'vendor/tesseract-core/' + name;
}

export class Ocr {
	#assetBase;
	#languages;
	#onProgress;
	#worker = null;
	#workerPromise = null;
	#blobUrl = null;
	#busy = Promise.resolve();
	#terminated = false;
	#takePreload;
	#startTimeoutMs;
	#verbose;
	#onEngineAbort = null;
	timings = {};

	/**
	 * @param {{assetBase: string, languages: string[], onProgress: (p: object) => void,
	 *   takePreload?: (path: string) => ArrayBuffer|null, startTimeoutMs?: number,
	 *   verbose?: boolean}} opts
	 */
	constructor({ assetBase, languages, onProgress, takePreload = () => null, startTimeoutMs = 20000, verbose = false }) {
		this.#assetBase = assetBase;
		this.#languages = languages;
		this.#onProgress = onProgress;
		this.#takePreload = takePreload;
		this.#startTimeoutMs = startTimeoutMs;
		this.#verbose = verbose;
	}

	/** Create the Tesseract worker once (lazy). A failed start is not retried. */
	async ensure() {
		if (this.#terminated) {
			throw new Error('ocr terminated');
		}
		if (!this.#workerPromise) {
			this.#workerPromise = this.#create();
		}
		return this.#workerPromise;
	}

	/**
	 * Console output of any worker in the frame (from diag). An emscripten abort in this
	 * engine's worker while it starts means the engine cannot run here.
	 */
	noteWorkerConsole(level, message, url) {
		if (this.#onEngineAbort && url === this.#blobUrl && level === 'error' && /^Aborted\(/.test(String(message))) {
			this.#onEngineAbort(String(message).slice(0, 300));
		}
	}

	async #create() {
		if (typeof WebAssembly !== 'object') {
			throw Object.assign(new Error('WebAssembly is not available'), { code: 'unsupported' });
		}
		const t0 = performance.now();
		const mod = await import(this.#assetBase + 'vendor/tesseract/tesseract.esm.min.js');
		const Tesseract = mod.default;
		this.timings.moduleMs = Math.round(performance.now() - t0);
		const workerPath = await this.#ownWorkerBlob();
		this.timings.workerCodeMs = Math.round(performance.now() - t0) - this.timings.moduleMs;
		const t1 = performance.now();
		let startTimer = null;
		const startFailed = new Promise((_, reject) => {
			startTimer = setTimeout(() => reject(Object.assign(new Error('ocr engine did not start within ' + this.#startTimeoutMs + ' ms'), { code: 'timeout' })), this.#startTimeoutMs);
			this.#onEngineAbort = (message) => reject(Object.assign(new Error('ocr engine aborted: ' + message), { code: 'unsupported' }));
		});
		const creating = Tesseract.createWorker(this.#languages, Tesseract.OEM.LSTM_ONLY, {
			workerPath,
			workerBlobURL: false,
			corePath: this.#assetBase + 'vendor/tesseract-core/',
			langPath: this.#assetBase + 'vendor/tessdata',
			cacheMethod: 'none',
			gzip: true,
			logger: (m) => {
				if (m && typeof m.status === 'string') {
					this.#onProgress({ ocrStatus: m.status.slice(0, 60), ocrProgress: Number.isFinite(m.progress) ? Math.round(m.progress * 100) / 100 : null });
				}
			},
			errorHandler: () => {},
		});
		let worker;
		try {
			worker = await Promise.race([creating, startFailed]);
		} catch (err) {
			// Do not leave a half-started engine behind.
			creating.then((w) => w.terminate(), () => {});
			for (const w of diag.workers) {
				if (w.diagUrl === this.#blobUrl) {
					w.terminate();
				}
			}
			throw err;
		} finally {
			clearTimeout(startTimer);
			this.#onEngineAbort = null;
		}
		this.timings.initMs = Math.round(performance.now() - t1);
		if (this.#terminated) {
			await worker.terminate();
			throw new Error('ocr terminated');
		}
		this.#worker = worker;
		return worker;
	}

	/**
	 * Build the worker blob and register the language data pushed by the host.
	 *
	 * Blob: prologue + core + worker script. Both scripts come from the bytes the host
	 * pushed or are fetched from the asset route (CORS, no credentials).
	 *
	 * @returns {Promise<string>} The blob URL.
	 */
	async #ownWorkerBlob() {
		const corePath = coreVariantPath();
		const [workerSource, coreSource] = await Promise.all([
			this.#scriptSource('vendor/tesseract/worker.min.js'),
			this.#scriptSource(corePath),
		]);
		this.#blobUrl = URL.createObjectURL(new Blob([workerPrologue(this.#verbose), '\n', coreSource.text, '\n', workerSource.text], { type: 'text/javascript' }));
		const files = {};
		const transfer = [];
		for (const lang of this.#languages) {
			const path = 'vendor/tessdata/' + lang + '.traineddata.gz';
			const b = this.#takePreload(path);
			if (b) {
				files[this.#assetBase + path] = b;
				transfer.push(b);
			}
		}
		if (transfer.length) {
			diag.workerPreload.set(this.#blobUrl, { files, transfer });
		}
		// Numbers only: timings are sent to the host, which accepts numeric values only.
		this.timings.preloadedWorker = workerSource.preloaded ? 1 : 0;
		this.timings.preloadedCore = coreSource.preloaded ? 1 : 0;
		this.timings.preloadedLangs = transfer.length;
		return this.#blobUrl;
	}

	/**
	 * Text of a script asset: the bytes pushed by the host, else a CORS fetch.
	 *
	 * @param {string} path  Asset path.
	 * @returns {Promise<{text: string, preloaded: boolean}>}
	 */
	async #scriptSource(path) {
		const pre = this.#takePreload(path);
		if (pre) {
			return { text: new TextDecoder().decode(pre), preloaded: true };
		}
		const resp = await fetch(this.#assetBase + path, { mode: 'cors', credentials: 'omit' });
		if (!resp.ok) {
			throw Object.assign(new Error(path + ': HTTP ' + resp.status), { code: 'unsupported' });
		}
		return { text: await resp.text(), preloaded: false };
	}

	/**
	 * Recognise a canvas (already oriented as displayed) and return word items.
	 *
	 * @param {HTMLCanvasElement} canvas
	 * @param {number} page  1-based page number.
	 * @param {number} timeoutMs
	 * @returns {Promise<{items: object[], meanConfidence: number|null, ms: number, psm: string}>}
	 */
	recognize(canvas, page, timeoutMs) {
		const run = async () => {
			const worker = await this.ensure();
			const input = canvasToPgm(canvas);
			const t0 = performance.now();
			let timer = null;
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => reject(Object.assign(new Error('ocr timeout'), { code: 'timeout' })), timeoutMs);
			});
			try {
				const res = await Promise.race([worker.recognize(input, {}, { text: true, blocks: true }), timeout]);
				const ms = Math.round(performance.now() - t0);
				return { items: wordsFromBlocks(res.data.blocks, canvas.width, canvas.height, page), meanConfidence: res.data.confidence ?? null, ms, psm: String(res.data.psm || '') };
			} finally {
				clearTimeout(timer);
			}
		};
		// One page at a time.
		const p = this.#busy.then(run, run);
		this.#busy = p.catch(() => {});
		return p;
	}

	/** Stop OCR immediately (terminates the worker). */
	async terminate() {
		this.#terminated = true;
		const w = this.#worker;
		this.#worker = null;
		if (w) {
			try {
				await w.terminate();
			} catch {
				// Already gone.
			}
		}
		if (this.#blobUrl) {
			URL.revokeObjectURL(this.#blobUrl);
			this.#blobUrl = null;
		}
	}
}

/**
 * Convert a canvas to a binary grayscale PGM (P5) image.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Uint8Array}
 */
export function canvasToPgm(canvas) {
	const { width, height } = canvas;
	const rgba = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
	const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
	const out = new Uint8Array(header.length + width * height);
	out.set(header, 0);
	let o = header.length;
	for (let i = 0; i < rgba.length; i += 4) {
		const a = rgba[i + 3];
		// Composite on white, then ITU-R BT.601 luma.
		const r = (rgba[i] * a + 255 * (255 - a)) / 255;
		const g = (rgba[i + 1] * a + 255 * (255 - a)) / 255;
		const b = (rgba[i + 2] * a + 255 * (255 - a)) / 255;
		out[o++] = (r * 299 + g * 587 + b * 114) / 1000;
	}
	return out;
}

/** Flatten Tesseract blocks to word items in the common text format. */
function wordsFromBlocks(blocks, width, height, page) {
	const items = [];
	for (const block of blocks || []) {
		for (const para of block.paragraphs || []) {
			for (const line of para.lines || []) {
				for (const word of line.words || []) {
					const text = String(word.text || '').trim();
					const bb = word.bbox;
					if (!text || !bb) {
						continue;
					}
					const box = normaliseBox([bb.x0, bb.y0, bb.x1, bb.y1], width, height);
					if (!box) {
						continue;
					}
					items.push({
						page,
						text,
						source: 'ocr',
						granularity: 'word',
						box,
						confidence: Number.isFinite(word.confidence) ? Math.round(word.confidence * 10) / 10 : 0,
					});
				}
			}
		}
	}
	return items;
}
