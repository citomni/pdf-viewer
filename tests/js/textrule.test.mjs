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

// Usable-text rule and geometry helpers of the reader frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessText, itemBox, normaliseBox } from '../../assets/reader/textrule.mjs';

const A4 = 595.28 * 841.89;
const RULE = { minAlnum: 50, minAlnumRatio: 0.6, maxJunkRatio: 0.1 };

test('a text invoice is usable', () => {
	const r = assessText(['Faktura 2026-118', 'CVR-nr. 12 34 56 78', 'I alt DKK 4.646,69', 'Moms 25 % 929,34'], A4, RULE);
	assert.equal(r.usable, true);
	assert.equal(r.minAlnum, 50);
});

test('a scan with only a digital page number needs OCR', () => {
	const r = assessText(['Side 1 af 1'], A4, RULE);
	assert.equal(r.usable, false);
	assert.ok(r.alnum < r.minAlnum);
});

test('a garbled text layer fails the ratio checks', () => {
	const symbols = assessText(['%%%% ## ** !! ' + '/'.repeat(80) + ' abcdefghij'.repeat(5)], A4, RULE);
	assert.equal(symbols.usable, false, 'symbol soup');
	const junk = assessText(['�'.repeat(30) + 'abcdefghij'.repeat(6)], A4, RULE);
	assert.equal(junk.usable, false, 'replacement characters');
	assert.ok(junk.junkRatio > RULE.maxJunkRatio);
});

test('minAlnum scales with the page area but never drops below 20', () => {
	assert.equal(assessText([], A4 / 4, RULE).minAlnum, 20);
	assert.equal(assessText([], A4 * 2, RULE).minAlnum, 100);
	assert.equal(assessText([], 0, RULE).minAlnum, 50);
});

test('letters of any script and digits count as alnum', () => {
	const r = assessText(['請求書 合計金額 12,345 æøå ÆØÅ'], A4, RULE);
	assert.equal(r.alnum, 18);
});

test('normaliseBox clamps to 0..1 and orders the corners', () => {
	assert.deepEqual(normaliseBox([50, 20, 10, 40], 100, 100), [0.1, 0.2, 0.5, 0.4]);
	assert.deepEqual(normaliseBox([-10, -10, 200, 50], 100, 100), [0, 0, 1, 0.5]);
	assert.equal(normaliseBox([0, 0, 1, 1], 0, 100), null);
});

test('itemBox maps an upright text item through the viewport', () => {
	// Viewport at scale 1 for a 600x800 page: y axis flipped.
	const viewport = { width: 600, height: 800, convertToViewportPoint: (x, y) => [x, 800 - y] };
	const box = itemBox({ transform: [10, 0, 0, 10, 60, 700], width: 120, height: 10 }, viewport, 0.8, 0.2);
	assert.deepEqual(box, [0.1, 0.1150, 0.3, 0.1275]);
	assert.equal(itemBox({ transform: [0, 0, 0, 0, 0, 0], width: 1, height: 1 }, viewport, 0.8, 0.2), null, 'degenerate');
});
