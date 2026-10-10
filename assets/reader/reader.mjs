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
 * Reader frame - main module.
 *
 * Runs inside <iframe sandbox="allow-scripts"> (opaque origin). Receives exactly one
 * document from the host over a MessagePort, displays it (PDF.js components or <img>),
 * extracts text with positions and runs OCR (Tesseract.js) on pages without usable text.
 *
 * Library configuration:
 * - PDF.js 6.4.299 legacy build, imported as ES modules from the asset route.
 * - The PDF.js worker is created from a Blob (worker code fetched with CORS) and handed to
 *   PDF.js via GlobalWorkerOptions.workerPort. It runs as a classic worker because module
 *   workers from blob: URLs do not start in an opaque origin (compat.mjs,
 *   toClassicWorkerScript).
 *   workerSrc is never set, so PDF.js can never fall back to a "fake worker" on the main
 *   thread.
 * - getDocument: wasmUrl, cMapUrl (packed), standardFontDataUrl and iccUrl on the asset
 *   route; useSystemFonts false; enableXfa false; maxImageSize = limits.maxPdfImagePixels.
 *   No PDFScriptingManager, no pdf.sandbox, no QuickJS.
 * - Display: PDFViewer + EventBus + PDFLinkService (externalLinkEnabled = false).
 * - Safari before 27 lacks ReadableStream async iteration, which getTextContent() needs;
 *   compat.mjs installs it in the frame when missing.
 * - Every request the reader makes is a CORS request without credentials (modules,
 *   stylesheets, fetch). Only images referenced by PDF.js' own CSS and annotation icons are
 *   no-cors requests; they are decorative.
 */

import { installReadableStreamIteration, toClassicWorkerScript } from './compat.mjs';
import { installDiagnostics, diag, workerPrologue, terminateAllWorkers } from './diag.mjs';
import { textsFor, errorText } from './i18n.mjs';
import { readNonce, isValidConnect, parseHostMessage } from './protocol.mjs';
import { assessText, itemBox } from './textrule.mjs';
import { Ocr } from './ocr.mjs';

const cfg = JSON.parse(document.querySelector('meta[name="pdf-viewer-config"]').content);

installDiagnostics(cfg.diagnostics === true);
// Before PDF.js runs: getTextContent() needs ReadableStream async iteration (Safari < 27).
diag.push('compat', { readableStreamIteration: installReadableStreamIteration() ? 'installed' : 'native' });

const T0 = performance.now();
const L = cfg.limits;
const ASSET = cfg.assetBase;
const TX = textsFor(cfg.language);
const PDFJS = {
	lib: ASSET + 'vendor/pdfjs/build/pdf.min.mjs',
	worker: ASSET + 'vendor/pdfjs/build/pdf.worker.min.mjs',
	viewer: ASSET + 'vendor/pdfjs/web/pdf_viewer.mjs',
	wasm: ASSET + 'vendor/pdfjs/wasm/',
	cmaps: ASSET + 'vendor/pdfjs/cmaps/',
	fonts: ASSET + 'vendor/pdfjs/standard_fonts/',
	iccs: ASSET + 'vendor/pdfjs/iccs/',
	images: ASSET + 'vendor/pdfjs/web/images/',
};

const $ = (id) => document.getElementById(id);
const els = {
	toolbar: $('toolbar'),
	pageInfo: $('pageInfo'),
	status: $('status'),
	message: $('message'),
	viewerContainer: $('viewerContainer'),
	viewer: $('viewer'),
	imageContainer: $('imageContainer'),
	imagePage: $('imagePage'),
	imageEl: $('imageEl'),
	chkBoxes: $('chkBoxes'),
};

const state = {
	nonce: null,
	refused: false,
	connected: false,
	port: null,
	opened: false,
	closed: false,
	jobId: null,
	autoOcr: true,
	mime: null,
	ready: false,
	numPages: 0,
	pdfjs: null,
	pdf: null,
	loadingTask: null,
	pdfWorker: null,
	viewer: null,
	eventBus: null,
	pages: new Map(),
	pageViews: new Map(),
	rendering: new Set(),
	pageErrors: new Map(),
	decoderFailures: new Map(),
	ocr: null,
	firstRendered: false,
	timings: {},
	handshakeTimer: null,
	diagTimer: null,
	assets: null,
};

/** Take (and forget) a file the host pushed with 'assets'; null if not provided. */
function takePreload(url) {
	const files = state.assets ? state.assets.files : null;
	if (!files || !files.has(url)) {
		return null;
	}
	const buf = files.get(url);
	files.delete(url);
	return buf;
}

