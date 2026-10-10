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

// ReadableStream async iteration shim (Safari < 27), run against Node's streams with the
// native implementation removed.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installReadableStreamIteration } from '../../assets/reader/compat.mjs';

const stream = (chunks, onCancel = () => {}) => new ReadableStream({
	start(controller) {
		for (const c of chunks) {
			controller.enqueue(c);
		}
		controller.close();
	},
	cancel: onCancel,
});

before(() => {
	assert.equal(installReadableStreamIteration(), false, 'native iteration is kept');
	delete ReadableStream.prototype[Symbol.asyncIterator];
	delete ReadableStream.prototype.values;
	assert.equal(installReadableStreamIteration(), true, 'shim installed when missing');
});

test('for await reads every chunk and releases the lock', async () => {
	const s = stream(['a', 'b', 'c']);
	const seen = [];
	for await (const c of s) {
		seen.push(c);
	}
	assert.deepEqual(seen, ['a', 'b', 'c']);
	assert.equal(s.locked, false);
});

test('breaking out of the loop cancels the stream', async () => {
	let cancelled = false;
	const s = new ReadableStream({
		pull(controller) {
			controller.enqueue('x');
		},
		cancel() {
			cancelled = true;
		},
	});
	for await (const c of s) {
		assert.equal(c, 'x');
		break;
	}
	assert.equal(cancelled, true);
	assert.equal(s.locked, false);
});

test('values({preventCancel: true}) leaves the stream readable after break', async () => {
	const s = stream(['a', 'b']);
	for await (const c of s.values({ preventCancel: true })) {
		assert.equal(c, 'a');
		break;
	}
	assert.equal(s.locked, false);
	const reader = s.getReader();
	assert.deepEqual(await reader.read(), { value: 'b', done: false });
});

test('an erroring stream rejects and releases the lock', async () => {
	const s = new ReadableStream({
		pull(controller) {
			controller.error(new Error('boom'));
		},
	});
	await assert.rejects(async () => {
		for await (const c of s) {
			assert.fail('no chunk expected: ' + c);
		}
	}, /boom/);
	assert.equal(s.locked, false);
});

test('next() calls run one after the other', async () => {
	const it = stream([1, 2, 3])[Symbol.asyncIterator]();
	const results = await Promise.all([it.next(), it.next(), it.next(), it.next()]);
	assert.deepEqual(results.map((r) => r.value), [1, 2, 3, undefined]);
	assert.deepEqual(results.map((r) => r.done), [false, false, false, true]);
	assert.equal(it[Symbol.asyncIterator](), it, 'the iterator is async iterable');
});
