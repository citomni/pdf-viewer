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
 * Host side - PdfViewerHost: owns the reader frame, the handshake, the port and the timeouts.
 *
 * Behavior:
 * - One frame per document: open() always removes the previous frame (closing its port)
 *   before creating a new one. A frame receives at most one document.
 * - 'ready' is only accepted from the current pending frame's contentWindow, with origin
 *   'null' and the right nonce. Everything else is ignored and counted.
 * - The 'connect' message is posted with targetOrigin '*' (an opaque origin cannot be
 *   addressed) and transfers port2. All further traffic uses port1.
 * - Messages from a port that is not the current session's port, or with a stale job id,
 *   are dropped. Everything else is validated by validate.mjs; values from the frame are
 *   untrusted data and must only be shown with textContent/value.
 * - The host owns the final timeout and cancellation: cancel() sends 'cancel', closes the
 *   port and removes the frame without waiting for a reply, and reports the result itself.
 *
 * Events (CustomEvent detail):
 * - 'state'       {session, docId, state: 'pending'|'open'|'closed', readyMs?, reason?}
 * - 'progress'    {session, docId, stage, ...}   stages: received, loaded, rendered,
 *                                                examining, ocr, busy, idle, view
 * - 'text'        {session, docId, pages}        all pages known so far, sorted by page
 * - 'error'       {session, docId, code, page?, detail, by: 'frame'|'host', terminal}
 * - 'diagnostics' {session, docId, events, dropped}
 *
 * Error codes:
 * - From the frame: password_required, unsupported, damaged, too_large, decoder_missing,
 *   timeout, cancelled. With a page number the error is not terminal: the document stays
 *   visible and the page is marked as incomplete.
 * - From the host: timeout (ready, inactivity, open, ocr), cancelled, unsupported (engine
 *   policy or document type), too_large (Content-Length), unavailable (the document could
 *   not be fetched, or the frame loaded without starting the reader - e.g. a page that
 *   was opened before a deploy; reloading the page helps).
 *
 * Typical usage:
 *   import { PdfViewerHost } from '<assetBase>host/pdf-viewer.mjs';
 *   const viewer = new PdfViewerHost({ container, config });  // config from the server
 *   viewer.addEventListener('text', (e) => render(e.detail.pages));
 *   viewer.openUrl('/documents/42/file');
 */

import { validateFrameMessage } from './validate.mjs';
import { AssetPreloader } from './preload.mjs';

export const MIMES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png']);

const CONFIG_VERSION = 1;
const PRELOAD_MODES = ['auto', 'always', 'never'];

let sessionCounter = 0;

/**
 * Random URL-safe token (base64url).
 *
 * @param {number} bytes
 * @returns {string}
 */