function mark(name) {
	state.timings[name] = Math.round(performance.now() - T0);
}

// Console output of every worker: PDF.js warnings (decoder failures, image size limit) and
// the OCR engine's start-up abort.
diag.onWorkerConsole = (level, message, url) => {
	state.ocr?.noteWorkerConsole(level, message, url);
	onPdfWorkerConsole(level, message);
};

// ---------------------------------------------------------------------------------
// Boot and handshake
// ---------------------------------------------------------------------------------

boot();

function boot() {
	mark('moduleStart');
	applyTexts();
	if (window.parent === window) {
		refuse(TX.embeddedOnly);
		return;
	}
	state.nonce = readNonce(location.hash);
	if (!state.nonce) {
		refuse(TX.invalidAddress);
		return;
	}
	window.addEventListener('message', onWindowMessage);
	window.parent.postMessage({ type: 'ready', nonce: state.nonce }, cfg.appOrigin);
	mark('readySent');
	state.handshakeTimer = setTimeout(() => {
		if (!state.connected) {
			refuse(TX.noConnection);
		}
	}, L.handshakeTimeoutMs);
}

/** Localised static texts of the frame document. */
function applyTexts() {
	document.title = TX.title;
	$('btnPrev').title = TX.previousPage;
	$('btnNext').title = TX.nextPage;
	$('btnZoomOut').title = TX.zoomOut;
	$('btnZoomIn').title = TX.zoomIn;
	$('lblBoxes').textContent = TX.boxes;
	showMessage(TX.loading, false);
}

/** Stop working: no further messages are accepted. */
function refuse(text) {
	state.refused = true;
	window.removeEventListener('message', onWindowMessage);
	showMessage(text, true);
	document.documentElement.dataset.refused = '1';
}

function connectRejectReason(e) {
	if (e.source !== window.parent) {
		return 'source';
	}
	if (e.origin !== cfg.appOrigin) {
		return 'origin';
	}
	const d = e.data;
	if (!d || typeof d !== 'object' || d.type !== 'connect') {
		return 'type';
	}
	if (d.nonce !== state.nonce) {
		return 'nonce';
	}
	return 'ports:' + (e.ports ? e.ports.length : 0);
}

function onWindowMessage(e) {
	if (state.refused) {
		return;
	}
	if (state.connected) {
		// Never acted upon; recorded so that probing is visible in the diagnostics.
		diag.push('handshake', { rejected: 'already-connected', reason: connectRejectReason(e) });
		return;
	}
	if (!isValidConnect(e, { appOrigin: cfg.appOrigin, nonce: state.nonce, parentWindow: window.parent })) {
		diag.push('handshake', { rejected: 'connect', reason: connectRejectReason(e) });
		return;
	}
	state.connected = true;
	clearTimeout(state.handshakeTimer);
	state.port = e.ports[0];
	state.port.onmessage = onPortMessage;
	mark('connected');
	diag.push('handshake', { accepted: 'connect' });
	// Start loading PDF.js while the host sends the document.
	loadPdfJs().catch(() => {});
}

function onPortMessage(e) {
	if (state.closed) {
		return;
	}
	const msg = parseHostMessage(e.data);
	if (!msg) {
		diag.push('protocol', { rejected: 'invalid-message' });
		return;
	}
	if (msg.type === 'assets') {
		if (state.opened || state.assets) {
			diag.push('protocol', { rejected: 'assets-late-or-twice' });
			return;
		}
		const files = new Map(Object.entries(msg.files).map(([p, b]) => [ASSET + p, b]));
		state.assets = { jobId: msg.jobId, files };
		diag.push('assets', { files: files.size, bytes: [...files.values()].reduce((n, b) => n + b.byteLength, 0) });
		return;
	}
	if (msg.type === 'open') {
		if (state.assets && state.assets.jobId !== msg.jobId) {
			state.assets = null;
			diag.push('protocol', { rejected: 'assets-job-mismatch' });
		}
		if (state.opened) {
			diag.push('protocol', { rejected: 'second-open' });
			return;
		}
		state.opened = true;
		state.jobId = msg.jobId;
		state.autoOcr = msg.autoOcr;
		state.mime = msg.mime;
		mark('open');
		startDiagFlush();
		handleOpen(msg).catch((err) => fatal(classifyError(err), String(err && err.message || err)));
		return;
	}
	if (msg.jobId !== state.jobId) {
		diag.push('protocol', { rejected: 'job-mismatch', type: msg.type });
		return;
	}
	if (msg.type === 'cancel') {
		cancel();
	} else if (msg.type === 'ocrPage') {
		manualOcr(msg.page);
	}
}

