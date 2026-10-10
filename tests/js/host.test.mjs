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

// Host module helpers (no DOM needed) and cross-checks between the JS constants and the
// generated bundle manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browserInfo, supportInfo, normaliseConfig, mimeFromContentType, linesFromPages } from '../../assets/host/pdf-viewer.mjs';
import { preloadPaths } from '../../assets/host/preload.mjs';
import { PRELOADABLE, ERROR_CODES } from '../../assets/reader/protocol.mjs';
import { LANGUAGES, textsFor } from '../../assets/reader/i18n.mjs';

globalThis.Worker ??= class {};

const ua = {
	iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1',
	iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
	iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15',
	macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
	chrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
	android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
	firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
	webkitgtk: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
};
const brands = { brands: [{ brand: 'Chromium', version: '141' }, { brand: 'Google Chrome', version: '141' }] };
const nav = (userAgent, extra = {}) => ({ userAgent, platform: 'Linux x86_64', maxTouchPoints: 0, ...extra });

test('browserInfo: every iOS browser and Safari are WebKit; Chromium-based browsers and Firefox are not', () => {
	const engine = (n) => browserInfo(n).engine;
	assert.deepEqual(browserInfo(nav(ua.iphoneSafari, { platform: 'iPhone', maxTouchPoints: 5 })), { engine: 'webkit', ios: true, chromium: false, webkit: true });
	assert.equal(engine(nav(ua.iphoneChrome, { platform: 'iPhone', maxTouchPoints: 5 })), 'webkit');
	assert.equal(engine(nav(ua.iphoneFirefox, { platform: 'iPhone', maxTouchPoints: 5 })), 'webkit');
	assert.deepEqual(browserInfo(nav(ua.macSafari, { platform: 'MacIntel', maxTouchPoints: 5 })), { engine: 'webkit', ios: true, chromium: false, webkit: true }, 'iPadOS desktop mode');
	assert.deepEqual(browserInfo(nav(ua.macSafari, { platform: 'MacIntel' })), { engine: 'webkit', ios: false, chromium: false, webkit: true });
	assert.equal(engine(nav(ua.webkitgtk)), 'webkit');
	assert.deepEqual(browserInfo(nav(ua.chrome, { userAgentData: brands })), { engine: 'chromium', ios: false, chromium: true, webkit: false });
	assert.equal(engine(nav(ua.chrome)), 'chromium', 'without userAgentData');
	assert.equal(engine(nav(ua.android, { userAgentData: brands, maxTouchPoints: 5 })), 'chromium');
	assert.equal(engine(nav(ua.firefox)), 'gecko');
	assert.equal(engine(nav('Mozilla/5.0 (compatible; SomeBot/1.0)')), 'other');
});

test('supportInfo: only engines enabled in the configuration', () => {
	const engines = { chromium: true, webkit: false, gecko: false };
	const safari = nav(ua.iphoneSafari, { platform: 'iPhone', maxTouchPoints: 5 });
	assert.deepEqual(supportInfo({ engines }, safari), { supported: false, reason: 'engine_policy', engine: 'webkit' });
	assert.deepEqual(supportInfo({ engines: { ...engines, webkit: true } }, safari), { supported: true, reason: null, engine: 'webkit' });
	assert.deepEqual(supportInfo({ engines }, nav(ua.chrome, { userAgentData: brands })), { supported: true, reason: null, engine: 'chromium' });
	assert.deepEqual(supportInfo({ engines }, nav(ua.firefox)), { supported: false, reason: 'engine_policy', engine: 'gecko' });
	assert.deepEqual(supportInfo({ engines: { ...engines, gecko: true } }, nav(ua.firefox)), { supported: true, reason: null, engine: 'gecko' });
	assert.equal(supportInfo({ engines: { chromium: true, webkit: true, gecko: true } }, nav('SomeBot/1.0')).supported, false, 'unknown engine');
});

const config = () => ({
	version: 1,
	bundle: '0123456789ab',
	appOrigin: 'https://app.test',
	frameUrl: 'https://app.test/_pdf-viewer/frame/0123456789ab',
	assetBase: 'https://app.test/_pdf-viewer/assets/0123456789ab/',
	frameTitle: 'Document',
	limits: { maxPages: 1000, maxTextItemsPerPage: 20000, maxItemTextLength: 2000, maxFileBytes: 52428800 },
	timeouts: { readyMs: 15000, startAfterLoadMs: 5000, inactivityMs: 60000, openMs: 180000, ocrPageMs: 90000 },
	ocrLanguages: ['dan', 'eng'],
	preload: 'auto',
	engines: { chromium: true, webkit: false, gecko: false },
});