export function randomToken(bytes = 24) {
	const a = new Uint8Array(bytes);
	crypto.getRandomValues(a);
	let s = '';
	for (const b of a) {
		s += String.fromCharCode(b);
	}
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Browser engine facts used by the policies.
 *
 * Notes:
 * - Every browser on iOS and iPadOS uses WebKit, whatever its name.
 * - No feature test reveals the behaviour that matters (WebKit sends the app's cookies
 *   with requests from the sandboxed frame), so the engine is inferred from the user agent.
 *
 * @param {Navigator} nav
 * @returns {{engine: 'chromium'|'webkit'|'gecko'|'other', ios: boolean, chromium: boolean, webkit: boolean}}
 */
export function browserInfo(nav = navigator) {
	const ua = String(nav.userAgent || '');
	const ios = /iP(hone|ad|od)/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
	const brands = nav.userAgentData && Array.isArray(nav.userAgentData.brands) ? nav.userAgentData.brands : null;
	const chromium = !ios && (brands ? brands.some((b) => b && b.brand === 'Chromium') : /Chrome\/|Chromium\//.test(ua));
	const webkit = ios || (!chromium && /AppleWebKit\//.test(ua) && !/Chrome\/|Chromium\//.test(ua));
	const gecko = !ios && !chromium && !webkit && /Gecko\/\d/.test(ua) && /Firefox\//.test(ua);
	const engine = chromium ? 'chromium' : webkit ? 'webkit' : gecko ? 'gecko' : 'other';
	return { engine, ios, chromium, webkit };
}

/**
 * Whether the viewer may run in this browser under the given configuration.
 *
 * Behavior:
 * - The engine must be enabled in config.engines (pdf_viewer.engines on the server).
 *   Engines that are not listed, and unknown engines, are not supported.
 *
 * @param {{engines: Object<string, boolean>}} config  Host configuration from the server.
 * @param {Navigator} nav
 * @returns {{supported: boolean, reason: string|null, engine: string}}
 */
export function supportInfo(config, nav = navigator) {
	const engine = browserInfo(nav).engine;
	if (typeof MessageChannel !== 'function' || typeof Worker !== 'function') {
		return { supported: false, reason: 'missing_platform_features', engine };
	}
	if (!config.engines || config.engines[engine] !== true) {
		return { supported: false, reason: 'engine_policy', engine };
	}
	return { supported: true, reason: null, engine };
}

/**
 * Build text lines from text items, keeping the order in which the frame delivered them
 * (content-stream order for PDF text, reading order for OCR). A new line starts when the
 * next item is not on the same line as the previous one (horizontal text); on rotated pages
 * this only affects line breaks, not the order.
 *
 * @param {Array<{page: number, items: Array<{text: string, box: number[]}>}>} pages
 * @returns {Array<{page: number, text: string}>}
 */
export function linesFromPages(pages) {
	const lines = [];
	for (const p of [...pages].sort((a, b) => a.page - b.page)) {
		let current = [];
		let last = null;
		const flush = () => {
			if (current.length) {
				lines.push({ page: p.page, text: current.join(' ') });
				current = [];
			}
		};
		for (const it of p.items) {
			const mid = (it.box[1] + it.box[3]) / 2;
			const h = it.box[3] - it.box[1];
			if (last && (Math.abs(mid - last.mid) > Math.max(h, last.h) * 0.5 || it.box[0] < last.x0)) {
				flush();
			}
			current.push(it.text);
			last = { mid, h, x0: it.box[0] };
		}
		flush();
	}
	return lines;
}

/**
 * Validate the host configuration produced by the server (PdfViewer::hostConfig()).
 *
 * @param {object} config
 * @returns {object}  A frozen copy.
 * @throws {TypeError}  When a field is missing or has the wrong type.
 */
export function normaliseConfig(config) {
	const fail = (what) => {
		throw new TypeError('PdfViewerHost: invalid config (' + what + ')');
	};
	if (config === null || typeof config !== 'object') {
		fail('not an object');
	}
	if (config.version !== CONFIG_VERSION) {
		fail('version');
	}
	for (const k of ['bundle', 'appOrigin', 'frameUrl', 'assetBase', 'frameTitle']) {
		if (typeof config[k] !== 'string' || config[k] === '') {
			fail(k);
		}
	}
	if (!config.assetBase.endsWith('/')) {
		fail('assetBase');
	}
	const ints = (obj, keys, what) => {
		if (obj === null || typeof obj !== 'object') {
			fail(what);
		}
		for (const k of keys) {
			if (!Number.isInteger(obj[k]) || obj[k] <= 0) {
				fail(what + '.' + k);
			}
		}
	};
	ints(config.limits, ['maxPages', 'maxTextItemsPerPage', 'maxItemTextLength', 'maxFileBytes'], 'limits');
	ints(config.timeouts, ['readyMs', 'startAfterLoadMs', 'inactivityMs', 'openMs', 'ocrPageMs'], 'timeouts');
	if (!Array.isArray(config.ocrLanguages) || !config.ocrLanguages.every((l) => typeof l === 'string' && /^[a-z_]{2,16}$/.test(l))) {
		fail('ocrLanguages');
	}
	if (!PRELOAD_MODES.includes(config.preload)) {
		fail('preload');
	}
	if (config.engines === null || typeof config.engines !== 'object' || Array.isArray(config.engines) || !Object.values(config.engines).every((v) => typeof v === 'boolean')) {
		fail('engines');
	}
	return Object.freeze({
		...config,
		limits: Object.freeze({ ...config.limits }),
		timeouts: Object.freeze({ ...config.timeouts }),
		ocrLanguages: Object.freeze([...config.ocrLanguages]),
		engines: Object.freeze({ ...config.engines }),
	});
}

/**
 * MIME type from a Content-Type header value; null when it is not a supported type.
 *
 * @param {string|null} contentType
 * @returns {string|null}
 */
export function mimeFromContentType(contentType) {
	const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
	return MIMES.includes(mime) ? mime : null;
}

export class PdfViewerHost extends EventTarget {
	#container;
	#config;
	#support;
	#preloader = null;
	#current = null;
	#openSeq = 0;
	#onWindowMessage;
	stats = { readyRejected: 0, portDropped: 0, invalidMessages: 0, sessions: 0, preloadErrors: 0 };

	/**
	 * @param {{container: Element, config: object}} opts
	 *   config is the server's host configuration (PdfViewer::hostConfig(), JSON).
	 * @throws {TypeError}  Invalid container or configuration.
	 * @throws {Error}      The page does not run on the configured app origin (http.base_url).
	 */
	constructor({ container, config }) {
		super();
		if (!(container instanceof Element)) {
			throw new TypeError('PdfViewerHost: container must be an element');
		}
		this.#container = container;
		this.#config = normaliseConfig(config);
		if (window.location.origin !== this.#config.appOrigin) {
			// postMessage targets and the frame's CSP use the configured origin: a page on any
			// other origin (e.g. www vs. bare domain) can never complete the handshake.
			throw new Error('PdfViewerHost: page origin ' + window.location.origin + ' is not the configured app origin ' + this.#config.appOrigin);
		}
		this.#support = supportInfo(this.#config);
		const preload = this.#config.preload;
		if (preload === 'always' || (preload === 'auto' && browserInfo().chromium)) {
			this.#preloader = new AssetPreloader(this.#config.assetBase, this.#config.ocrLanguages);
		}
		this.#onWindowMessage = (e) => this.#handleWindowMessage(e);
		window.addEventListener('message', this.#onWindowMessage);
	}

	/** Whether open() will start the reader in this browser. */
	get supported() {
		return this.#support.supported;
	}

	/** Why the reader does not run here ('engine_policy', 'missing_platform_features') or null. */
	get unsupportedReason() {
		return this.#support.reason;
	}

	/** Browser engine as the policy sees it: 'chromium', 'webkit', 'gecko' or 'other'. */
	get engine() {
		return this.#support.engine;
	}

	/** Whether the cache mitigation (preload) is active in this browser. */
	get preloading() {
		return this.#preloader !== null;
	}

	/**
	 * Read-only summary of the current session, or null.
	 *
	 * @returns {{session: number, docId: *, state: string, mime: string, numPages: number, currentPage: number}|null}
	 */
	get current() {
		const s = this.#current;
		if (!s) {
			return null;
		}
		return Object.freeze({ session: s.id, docId: s.docId, state: s.state, mime: s.mime, numPages: s.numPages, currentPage: s.currentPage });
	}

	/**
	 * Open a document in a new frame.
	 *
	 * Notes:
	 * - bytes are transferred to the frame (the ArrayBuffer is detached); pass a copy if the
	 *   caller keeps them. A promise lets the frame start while the document downloads.
	 * - In a browser that is not supported (see supported), no frame is created and an
	 *   'error' with code 'unsupported' is dispatched.
	 *
	 * @param {{bytes: ArrayBuffer|Promise<ArrayBuffer>, mime: string, autoOcr?: boolean, docId?: *}} doc
	 * @returns {number}  The session id used in the events.
	 */
	open({ bytes, mime, autoOcr = true, docId = null }) {
		this.#openSeq++;
		this.close('replaced');
		const id = ++sessionCounter;
		if (!this.#support.supported) {
			this.#emit('error', { session: id, docId, code: 'unsupported', detail: this.#support.reason + ':' + this.#support.engine, by: 'host', terminal: true });
			return id;
		}
		if (!MIMES.includes(mime)) {
			this.#emit('error', { session: id, docId, code: 'unsupported', detail: 'mime: ' + String(mime).slice(0, 60), by: 'host', terminal: true });
			return id;
		}
		const session = {
			// Cache mitigation: start reading the asset files from the host's HTTP cache now.
			assets: this.#preloader ? this.#preloader.filesFor({ mime, autoOcr: Boolean(autoOcr) }).catch(() => {
				this.stats.preloadErrors++;
				return null;
			}) : null,
			id,
			docId,
			mime,
			autoOcr: Boolean(autoOcr),
			nonce: randomToken(24),
			jobId: randomToken(18),
			state: 'pending',
			iframe: null,
			port: null,
			bytes,
			pages: new Map(),
			numPages: 0,
			currentPage: 1,
			timers: {},
			t0: performance.now(),
			readyMs: null,
			opensSent: 0,
			pendingOcr: null,
			textReceived: false,
		};
		const iframe = document.createElement('iframe');
		iframe.setAttribute('sandbox', 'allow-scripts');
		iframe.setAttribute('referrerpolicy', 'no-referrer');
		iframe.title = this.#config.frameTitle;
		iframe.className = 'pdf-viewer-frame';
		iframe.addEventListener('load', () => this.#frameLoaded(session));
		iframe.src = this.#config.frameUrl + '#n=' + session.nonce;
		session.iframe = iframe;
		this.#current = session;
		this.stats.sessions++;
		this.#container.append(iframe);
		session.timers.ready = setTimeout(() => this.#timeout(session, 'ready'), this.#config.timeouts.readyMs);
		this.#emit('state', { session: id, docId, state: 'pending' });
		return id;
	}

	/**
	 * Fetch a document from the app (same origin, with the session cookie) and open it.
	 *
	 * Behavior:
	 * - The MIME type comes from the option or else from the response's Content-Type.
	 * - A Content-Length above limits.maxFileBytes aborts the download ('too_large').
	 * - A later open()/openUrl() supersedes a download that is still waiting for headers.
	 *
	 * @param {string} url
	 * @param {{mime?: string|null, autoOcr?: boolean, docId?: *, init?: RequestInit}} options
	 * @returns {Promise<number|null>}  The session id, or null when superseded.
	 */
	async openUrl(url, { mime = null, autoOcr = true, docId = null, init = {} } = {}) {
		const seq = ++this.#openSeq;
		this.close('replaced');
		const fail = (code, detail) => {
			const id = ++sessionCounter;
			this.#emit('error', { session: id, docId, code, detail, by: 'host', terminal: true });
			return id;
		};
		if (!this.#support.supported) {
			return fail('unsupported', this.#support.reason + ':' + this.#support.engine);
		}
		const abort = new AbortController();
		let resp;
		try {
			resp = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal, ...init });
		} catch (err) {
			return seq === this.#openSeq ? fail('unavailable', String(err && err.message || err).slice(0, 200)) : null;
		}
		if (seq !== this.#openSeq) {
			abort.abort();
			return null;
		}
		if (!resp.ok) {
			abort.abort();
			return fail('unavailable', 'HTTP ' + resp.status);
		}
		const type = mime ?? mimeFromContentType(resp.headers.get('Content-Type'));
		if (!MIMES.includes(type)) {
			abort.abort();
			return fail('unsupported', 'mime: ' + String(type ?? resp.headers.get('Content-Type')).slice(0, 60));
		}
		const length = Number(resp.headers.get('Content-Length'));
		if (Number.isFinite(length) && length > this.#config.limits.maxFileBytes) {
			abort.abort();
			return fail('too_large', 'file size ' + length);
		}
		return this.open({ bytes: resp.arrayBuffer(), mime: type, autoOcr, docId });
	}

	/**
	 * Ask the frame to OCR one page (also pages with a usable text layer).
	 *
	 * @param {number} page  1-based page number.
	 * @returns {boolean}  False when no document is open.
	 */
	ocrPage(page) {
		const s = this.#current;
		if (!s || s.state !== 'open' || !Number.isInteger(page) || page < 1) {
			return false;
		}
		s.port.postMessage({ type: 'ocrPage', jobId: s.jobId, page });
		clearTimeout(s.timers.ocr);
		s.pendingOcr = page;
		s.timers.ocr = setTimeout(() => this.#timeout(s, 'ocr'), this.#config.timeouts.ocrPageMs);
		return true;
	}

	/**
	 * Cancel the current job: send 'cancel', close the port, remove the frame, report.
	 *
	 * @param {string} code    'cancelled' (user) or 'timeout'.
	 * @param {string} detail
	 */
	cancel(code = 'cancelled', detail = 'host') {
		const s = this.#current;
		if (!s) {
			return;
		}
		try {
			s.port?.postMessage({ type: 'cancel', jobId: s.jobId });
		} catch {
			// The port may already be closed.
		}
		this.#closeSession(s, code);
		this.#emit('error', { session: s.id, docId: s.docId, code, detail, by: 'host', terminal: true });
	}

	/** Remove the current frame without reporting an error. */
	close(reason = 'closed') {
		const s = this.#current;
		if (s) {
			this.#closeSession(s, reason);
		}
	}

	/** Remove the frame and stop listening for messages. */
	destroy() {
		this.#openSeq++;
		this.close('destroyed');
		window.removeEventListener('message', this.#onWindowMessage);
	}

	#closeSession(s, reason) {
		for (const t of Object.values(s.timers)) {
			clearTimeout(t);
		}
		if (s.port) {
			s.port.onmessage = null;
			s.port.close();
		}
		s.iframe?.remove();
		s.state = 'closed';
		s.bytes = null;
		s.assets = null;
		if (this.#current === s) {
			this.#current = null;
		}
		this.#emit('state', { session: s.id, docId: s.docId, state: 'closed', reason });
	}

	/** The frame document loaded: the reader posts 'ready' before that, so wait briefly only. */
	#frameLoaded(s) {
		if (s !== this.#current || s.state !== 'pending') {
			return;
		}
		clearTimeout(s.timers.afterLoad);
		s.timers.afterLoad = setTimeout(() => {
			if (s === this.#current && s.state === 'pending') {
				this.cancel('unavailable', 'frame loaded without starting the reader');
			}
		}, this.#config.timeouts.startAfterLoadMs);
	}

	#handleWindowMessage(e) {
		const s = this.#current;
		const d = e.data;
		const looksLikeReady = d && typeof d === 'object' && d.type === 'ready';
		if (!looksLikeReady) {
			return;
		}
		let rejected = !s || s.state !== 'pending' || e.source !== s.iframe.contentWindow || e.origin !== 'null' || d.nonce !== s.nonce;
		if (rejected) {
			this.stats.readyRejected++;
			return;
		}
		clearTimeout(s.timers.ready);
		clearTimeout(s.timers.afterLoad);
		s.readyMs = Math.round(performance.now() - s.t0);
		const channel = new MessageChannel();
		s.port = channel.port1;
		s.port.onmessage = (ev) => this.#handlePortMessage(s, ev);
		s.iframe.contentWindow.postMessage({ type: 'connect', nonce: s.nonce }, '*', [channel.port2]);
		s.state = 'open';
		this.#armOpenTimer(s);
		this.#emit('state', { session: s.id, docId: s.docId, state: 'open', readyMs: s.readyMs });
		// The bytes may still be downloading (open() accepts a promise).
		Promise.all([Promise.resolve(s.bytes), s.assets]).then(([bytes, assets]) => {
			if (s !== this.#current || s.state !== 'open' || s.opensSent > 0) {
				return;
			}
			if (!(bytes instanceof ArrayBuffer)) {
				this.cancel('damaged', 'no document bytes');
				return;
			}
			if (assets) {
				s.port.postMessage({ type: 'assets', jobId: s.jobId, files: assets.files }, assets.transfer);
			}
			s.assets = null;
			// Exactly one document per frame.
			s.opensSent++;
			s.bytes = null;
			s.port.postMessage({ type: 'open', jobId: s.jobId, mime: s.mime, bytes, autoOcr: s.autoOcr }, [bytes]);
		}, () => {
			if (s === this.#current) {
				this.cancel('unavailable', 'document download failed');
			}
		});
	}

	#armOpenTimer(s) {
		clearTimeout(s.timers.inactivity);
		s.timers.inactivity = setTimeout(() => this.#timeout(s, 'inactivity'), this.#config.timeouts.inactivityMs);
		if (!s.timers.open && !s.textReceived) {
			s.timers.open = setTimeout(() => this.#timeout(s, 'open'), this.#config.timeouts.openMs);
		}
	}

	#timeout(s, which) {
		if (s !== this.#current || s.state === 'closed') {
			return;
		}
		this.cancel('timeout', which);
	}

	#handlePortMessage(s, e) {
		if (s !== this.#current || s.state !== 'open') {
			this.stats.portDropped++;
			return;
		}
		const msg = validateFrameMessage(e.data, s.jobId, this.#config.limits);
		if (!msg) {
			this.stats.invalidMessages++;
			return;
		}
		this.#armOpenTimer(s);
		if (msg.type === 'progress') {
			if (msg.stage === 'diag') {
				this.#emit('diagnostics', { session: s.id, docId: s.docId, events: msg.events || [], dropped: msg.dropped || 0 });
				return;
			}
			if (msg.stage === 'loaded') {
				s.numPages = msg.numPages;
			} else if (msg.stage === 'view' && msg.page) {
				s.currentPage = msg.page;
			} else if (msg.stage === 'idle') {
				clearTimeout(s.timers.inactivity);
				s.timers.inactivity = null;
			}
			const { type, jobId, ...rest } = msg;
			this.#emit('progress', { session: s.id, docId: s.docId, ...rest });
			return;
		}
		if (msg.type === 'text') {
			if (!s.textReceived) {
				s.textReceived = true;
				clearTimeout(s.timers.open);
			}
			for (const p of msg.pages) {
				s.pages.set(p.page, p);
				if (s.pendingOcr === p.page) {
					clearTimeout(s.timers.ocr);
					s.pendingOcr = null;
				}
			}
			this.#emit('text', { session: s.id, docId: s.docId, pages: [...s.pages.values()].sort((a, b) => a.page - b.page) });
			return;
		}
		if (msg.type === 'error') {
			if (msg.page) {
				this.#emit('error', { session: s.id, docId: s.docId, code: msg.code, page: msg.page, detail: msg.detail || '', by: 'frame', terminal: false });
				return;
			}
			this.#closeSession(s, 'error:' + msg.code);
			this.#emit('error', { session: s.id, docId: s.docId, code: msg.code, detail: msg.detail || '', by: 'frame', terminal: true });
		}
	}

	#emit(type, detail) {
		this.dispatchEvent(new CustomEvent(type, { detail }));
	}
}