// ---------------------------------------------------------------------------------
// Messages to the host
// ---------------------------------------------------------------------------------

function send(type, payload) {
	if (!state.port || state.closed) {
		return;
	}
	state.port.postMessage({ type, jobId: state.jobId, ...payload });
}

function progress(stage, data = {}) {
	send('progress', { stage, ...data });
}

/** Page-level error: the document stays visible, the page is marked as incomplete. */
function pageError(page, code, detail) {
	if (state.pageErrors.has(page)) {
		return;
	}
	state.pageErrors.set(page, { code, detail });
	showPageWarning(page);
	send('error', { code, page, detail: String(detail || '').slice(0, 300) });
}

/** Terminal error: report, stop all work and free resources. */
async function fatal(code, detail) {
	if (state.closed) {
		return;
	}
	flushDiag();
	send('error', { code, detail: String(detail || '').slice(0, 300) });
	state.closed = true;
	showMessage(errorText(TX, code), true);
	await teardown();
}

async function cancel() {
	if (state.closed) {
		return;
	}
	flushDiag();
	send('error', { code: 'cancelled' });
	state.closed = true;
	showMessage(TX.cancelled, false);
	await teardown();
}

async function teardown() {
	clearInterval(state.diagTimer);
	try {
		await state.ocr?.terminate();
	} catch {
		// Ignore.
	}
	try {
		await state.loadingTask?.destroy();
	} catch {
		// Ignore.
	}
	terminateAllWorkers();
	// The port is left open so the final message is delivered; state.closed stops all
	// further sends, and the host closes its end and removes the frame.
}

function startDiagFlush() {
	flushDiag();
	state.diagTimer = setInterval(flushDiag, 500);
}

function flushDiag() {
	if (!state.jobId || state.closed) {
		return;
	}
	const events = diag.take();
	if (events.length || diag.dropped) {
		progress('diag', { events, dropped: diag.dropped });
	}
}

// ---------------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------------

async function handleOpen(msg) {
	const size = msg.bytes.byteLength;
	progress('received', { bytes: size });
	if (size > L.maxFileBytes) {
		return fatal('too_large', 'file size ' + size);
	}
	if (size === 0) {
		return fatal('damaged', 'empty file');
	}
	if (msg.mime === 'application/pdf') {
		await openPdf(msg.bytes);
	} else {
		await openImage(msg.bytes, msg.mime);
	}
}

function classifyError(err) {
	const name = err && err.name;
	if (name === 'PasswordException') {
		return 'password_required';
	}
	if (err && err.code && typeof err.code === 'string') {
		return err.code;
	}
	return 'damaged';
}

// ---------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------

let pdfJsPromise = null;

function loadPdfJs() {
	if (!pdfJsPromise) {
		pdfJsPromise = (async () => {
			const t0 = performance.now();
			const lib = await import(PDFJS.lib);
			if (!globalThis.pdfjsLib) {
				globalThis.pdfjsLib = lib;
			}
			const viewerLib = await import(PDFJS.viewer);
			state.timings.pdfjsImportMs = Math.round(performance.now() - t0);
			mark('pdfjsLoaded');
			state.pdfjs = { lib, viewerLib };
			return state.pdfjs;
		})();
	}
	return pdfJsPromise;
}

/**
 * Create the PDF.js worker from a Blob (classic worker, see toClassicWorkerScript) and wait
 * for its "ready" message.
 *
 * @returns {Promise<Worker>}
 */
