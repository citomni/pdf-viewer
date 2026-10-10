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
 * Reader frame - diagnostics and worker plumbing.
 *
 * Functional parts (always on):
 * - Every Worker created in the frame gets a listener for "__readerDiag" messages posted by
 *   the worker prologue below. Worker console output drives the decoder-failure detection
 *   and the OCR engine's start-up abort detection.
 * - Files pushed by the host (cache mitigation) are handed to the worker that needs them.
 * - terminateAllWorkers() stops every worker the frame created.
 *
 * Diagnostics (reported to the host as progress {stage: 'diag'} messages):
 * - Always: CSP violations, uncaught errors, attempts by any code in the frame to use
 *   storage or cookies (the getters are wrapped and re-thrown, so the behaviour of the
 *   opaque origin is unchanged), and the reader's own facts (compat, worker setup,
 *   decoder warnings, limits, protocol rejections).
 * - Verbose only (pdf_viewer.diagnostics = true): resource timing of the frame and its
 *   workers, overlay and text-rule details, worker console lines.
 */

const MAX_EVENTS = 400;

/** Event kinds reported also when diagnostics are not verbose. */
const ESSENTIAL = new Set([
	'csp',
	'error',
	'storage',
	'compat',
	'handshake',
	'protocol',
	'pdfWorker',
	'pdfjsWarning',
	'render',
	'image',
	'limit',
	'ocrError',
]);

export const diag = {
	verbose: false,
	events: [],
	dropped: 0,
	workers: new Set(),
	workerCount: 0,
	/** blob URL -> {files, transfer}: posted to the worker right after it is constructed. */
	workerPreload: new Map(),
	/** Handler for worker console lines (set by the reader). */
	onWorkerConsole: null,
	push(kind, data) {
		if (!this.verbose && !ESSENTIAL.has(kind)) {
			return;
		}
		if (this.events.length >= MAX_EVENTS) {
			this.dropped++;
			return;
		}
		this.events.push({ t: Math.round(performance.now()), kind, ...data });
	},
	/** Take all buffered events (used when flushing to the host). */
	take() {
		const out = this.events;
		this.events = [];
		return out;
	},
};

/**
 * Prologue prepended to worker scripts that the reader builds itself.
 *
 * It forwards console output and errors to the creating document, answers fetch() for files
 * the reader handed over from memory, and (verbose only) reports resource timing. The
 * messages carry no "targetName", so PDF.js' and Tesseract.js' own message handlers ignore
 * them.
 *
 * @param {boolean} verbose  Include the resource timing observer.
 * @returns {string}
 */
export function workerPrologue(verbose) {
	return `
const __rdPost = (m) => { try { self.postMessage(Object.assign({ __readerDiag: 1 }, m)); } catch (e) {} };
// Files handed over by the reader: answered from memory instead of the network.
const __rdPreload = new Map();
self.addEventListener('message', (e) => {
	const d = e.data;
	if (d && d.__readerPreload) {
		for (const k of Object.keys(d.__readerPreload)) { __rdPreload.set(k, d.__readerPreload[k]); }
		e.stopImmediatePropagation();
	}
});
const __rdFetch = self.fetch.bind(self);
self.fetch = function (input, init) {
	const u = typeof input === 'string' ? input : (input && input.url) || '';
	const buf = __rdPreload.get(u);
	if (buf) {
		__rdPreload.delete(u);
		__rdPost({ k: 'preloadHit', u: u.slice(-80), n: buf.byteLength });
		return Promise.resolve(new Response(buf, { status: 200 }));
	}
	return __rdFetch(input, init);
};
for (const __l of ['log', 'info', 'warn', 'error']) {
	const __o = console[__l];
	console[__l] = function () {
		let s = '';
		for (const a of arguments) { try { s += (s ? ' ' : '') + (typeof a === 'string' ? a : String(a)); } catch (e) { s += ' ?'; } }
		__rdPost({ k: 'console', l: __l, m: s.slice(0, 1500) });
		return __o.apply(console, arguments);
	};
}
self.addEventListener('error', (e) => __rdPost({ k: 'error', m: String(e.message).slice(0, 500) }));
self.addEventListener('unhandledrejection', (e) => __rdPost({ k: 'error', m: 'unhandledrejection: ' + String(e.reason).slice(0, 500) }));
self.addEventListener('securitypolicyviolation', (e) => __rdPost({ k: 'csp', d: e.effectiveDirective, u: String(e.blockedURI).slice(0, 300) }));
${verbose ? `try {
	new PerformanceObserver((list) => {
		for (const e of list.getEntries()) {
			__rdPost({ k: 'rt', e: { n: e.name, it: e.initiatorType, ts: e.transferSize, eb: e.encodedBodySize, db: e.decodedBodySize, st: Math.round(e.startTime), d: Math.round(e.duration) } });
		}
	}).observe({ type: 'resource', buffered: true });
} catch (e) {}` : ''}
`;
}

/**
 * Install the document-level shims. Call once, before any library is imported.
 *
 * @param {boolean} verbose  Report verbose diagnostics (resource timing and details).
 */
