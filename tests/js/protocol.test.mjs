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

// Frame side of the protocol: handshake checks and validation of host messages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readNonce, isValidConnect, parseHostMessage, PRELOADABLE, ERROR_CODES, MIMES } from '../../assets/reader/protocol.mjs';

const NONCE = 'abcdefghijklmnopqrstuvwx';
const JOB = 'job-12345678';

test('readNonce accepts only "#n=<16..64 url-safe chars>"', () => {
	assert.equal(readNonce('#n=' + NONCE), NONCE);
	assert.equal(readNonce('#n=short'), null);
	assert.equal(readNonce('#n=' + 'a'.repeat(65)), null);
	assert.equal(readNonce('#n=' + NONCE + '&x=1'), null);
	assert.equal(readNonce('#x=' + NONCE), null);
	assert.equal(readNonce(''), null);
	assert.equal(readNonce(undefined), null);
});

test('isValidConnect requires parent source, app origin, type, nonce and exactly one port', () => {
	const parent = {};
	const expected = { appOrigin: 'https://app.test', nonce: NONCE, parentWindow: parent };
	const ok = { source: parent, origin: 'https://app.test', data: { type: 'connect', nonce: NONCE }, ports: [{}] };
	assert.equal(isValidConnect(ok, expected), true);
	assert.equal(isValidConnect({ ...ok, source: {} }, expected), false, 'other source');
	assert.equal(isValidConnect({ ...ok, origin: 'null' }, expected), false, 'other origin');
	assert.equal(isValidConnect({ ...ok, data: { type: 'ready', nonce: NONCE } }, expected), false, 'type');
	assert.equal(isValidConnect({ ...ok, data: { type: 'connect', nonce: NONCE + 'x' } }, expected), false, 'nonce');
	assert.equal(isValidConnect({ ...ok, data: null }, expected), false, 'no data');
	assert.equal(isValidConnect({ ...ok, ports: [] }, expected), false, '0 ports');
	assert.equal(isValidConnect({ ...ok, ports: [{}, {}] }, expected), false, '2 ports');
	assert.equal(isValidConnect(null, expected), false);
});

test('parseHostMessage accepts the four message types with valid fields only', () => {
	const bytes = new ArrayBuffer(8);
	assert.deepEqual(parseHostMessage({ type: 'open', jobId: JOB, mime: 'application/pdf', bytes, autoOcr: true }), { type: 'open', jobId: JOB, mime: 'application/pdf', bytes, autoOcr: true });
	assert.equal(parseHostMessage({ type: 'open', jobId: JOB, mime: 'text/html', bytes, autoOcr: true }), null, 'mime');
	assert.equal(parseHostMessage({ type: 'open', jobId: JOB, mime: 'application/pdf', bytes: new Uint8Array(8), autoOcr: true }), null, 'bytes type');
	assert.equal(parseHostMessage({ type: 'open', jobId: JOB, mime: 'application/pdf', bytes, autoOcr: 'yes' }), null, 'autoOcr type');
	assert.deepEqual(parseHostMessage({ type: 'ocrPage', jobId: JOB, page: 3 }), { type: 'ocrPage', jobId: JOB, page: 3 });
	assert.equal(parseHostMessage({ type: 'ocrPage', jobId: JOB, page: 0 }), null);
	assert.equal(parseHostMessage({ type: 'ocrPage', jobId: JOB, page: 1.5 }), null);
	assert.deepEqual(parseHostMessage({ type: 'cancel', jobId: JOB }), { type: 'cancel', jobId: JOB });
	assert.equal(parseHostMessage({ type: 'fetch', jobId: JOB, url: '/x' }), null, 'unknown type');
	assert.equal(parseHostMessage({ type: 'cancel', jobId: 'short' }), null, 'job id');
	assert.equal(parseHostMessage({ type: 'cancel', jobId: JOB + '/x' }), null, 'job id charset');
	assert.equal(parseHostMessage(null), null);
	assert.equal(parseHostMessage('open'), null);
	for (const mime of MIMES) {
		assert.ok(parseHostMessage({ type: 'open', jobId: JOB, mime, bytes, autoOcr: false }));
	}
});

test('parseHostMessage accepts pushed files only from the allowlist, non-empty and under the cap', () => {
	const [path, cap] = Object.entries(PRELOADABLE)[0];
	const ok = parseHostMessage({ type: 'assets', jobId: JOB, files: { [path]: new ArrayBuffer(10) } });
	assert.equal(ok.type, 'assets');
	assert.equal(ok.files[path].byteLength, 10);
	assert.equal(parseHostMessage({ type: 'assets', jobId: JOB, files: { 'reader/reader.mjs': new ArrayBuffer(10) } }), null, 'not preloadable');
	assert.equal(parseHostMessage({ type: 'assets', jobId: JOB, files: { [path]: new ArrayBuffer(0) } }), null, 'empty');
	assert.equal(parseHostMessage({ type: 'assets', jobId: JOB, files: { [path]: new ArrayBuffer(cap + 1) } }), null, 'over the cap');
	assert.equal(parseHostMessage({ type: 'assets', jobId: JOB, files: { [path]: 'text' } }), null, 'not a buffer');
	assert.equal(parseHostMessage({ type: 'assets', jobId: JOB, files: [] }), null, 'array');
	assert.equal(parseHostMessage({ type: 'assets', jobId: JOB, files: { __proto__: null, toString: new ArrayBuffer(1) } }), null, 'inherited names');
});

test('error codes are the documented set', () => {
	assert.deepEqual([...ERROR_CODES].sort(), ['cancelled', 'damaged', 'decoder_missing', 'password_required', 'timeout', 'too_large', 'unsupported']);
});