async function startPdfWorker(lib) {
	const t0 = performance.now();
	let source;
	const pre = takePreload(PDFJS.worker);
	if (pre) {
		source = new TextDecoder().decode(pre);
	} else {
		const resp = await fetch(PDFJS.worker, { mode: 'cors', credentials: 'omit' });
		if (!resp.ok) {
			throw Object.assign(new Error('worker script HTTP ' + resp.status), { code: 'unsupported' });
		}
		source = await resp.text();
	}
	const code = toClassicWorkerScript(source);
	const url = URL.createObjectURL(new Blob([workerPrologue(diag.verbose), '\n', code], { type: 'text/javascript' }));
	// Fonts and decoders pushed by the host are answered from memory inside the worker.
	const files = {};
	const transfer = [];
	for (const u of [PDFJS.fonts + 'LiberationSans-Regular.ttf', PDFJS.fonts + 'LiberationSans-Bold.ttf', PDFJS.wasm + 'jbig2.wasm']) {
		const b = takePreload(u);
		if (b) {
			files[u] = b;
			transfer.push(b);
		}
	}
	if (transfer.length) {
		diag.workerPreload.set(url, { files, transfer });
	}
	const worker = new Worker(url);
	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(Object.assign(new Error('worker did not start'), { code: 'unsupported' })), L.workerStartTimeoutMs);
			worker.addEventListener('message', function onMsg(e) {
				const d = e.data;
				if (d && d.sourceName === 'worker' && d.targetName === 'main' && d.action === 'ready') {
					clearTimeout(timer);
					worker.removeEventListener('message', onMsg);
					resolve();
				}
			});
			worker.addEventListener('error', (e) => {
				clearTimeout(timer);
				reject(Object.assign(new Error('worker error: ' + (e.message || 'load failed')), { code: 'unsupported' }));
			}, { once: true });
		});
	} finally {
		URL.revokeObjectURL(url);
	}
	lib.GlobalWorkerOptions.workerPort = worker;
	state.pdfWorker = worker;
	state.timings.pdfWorkerStartMs = Math.round(performance.now() - t0);
	mark('pdfWorkerReady');
	diag.push('pdfWorker', {
		workerType: 'classic',
		from: 'blob',
		codeFrom: pre ? 'host' : 'network',
		readyMessage: true,
		workerPortIsOurs: lib.GlobalWorkerOptions.workerPort === worker,
		workerSrcSet: Boolean(lib.GlobalWorkerOptions.workerSrc),
		mainThreadWorkerCode: 'pdfjsWorker' in globalThis,
	});
	return worker;
}

async function openPdf(bytes) {
	const head = new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength));
	if (!hasPdfHeader(head)) {
		return fatal('damaged', 'no %PDF header');
	}
	const { lib, viewerLib } = await loadPdfJs();
	await startPdfWorker(lib);

	let passwordRequired = false;
	const task = lib.getDocument({
		data: new Uint8Array(bytes),
		wasmUrl: PDFJS.wasm,
		cMapUrl: PDFJS.cmaps,
		cMapPacked: true,
		standardFontDataUrl: PDFJS.fonts,
		iccUrl: PDFJS.iccs,
		useSystemFonts: false,
		enableXfa: false,
		maxImageSize: L.maxPdfImagePixels,
		stopAtErrors: false,
		verbosity: 1,
	});
	state.loadingTask = task;
	task.onPassword = () => {
		// Never prompt: report and stop.
		passwordRequired = true;
		fatal('password_required', 'user password');
	};
	let pdf;
	try {
		pdf = await task.promise;
	} catch (err) {
		if (state.closed) {
			return;
		}
		return fatal(passwordRequired ? 'password_required' : classifyError(err), err && err.name);
	}
	if (state.closed) {
		return;
	}
	state.pdf = pdf;
	state.numPages = pdf.numPages;
	mark('docLoaded');
	if (pdf.numPages > L.maxPages) {
		return fatal('too_large', 'pages ' + pdf.numPages);
	}
	progress('loaded', { numPages: pdf.numPages, kind: 'pdf' });
	setupPdfViewer(lib, viewerLib, pdf);
	state.ready = true;
	await examineAutomatically();
}

function hasPdfHeader(head) {
	for (let i = 0; i + 4 < head.length; i++) {
		if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) {
			return true;
		}
	}
	return false;
}

