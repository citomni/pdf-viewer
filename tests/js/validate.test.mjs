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

// Host side validation of everything the (untrusted) frame sends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFrameMessage } from '../../assets/host/validate.mjs';

const JOB = 'job-12345678';
const LIMITS = { maxPages: 10, maxTextItemsPerPage: 3, maxItemTextLength: 20 };
const item = (over = {}) => ({ page: 1, text: 'I alt', source: 'text', granularity: 'item', box: [0.1, 0.2, 0.3, 0.4], ...over });
const page = (over = {}) => ({ page: 1, examined: true, ocr: 'not_needed', items: [item()], rule: null, ocrMeta: null, ...over });

test('messages for another job or of an unknown type are rejected', () => {
	assert.equal(validateFrameMessage({ type: 'progress', jobId: 'other-123', stage: 'idle' }, JOB, LIMITS), null);
	assert.equal(validateFrameMessage({ type: 'navigate', jobId: JOB, url: '/' }, JOB, LIMITS), null);
	assert.equal(validateFrameMessage(null, JOB, LIMITS), null);
});

test('progress: known stages and typed fields only', () => {
	assert.deepEqual(validateFrameMessage({ type: 'progress', jobId: JOB, stage: 'loaded', numPages: 3, kind: 'pdf' }, JOB, LIMITS), { type: 'progress', jobId: JOB, stage: 'loaded', numPages: 3, kind: 'pdf' });
	assert.equal(validateFrameMessage({ type: 'progress', jobId: JOB, stage: 'hack' }, JOB, LIMITS), null);
	assert.equal(validateFrameMessage({ type: 'progress', jobId: JOB, stage: 'view', page: 11 }, JOB, LIMITS), null, 'page over maxPages');
	assert.equal(validateFrameMessage({ type: 'progress', jobId: JOB, stage: 'ocr', ocrProgress: 2 }, JOB, LIMITS), null);
	assert.equal(validateFrameMessage({ type: 'progress', jobId: JOB, stage: 'idle', timings: { a: 'x' } }, JOB, LIMITS), null);
	const diag = validateFrameMessage({ type: 'progress', jobId: JOB, stage: 'diag', events: [{ kind: 'csp', blocked: 'x'.repeat(900) }], dropped: 0 }, JOB, LIMITS);
	assert.equal(diag.events[0].blocked.length, 500, 'strings are truncated');
	assert.equal(validateFrameMessage({ type: 'progress', jobId: JOB, stage: 'diag', events: [{ nested: { a: 1 } }] }, JOB, LIMITS), null, 'nested objects');
});

test('text: pages, items and boxes are validated', () => {
	const ok = validateFrameMessage({ type: 'text', jobId: JOB, pages: [page()] }, JOB, LIMITS);
	assert.equal(ok.pages[0].items[0].text, 'I alt');
	const bad = (p, label) => assert.equal(validateFrameMessage({ type: 'text', jobId: JOB, pages: [p] }, JOB, LIMITS), null, label);
	bad(page({ ocr: 'maybe' }), 'ocr state');
	bad(page({ items: [item({ box: [0.5, 0.2, 0.3, 0.4] })] }), 'x0 > x1');
	bad(page({ items: [item({ box: [0, 0, 1.2, 1] })] }), 'box outside 0..1');
	bad(page({ items: [item({ text: 'x'.repeat(21) })] }), 'text too long');
	bad(page({ items: [item(), item(), item(), item()] }), 'too many items');
	bad(page({ items: [item({ page: 2 })] }), 'item on another page');
	bad(page({ items: [item({ source: 'ocr' })] }), 'ocr item without confidence');
	bad(page({ items: [item({ confidence: 50 })] }), 'text item with confidence');
	bad(page({ page: 11 }), 'page over maxPages');
	assert.equal(validateFrameMessage({ type: 'text', jobId: JOB, pages: [page(), page()] }, JOB, LIMITS), null, 'duplicate page');
	assert.ok(validateFrameMessage({ type: 'text', jobId: JOB, pages: [page({ ocr: 'done', items: [item({ source: 'ocr', granularity: 'word', confidence: 91.5 })] })] }, JOB, LIMITS));
});

test('error: known codes, optional page and bounded detail', () => {
	assert.deepEqual(validateFrameMessage({ type: 'error', jobId: JOB, code: 'decoder_missing', page: 1, detail: 'jpx' }, JOB, LIMITS), { type: 'error', jobId: JOB, code: 'decoder_missing', page: 1, detail: 'jpx' });
	assert.equal(validateFrameMessage({ type: 'error', jobId: JOB, code: 'other' }, JOB, LIMITS), null);
	assert.equal(validateFrameMessage({ type: 'error', jobId: JOB, code: 'damaged', detail: 'x'.repeat(301) }, JOB, LIMITS), null);
});