test('normaliseConfig accepts the server configuration and rejects broken ones', () => {
	const c = normaliseConfig(config());
	assert.ok(Object.isFrozen(c) && Object.isFrozen(c.limits));
	const broken = (patch, label) => assert.throws(() => normaliseConfig({ ...config(), ...patch }), TypeError, label);
	broken({ version: 2 }, 'version');
	broken({ appOrigin: '' }, 'appOrigin');
	broken({ assetBase: 'https://app.test/x' }, 'assetBase without slash');
	broken({ limits: { ...config().limits, maxPages: 0 } }, 'limits');
	broken({ timeouts: { ...config().timeouts, readyMs: 1.5 } }, 'timeouts');
	broken({ ocrLanguages: ['dan', '../x'] }, 'ocrLanguages');
	broken({ preload: 'sometimes' }, 'preload');
	broken({ engines: { webkit: 'yes' } }, 'engines value');
	broken({ engines: ['chromium'] }, 'engines list');
	assert.throws(() => normaliseConfig(null), TypeError);
});

test('mimeFromContentType accepts the three document types only', () => {
	assert.equal(mimeFromContentType('application/pdf'), 'application/pdf');
	assert.equal(mimeFromContentType('Image/JPEG; charset=binary'), 'image/jpeg');
	assert.equal(mimeFromContentType('image/png'), 'image/png');
	assert.equal(mimeFromContentType('text/html; charset=utf-8'), null);
	assert.equal(mimeFromContentType(null), null);
});

test('linesFromPages joins items on the same line and keeps the page order', () => {
	const it = (text, x0, y0) => ({ text, box: [x0, y0, x0 + 0.1, y0 + 0.02] });
	const lines = linesFromPages([
		{ page: 2, items: [it('Side', 0.1, 0.9)] },
		{ page: 1, items: [it('I alt', 0.1, 0.5), it('4.646,69', 0.8, 0.501), it('Moms', 0.1, 0.55)] },
	]);
	assert.deepEqual(lines, [{ page: 1, text: 'I alt 4.646,69' }, { page: 1, text: 'Moms' }, { page: 2, text: 'Side' }]);
});

// -- Cross-checks against the generated manifest ------------------------------------

const manifest = new Map();
for (const m of readFileSync(new URL('../../src/Constant/Bundle.php', import.meta.url), 'utf8').matchAll(/'([^']+)' => \[(\d+), '([0-9a-f]{64})'\]/g)) {
	manifest.set(m[1], Number(m[2]));
}

test('every preloadable path is in the bundle and under its size cap', () => {
	assert.ok(manifest.size > 100, 'manifest parsed');
	for (const [path, cap] of Object.entries(PRELOADABLE)) {
		assert.ok(manifest.has(path), 'in bundle: ' + path);
		assert.ok(manifest.get(path) <= cap, `under cap: ${path} (${manifest.get(path)} > ${cap})`);
	}
});

test('the host pushes only preloadable paths', () => {
	for (const mime of ['application/pdf', 'image/jpeg']) {
		for (const path of preloadPaths({ mime, autoOcr: true, ocrLanguages: ['dan', 'eng'] })) {
			assert.ok(Object.hasOwn(PRELOADABLE, path), 'preloadable: ' + path);
		}
	}
	assert.deepEqual(preloadPaths({ mime: 'image/png', autoOcr: false, ocrLanguages: ['dan'] }), []);
});

test('the reader and the host load their entry points from the bundle', () => {
	for (const path of [
		'reader/reader.mjs', 'reader/reader.css', 'host/pdf-viewer.mjs', 'host/pdf-viewer.css',
		'vendor/pdfjs/build/pdf.min.mjs', 'vendor/pdfjs/build/pdf.worker.min.mjs', 'vendor/pdfjs/web/pdf_viewer.mjs',
		'vendor/pdfjs/web/pdf_viewer.css', 'vendor/pdfjs/wasm/openjpeg.wasm', 'vendor/pdfjs/wasm/openjpeg_nowasm_fallback.js',
		'vendor/pdfjs/wasm/jbig2.wasm', 'vendor/pdfjs/wasm/qcms_bg.wasm', 'vendor/tesseract/tesseract.esm.min.js',
		'vendor/tesseract/worker.min.js', 'vendor/tesseract-core/tesseract-core-lstm.wasm.js',
		'vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js',
		'vendor/tessdata/dan.traineddata.gz', 'vendor/tessdata/eng.traineddata.gz',
	]) {
		assert.ok(manifest.has(path), path);
	}
});

test('every UI language has every text, including all error codes', () => {
	const en = textsFor('en');
	for (const lang of LANGUAGES) {
		const t = textsFor(lang);
		assert.deepEqual(Object.keys(t).sort(), Object.keys(en).sort(), lang);
		for (const code of ERROR_CODES.filter((c) => c !== 'cancelled')) {
			assert.equal(typeof t.error[code], 'string', lang + ' ' + code);
		}
	}
	assert.equal(textsFor('fr'), en, 'unknown language falls back to English');
});