function setupPdfViewer(lib, viewerLib, pdf) {
	const { EventBus, PDFLinkService, PDFViewer, LinkTarget } = viewerLib;
	els.toolbar.hidden = false;
	els.viewerContainer.hidden = false;
	hideMessage();
	const eventBus = new EventBus();
	const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.NONE });
	linkService.externalLinkEnabled = false;
	const viewer = new PDFViewer({
		container: els.viewerContainer,
		viewer: els.viewer,
		eventBus,
		linkService,
		textLayerMode: 1,
		annotationMode: lib.AnnotationMode.ENABLE,
		annotationEditorMode: lib.AnnotationEditorType.DISABLE,
		imageResourcesPath: PDFJS.images,
		maxCanvasPixels: L.maxDisplayCanvasPixels,
		enableAutoLinking: false,
	});
	linkService.setViewer(viewer);
	eventBus.on('pagesinit', () => {
		viewer.currentScaleValue = 'page-width';
	});
	eventBus.on('pagerender', ({ pageNumber }) => {
		state.rendering.add(pageNumber);
	});
	eventBus.on('pagerendered', ({ pageNumber, source, error }) => {
		state.rendering.delete(pageNumber);
		state.pageViews.set(pageNumber, source.div);
		if (!state.firstRendered && !error) {
			state.firstRendered = true;
			mark('firstRender');
			progress('rendered', { page: pageNumber, ms: state.timings.firstRender });
		}
		if (error) {
			diag.push('render', { page: pageNumber, error: String(error && error.message || error).slice(0, 200) });
		}
		drawBoxes(pageNumber);
		showPageWarning(pageNumber);
	});
	eventBus.on('pagechanging', ({ pageNumber }) => {
		updatePageInfo(pageNumber);
		progress('view', { page: pageNumber });
	});
	viewer.setDocument(pdf);
	linkService.setDocument(pdf, null);
	state.viewer = viewer;
	state.eventBus = eventBus;
	updatePageInfo(1);
	$('btnPrev').onclick = () => viewer.previousPage();
	$('btnNext').onclick = () => viewer.nextPage();
	$('btnZoomIn').onclick = () => viewer.increaseScale();
	$('btnZoomOut').onclick = () => viewer.decreaseScale();
	els.chkBoxes.onchange = () => document.body.classList.toggle('noBoxes', !els.chkBoxes.checked);
}

function updatePageInfo(page) {
	els.pageInfo.textContent = page + ' / ' + (state.numPages || 1);
}

/**
 * Examine the first and the last page automatically (text layer first, OCR if needed and
 * autoOcr is set). Other pages are reported as not examined.
 */
async function examineAutomatically() {
	const n = state.numPages;
	for (let p = 1; p <= n; p++) {
		state.pages.set(p, { page: p, examined: false, ocr: 'skipped', items: [] });
	}
	const targets = n === 1 ? [1] : [1, n];
	for (const p of targets) {
		if (state.closed) {
			return;
		}
		await examinePdfPage(p, state.autoOcr);
	}
	if (state.closed) {
		return;
	}
	mark('textDone');
	sendText([...state.pages.values()]);
	idle();
}

async function examinePdfPage(p, allowOcr) {
	const entry = state.pages.get(p);
	progress('examining', { page: p });
	const page = await state.pdf.getPage(p);
	const vp = page.getViewport({ scale: 1 });
	const tc = await page.getTextContent();
	const [vx0, vy0, vx1, vy1] = page.view;
	const assessment = assessText(tc.items.map((i) => i.str || ''), Math.abs((vx1 - vx0) * (vy1 - vy0)), L.usableText);
	entry.examined = true;
	entry.rule = assessment;
	diag.push('textRule', { page: p, ...assessment });
	if (assessment.usable) {
		entry.items = textItems(tc, vp, p);
		entry.ocr = 'not_needed';
		drawBoxes(p);
		return;
	}
	entry.items = [];
	if (!allowOcr) {
		entry.ocr = 'skipped';
		return;
	}
	await ocrPdfPage(p);
}

function textItems(tc, vp, p) {
	const items = [];
	for (const it of tc.items) {
		if (typeof it.str !== 'string' || !it.str.trim()) {
			continue;
		}
		const style = tc.styles[it.fontName] || {};
		const ascent = style.ascent > 0 ? style.ascent : 0.8;
		const descent = style.descent < 0 ? -style.descent : 0.2;
		const box = itemBox(it, vp, ascent, descent);
		if (!box) {
			continue;
		}
		items.push({ page: p, text: it.str.slice(0, L.maxItemTextLength), source: 'text', granularity: 'item', box });
		if (items.length >= L.maxTextItemsPerPage) {
			diag.push('limit', { page: p, truncatedItems: true });
			break;
		}
	}
	return items;
}

async function ensureOcr() {
	if (!state.ocr) {
		state.ocr = new Ocr({
			assetBase: ASSET,
			languages: cfg.ocrLanguages,
			onProgress: (p) => progress('ocr', p),
			takePreload: (path) => takePreload(ASSET + path),
			startTimeoutMs: L.workerStartTimeoutMs,
			verbose: diag.verbose,
		});
	}
	return state.ocr;
}