export function installDiagnostics(verbose) {
	diag.verbose = Boolean(verbose);
	document.addEventListener('securitypolicyviolation', (e) => {
		diag.push('csp', { directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 300), sample: String(e.sample || '').slice(0, 80) });
	});
	window.addEventListener('error', (e) => {
		diag.push('error', { message: String(e.message).slice(0, 500) });
	});
	window.addEventListener('unhandledrejection', (e) => {
		diag.push('error', { message: 'unhandledrejection: ' + String(e.reason).slice(0, 500) });
	});

	// -- Storage and cookie access attempts ---------------------------------------------
	for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
		const desc = Object.getOwnPropertyDescriptor(window, name) || findDescriptor(window, name);
		if (!desc || !desc.get || !desc.configurable) {
			continue;
		}
		Object.defineProperty(window, name, {
			configurable: true,
			enumerable: desc.enumerable,
			get() {
				const caller = callerHint();
				try {
					const v = desc.get.call(window);
					diag.push('storage', { api: name, result: 'ok', caller });
					return v;
				} catch (err) {
					diag.push('storage', { api: name, result: err.name, caller });
					throw err;
				}
			},
		});
	}
	const cookieDesc = findDescriptor(Document.prototype, 'cookie');
	if (cookieDesc && cookieDesc.configurable) {
		Object.defineProperty(Document.prototype, 'cookie', {
			configurable: true,
			enumerable: cookieDesc.enumerable,
			get() {
				try {
					const v = cookieDesc.get.call(this);
					diag.push('storage', { api: 'document.cookie', result: 'ok', caller: callerHint() });
					return v;
				} catch (err) {
					diag.push('storage', { api: 'document.cookie', result: err.name, caller: callerHint() });
					throw err;
				}
			},
			set(v) {
				try {
					cookieDesc.set.call(this, v);
					diag.push('storage', { api: 'document.cookie=', result: 'ok', caller: callerHint() });
				} catch (err) {
					diag.push('storage', { api: 'document.cookie=', result: err.name, caller: callerHint() });
					throw err;
				}
			},
		});
	}

	// -- Workers: attach the diagnostics listener to every Worker created in the frame ----
	const NativeWorker = window.Worker;
	window.Worker = class extends NativeWorker {
		constructor(url, options) {
			super(url, options);
			// Lets the owner of a blob URL find (and terminate) the worker started from it.
			this.diagUrl = String(url);
			diag.workerCount++;
			diag.workers.add(this);
			const pre = diag.workerPreload.get(String(url));
			if (pre) {
				// First message to the worker, before any library message.
				diag.workerPreload.delete(String(url));
				super.postMessage({ __readerPreload: pre.files }, pre.transfer);
			}
			const kind = options && options.type === 'module' ? 'module' : 'classic';
			const scheme = String(url).split(':', 1)[0];
			diag.push('worker', { event: 'created', workerType: kind, scheme });
			this.addEventListener('message', (e) => {
				const d = e.data;
				if (!d || d.__readerDiag !== 1) {
					return;
				}
				if (d.k === 'console' && diag.onWorkerConsole) {
					diag.onWorkerConsole(d.l, d.m, this.diagUrl);
				}
				if (d.k === 'preloadHit') {
					diag.push('preloadHit', { url: d.u, bytes: d.n });
				} else if (d.k === 'rt') {
					diag.push('rt', { src: 'worker', ...shortRt(d.e) });
				} else if (d.k === 'csp') {
					diag.push('csp', { directive: d.d, blocked: d.u, src: 'worker' });
				} else if (d.k === 'error') {
					diag.push('error', { message: d.m, src: 'worker' });
				} else if (d.k === 'console' && (d.l === 'warn' || d.l === 'error')) {
					diag.push('console', { level: d.l, message: d.m, src: 'worker' });
				}
			});
		}
		terminate() {
			diag.workers.delete(this);
			super.terminate();
		}
	};

	// -- Resource timing of the frame document (verbose only) ---------------------------
	if (!diag.verbose) {
		return;
	}
	try {
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				diag.push('rt', { src: 'frame', ...shortRt({ n: e.name, it: e.initiatorType, ts: e.transferSize, eb: e.encodedBodySize, db: e.decodedBodySize, st: Math.round(e.startTime), d: Math.round(e.duration) }) });
			}
		}).observe({ type: 'resource', buffered: true });
	} catch {
		// Resource timing not available: measurements are reported as missing.
	}
}

/** Terminate every worker the frame created (used on cancel and on fatal errors). */
export function terminateAllWorkers() {
	for (const w of diag.workers) {
		try {
			w.terminate();
		} catch {
			// Already gone.
		}
	}
	diag.workers.clear();
}

function shortRt(e) {
	let path = e.n;
	try {
		const u = new URL(e.n);
		path = u.protocol === 'blob:' ? 'blob:' : u.origin + u.pathname;
	} catch {
		// Keep as is.
	}
	return { url: String(path).slice(0, 300), initiator: e.it, transfer: e.ts, encoded: e.eb, decoded: e.db, start: e.st, duration: e.d };
}

function findDescriptor(obj, name) {
	for (let o = obj; o; o = Object.getPrototypeOf(o)) {
		const d = Object.getOwnPropertyDescriptor(o, name);
		if (d) {
			return d;
		}
	}
	return null;
}

function callerHint() {
	const stack = String(new Error().stack || '').split('\n');
	for (const line of stack.slice(2)) {
		if (!line.includes('/reader/diag.mjs')) {
			const m = /(\/[A-Za-z0-9_.-]+\.m?js)(?::\d+)?/.exec(line);
			return m ? m[1] : line.trim().slice(0, 120);
		}
	}
	return '';
}
