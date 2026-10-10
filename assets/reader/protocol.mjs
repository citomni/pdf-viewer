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
 * Reader frame - protocol helpers (pure functions, no side effects).
 *
 * Handshake:
 *   1. The host creates the iframe with "#n=<nonce>" in the URL fragment.
 *   2. Frame -> host: window.postMessage({type: 'ready', nonce}, appOrigin).
 *   3. Host -> frame: window.postMessage({type: 'connect', nonce}, '*', [port2]).
 *   4. All further traffic goes over the MessagePort.
 *
 * Messages host -> frame (port): open {jobId, mime, bytes, autoOcr}, ocrPage {jobId, page},
 * cancel {jobId}, and optionally assets {jobId, files} before open (cache mitigation).
 * Messages frame -> host (port): progress {jobId, ...}, text {jobId, pages},
 * error {jobId, code, page?, detail?}. There is no message type with which the frame can
 * ask the host to fetch a URL or perform an action in the app.
 */

export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const JOB_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MIMES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png']);

/**
 * Files the host may push to the frame before 'open' (cache mitigation), with size caps.
 * Paths are asset-manifest paths; the frame resolves them against its own asset base.
 */
export const PRELOADABLE = Object.freeze({
	'vendor/pdfjs/build/pdf.worker.min.mjs': 3_000_000,
	'vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf': 400_000,
	'vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf': 400_000,
	'vendor/pdfjs/wasm/jbig2.wasm': 400_000,
	'vendor/tesseract/worker.min.js': 500_000,
	'vendor/tesseract-core/tesseract-core-lstm.wasm.js': 8_000_000,
	'vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js': 8_000_000,
	'vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js': 8_000_000,
	'vendor/tessdata/dan.traineddata.gz': 8_000_000,
	'vendor/tessdata/eng.traineddata.gz': 8_000_000,
});

export const ERROR_CODES = Object.freeze([
	'password_required',
	'unsupported',
	'damaged',
	'too_large',
	'decoder_missing',
	'timeout',
	'cancelled',
]);

/**
 * Read the handshake nonce from the URL fragment ("#n=<nonce>").
 *
 * @param {string} hash  location.hash
 * @returns {string|null}
 */
export function readNonce(hash) {
	const m = /^#n=([A-Za-z0-9_-]{16,64})$/.exec(hash || '');
	return m ? m[1] : null;
}

/**
 * Decide whether a window message is a valid 'connect' from the host.
 *
 * All conditions must hold: the source is the parent window, the origin is the app origin,
 * the message is {type: 'connect', nonce} with the expected nonce, and exactly one
 * MessagePort was transferred.
 *
 * @param {MessageEvent} event
 * @param {{appOrigin: string, nonce: string, parentWindow: Window}} expected
 * @returns {boolean}
 */
export function isValidConnect(event, expected) {
	if (!event || event.source !== expected.parentWindow) {
		return false;
	}
	if (event.origin !== expected.appOrigin) {
		return false;
	}
	const d = event.data;
	if (d === null || typeof d !== 'object' || d.type !== 'connect') {
		return false;
	}
	if (typeof d.nonce !== 'string' || d.nonce !== expected.nonce) {
		return false;
	}
	if (!event.ports || event.ports.length !== 1) {
		return false;
	}
	return true;
}

/**
 * Validate a message received on the port from the host.
 *
 * @param {unknown} data
 * @returns {{type: 'open', jobId: string, mime: string, bytes: ArrayBuffer, autoOcr: boolean}
 *   | {type: 'ocrPage', jobId: string, page: number}
 *   | {type: 'cancel', jobId: string}
 *   | {type: 'assets', jobId: string, files: Object<string, ArrayBuffer>}
 *   | null}
 */
export function parseHostMessage(data) {
	if (data === null || typeof data !== 'object') {
		return null;
	}
	if (typeof data.jobId !== 'string' || !JOB_RE.test(data.jobId)) {
		return null;
	}
	switch (data.type) {
		case 'open':
			if (!MIMES.includes(data.mime) || !(data.bytes instanceof ArrayBuffer) || typeof data.autoOcr !== 'boolean') {
				return null;
			}
			return { type: 'open', jobId: data.jobId, mime: data.mime, bytes: data.bytes, autoOcr: data.autoOcr };
		case 'ocrPage':
			if (!Number.isInteger(data.page) || data.page < 1) {
				return null;
			}
			return { type: 'ocrPage', jobId: data.jobId, page: data.page };
		case 'cancel':
			return { type: 'cancel', jobId: data.jobId };
		case 'assets': {
			const files = data.files;
			if (files === null || typeof files !== 'object' || Array.isArray(files)) {
				return null;
			}
			const out = {};
			for (const [path, buf] of Object.entries(files)) {
				const cap = Object.hasOwn(PRELOADABLE, path) ? PRELOADABLE[path] : 0;
				if (!cap || !(buf instanceof ArrayBuffer) || buf.byteLength === 0 || buf.byteLength > cap) {
					return null;
				}
				out[path] = buf;
			}
			return { type: 'assets', jobId: data.jobId, files: out };
		}
		default:
			return null;
	}
}