async function ocrPdfPage(p) {
	const entry = state.pages.get(p);
	const ocr = await ensureOcr();
	progress('ocr', { page: p, phase: 'start' });
	let canvas = null;
	try {
		const page = await state.pdf.getPage(p);
		const vp1 = page.getViewport({ scale: 1 });
		let scale = L.ocrDpi / 72;
		const px = vp1.width * vp1.height * scale * scale;
		if (px > L.maxOcrPixels) {
			scale *= Math.sqrt(L.maxOcrPixels / px);
		}
		const vp = page.getViewport({ scale });
		canvas = document.createElement('canvas');
		canvas.width = Math.floor(vp.width);
		canvas.height = Math.floor(vp.height);
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		state.rendering.add(p);
		const t0 = performance.now();
		try {
			// intent 'print': PDF.js then schedules rendering steps with microtasks instead of
			// requestAnimationFrame, which browsers pause for background tabs and throttle for
			// off-screen cross-origin frames (OCR would otherwise stall until the frame is seen).
			await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
		} finally {
			state.rendering.delete(p);
		}
		const renderMs = Math.round(performance.now() - t0);
		const res = await ocr.recognize(canvas, p, L.ocrTimeoutMs);
		entry.items = res.items;
		entry.ocr = 'done';
		entry.examined = true;
		entry.ocrMeta = { renderMs, ocrMs: res.ms, width: canvas.width, height: canvas.height, dpi: Math.round(scale * 72), meanConfidence: res.meanConfidence };
		state.timings.ocrInitMs = ocr.timings.initMs ?? state.timings.ocrInitMs;
		progress('ocr', { page: p, phase: 'done', ms: res.ms, renderMs, words: res.items.length });
		drawBoxes(p);
	} catch (err) {
		if (state.closed) {
			return;
		}
		entry.ocr = 'failed';
		entry.examined = true;
		const code = err && (err.code === 'timeout' || err.code === 'unsupported') ? err.code : 'damaged';
		diag.push('ocrError', { page: p, message: String(err && err.message || err).slice(0, 300) });
		if (code === 'timeout') {
			// The worker may be stuck: terminate it; a later OCR request creates a new one.
			await state.ocr?.terminate();
			state.ocr = null;
		}
		pageError(p, code, 'ocr: ' + String(err && err.message || err));
	} finally {
		if (canvas) {
			canvas.width = 0;
			canvas.height = 0;
		}
	}
}

async function manualOcr(p) {
	if (!state.ready || p > state.numPages) {
		diag.push('protocol', { rejected: 'ocrPage', page: p });
		return;
	}
	progress('busy', { page: p });
	if (state.mime === 'application/pdf') {
		await ocrPdfPage(p);
	} else {
		await ocrImage();
	}
	if (state.closed) {
		return;
	}
	sendText([state.pages.get(p)]);
	idle();
}

function sendText(pages) {
	flushDiag();
	send('text', {
		pages: pages.map((e) => ({ page: e.page, examined: e.examined, ocr: e.ocr, items: e.items, rule: e.rule || null, ocrMeta: e.ocrMeta || null })),
	});
}

function idle() {
	flushDiag();
	progress('idle', { timings: { ...state.timings }, ocrTimings: state.ocr ? { ...state.ocr.timings } : null });
	setStatus('');
}

// ---------------------------------------------------------------------------------
// PDF.js warnings from the worker: decoder failures and removed images
// ---------------------------------------------------------------------------------

/**
 * Classify PDF.js worker warnings.
 *
 * PDF.js catches image decoding errors in its asynchronous image path, logs a warning and
 * continues with an empty image, so a page can look complete while content is missing.
 * The warning chain identifies the cause:
 *   "#instantiateWasm: Error: Failed to fetch file \".../openjpeg.wasm\" with \"Not Found\"."
 *   "#getJsModule: ..."  (the JS fallback is not in the bundle either)
 *   "Unable to decode image \"img_p0_1\": \"JpxError: OpenJPEG failed to initialize\"."
 * "failed to initialize" only occurs when neither the wasm module nor the JS fallback
 * could be loaded, i.e. the decoder is unavailable -> decoder_missing. Other decode
 * failures -> damaged. "Image exceeded maximum allowed size" -> too_large.
 *
 * Notes:
 * - Depends on PDF.js' warning texts and verbosity >= 1; retest with every PDF.js update.
 */
function onPdfWorkerConsole(level, message) {
	if (typeof message !== 'string' || !message.startsWith('Warning:')) {
		return;
	}
	diag.push('pdfjsWarning', { message: message.slice(0, 400) });
	let m = /#instantiateWasm: (.*)$/.exec(message);
	if (m) {
		const decoder = /openjpeg/i.test(m[1]) ? 'jpx' : /jbig2/i.test(m[1]) ? 'jbig2' : 'unknown';
		state.decoderFailures.set(decoder, m[1].slice(0, 200));
		return;
	}
	m = /Unable to decode image "([^"]*)": "(.*)"\.?$/.exec(message);
	if (m) {
		const pageIndex = /_p(\d+)_/.exec(m[1]);
		const pages = pageIndex ? [Number(pageIndex[1]) + 1] : [...state.rendering];
		const reason = m[2];
		let code = 'damaged';
		let detail = reason;
		const init = /^(JpxError|Jbig2Error): (OpenJPEG|JBig2) failed to initialize/.exec(reason);
		if (init) {
			const decoder = init[1] === 'JpxError' ? 'jpx' : 'jbig2';
			const cause = state.decoderFailures.get(decoder) || state.decoderFailures.get('unknown') || 'initialisation failed';
			code = 'decoder_missing';
			detail = decoder + ': ' + cause;
		}
		for (const p of pages) {
			pageError(p, code, detail);
		}
		return;
	}
	if (message.includes('Image exceeded maximum allowed size and was removed')) {
		const pages = [...state.rendering];
		for (const p of pages) {
			pageError(p, 'too_large', 'image above ' + L.maxPdfImagePixels + ' pixels removed');
		}
		if (!pages.length) {
			diag.push('limit', { removedImage: true, page: null });
		}
	}
}

// ---------------------------------------------------------------------------------
// Images (JPEG / PNG)
// ---------------------------------------------------------------------------------

async function openImage(bytes, mime) {
	const u8 = new Uint8Array(bytes);
	const info = mime === 'image/jpeg' ? jpegInfo(u8) : pngInfo(u8);
	if (!info) {
		return fatal('damaged', 'not a valid ' + mime);
	}
	if (info.width * info.height > L.maxImagePixels) {
		return fatal('too_large', 'image ' + info.width + 'x' + info.height);
	}
	const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
	els.imageEl.src = url;
	try {
		await els.imageEl.decode();
	} catch {
		return fatal('damaged', 'image decode failed');
	}
	state.numPages = 1;
	state.ready = true;
	const w = els.imageEl.naturalWidth;
	const h = els.imageEl.naturalHeight;
	const swapped = info.orientation >= 5 && info.orientation <= 8;
	diag.push('image', { width: info.width, height: info.height, exifOrientation: info.orientation, displayedWidth: w, displayedHeight: h, orientationApplied: swapped ? (w === info.height && h === info.width) : (w === info.width && h === info.height) });
	els.imageContainer.hidden = false;
	els.toolbar.hidden = false;
	hideMessage();
	updatePageInfo(1);
	els.chkBoxes.onchange = () => document.body.classList.toggle('noBoxes', !els.chkBoxes.checked);
	$('btnZoomIn').onclick = () => zoomImage(1.25);
	$('btnZoomOut').onclick = () => zoomImage(0.8);
	state.pageViews.set(1, els.imagePage);
	progress('loaded', { numPages: 1, kind: 'image' });
	mark('firstRender');
	state.firstRendered = true;
	progress('rendered', { page: 1, ms: state.timings.firstRender });
	state.pages.set(1, { page: 1, examined: true, ocr: 'skipped', items: [] });
	if (state.autoOcr) {
		await ocrImage();
	}
	if (state.closed) {
		return;
	}
	mark('textDone');
	sendText([state.pages.get(1)]);
	idle();
}

let imageZoom = 1;
function zoomImage(f) {
	imageZoom = Math.min(4, Math.max(0.25, imageZoom * f));
	els.imagePage.style.width = (imageZoom * 100) + '%';
}

async function ocrImage() {
	const entry = state.pages.get(1);
	const ocr = await ensureOcr();
	progress('ocr', { page: 1, phase: 'start' });
	let canvas = null;
	try {
		const w = els.imageEl.naturalWidth;
		const h = els.imageEl.naturalHeight;
		const scale = Math.min(1, Math.sqrt(L.maxOcrPixels / (w * h)));
		canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(w * scale));
		canvas.height = Math.max(1, Math.round(h * scale));
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		// drawImage() of an <img> follows its image-orientation (EXIF by default), so the OCR
		// canvas has the same orientation as the displayed image.
		ctx.drawImage(els.imageEl, 0, 0, canvas.width, canvas.height);
		const res = await ocr.recognize(canvas, 1, L.ocrTimeoutMs);
		entry.items = res.items;
		entry.ocr = 'done';
		entry.ocrMeta = { ocrMs: res.ms, width: canvas.width, height: canvas.height, meanConfidence: res.meanConfidence };
		progress('ocr', { page: 1, phase: 'done', ms: res.ms, words: res.items.length });
		drawBoxes(1);
	} catch (err) {
		if (state.closed) {
			return;
		}
		entry.ocr = 'failed';
		const code = err && (err.code === 'timeout' || err.code === 'unsupported') ? err.code : 'damaged';
		diag.push('ocrError', { page: 1, message: String(err && err.message || err).slice(0, 300) });
		if (code === 'timeout') {
			await state.ocr?.terminate();
			state.ocr = null;
		}
		pageError(1, code, 'ocr: ' + String(err && err.message || err));
	} finally {
		if (canvas) {
			canvas.width = 0;
			canvas.height = 0;
		}
	}
}

/** Dimensions and EXIF orientation of a JPEG (no decoding). */
function jpegInfo(u8) {
	if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) {
		return null;
	}
	let orientation = 1;
	let i = 2;
	while (i + 4 <= u8.length) {
		if (u8[i] !== 0xff) {
			return null;
		}
		const marker = u8[i + 1];
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			i += 2;
			continue;
		}
		const len = (u8[i + 2] << 8) | u8[i + 3];
		if (marker === 0xe1 && len >= 8) {
			orientation = exifOrientation(u8, i + 4, len - 2) || orientation;
		}
		// SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (i + 9 > u8.length) {
				return null;
			}
			const height = (u8[i + 5] << 8) | u8[i + 6];
			const width = (u8[i + 7] << 8) | u8[i + 8];
			return width && height ? { width, height, orientation } : null;
		}
		i += 2 + len;
	}
	return null;
}

function exifOrientation(u8, start, len) {
	const end = Math.min(u8.length, start + len);
	if (end - start < 14 || String.fromCharCode(...u8.subarray(start, start + 4)) !== 'Exif') {
		return 0;
	}
	const t = start + 6;
	const le = u8[t] === 0x49;
	const r16 = (o) => (le ? u8[o] | (u8[o + 1] << 8) : (u8[o] << 8) | u8[o + 1]);
	const r32 = (o) => (le ? (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0 : ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0);
	const ifd = t + r32(t + 4);
	if (ifd + 2 > end) {
		return 0;
	}
	const count = r16(ifd);
	for (let k = 0; k < count; k++) {
		const e = ifd + 2 + k * 12;
		if (e + 12 > end) {
			break;
		}
		if (r16(e) === 0x0112) {
			const v = r16(e + 8);
			return v >= 1 && v <= 8 ? v : 0;
		}
	}
	return 0;
}

/** Dimensions of a PNG (no decoding). */
function pngInfo(u8) {
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (u8.length < 24 || !sig.every((b, k) => u8[k] === b)) {
		return null;
	}
	const width = ((u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19]) >>> 0;
	const height = ((u8[20] << 24) | (u8[21] << 16) | (u8[22] << 8) | u8[23]) >>> 0;
	return width && height ? { width, height, orientation: 1 } : null;
}

// ---------------------------------------------------------------------------------
// Overlay and messages
// ---------------------------------------------------------------------------------

function drawBoxes(p) {
	const host = state.pageViews.get(p);
	const entry = state.pages.get(p);
	if (!host || !entry) {
		return;
	}
	let layer = host.querySelector(':scope > .boxLayer');
	if (!layer) {
		layer = document.createElement('div');
		layer.className = 'boxLayer';
		host.append(layer);
	}
	layer.replaceChildren();
	diag.push('overlay', { page: p, boxes: entry.items.length });
	const frag = document.createDocumentFragment();
	for (const it of entry.items) {
		const [x0, y0, x1, y1] = it.box;
		const d = document.createElement('div');
		d.className = 'box ' + (it.source === 'ocr' ? 'boxOcr' : 'boxText');
		d.style.left = (x0 * 100) + '%';
		d.style.top = (y0 * 100) + '%';
		d.style.width = ((x1 - x0) * 100) + '%';
		d.style.height = ((y1 - y0) * 100) + '%';
		frag.append(d);
	}
	layer.append(frag);
}

function showPageWarning(p) {
	const err = state.pageErrors.get(p);
	const host = state.pageViews.get(p);
	if (!err || !host || host.querySelector(':scope > .pageWarning')) {
		return;
	}
	const w = document.createElement('div');
	w.className = 'pageWarning';
	w.textContent = TX.pageIncomplete(err.code);
	host.append(w);
}

function showMessage(text, isError) {
	els.message.hidden = false;
	els.message.textContent = text;
	els.message.classList.toggle('error', Boolean(isError));
}

function hideMessage() {
	els.message.hidden = true;
}

function setStatus(text) {
	els.status.textContent = text;
}
