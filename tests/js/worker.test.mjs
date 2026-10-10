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

// PDF.js worker build shape: the vendored pdf.worker.min.mjs must convert to a classic
// worker script (compat.mjs, toClassicWorkerScript). This is the first test to fail when a
// PDF.js update changes the worker's module constructs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { toClassicWorkerScript } from '../../assets/reader/compat.mjs';

const worker = readFileSync(new URL('../../assets/vendor/pdfjs/build/pdf.worker.min.mjs', import.meta.url), 'utf8');
const count = (code, re) => (code.match(re) || []).length;

test('the vendored PDF.js worker converts to a script that compiles as a classic script', () => {
	assert.throws(() => new Script(worker), SyntaxError, 'the original is a module');
	const classic = toClassicWorkerScript(worker);
	new Script(classic, { filename: 'pdf.worker.classic.js' });
	assert.equal(count(classic, /import\.meta/g), 0);
	assert.equal(count(classic, /export\s*\{\s*WorkerMessageHandler\s*\}/g), 0);
	assert.equal(count(classic, /self\.location\.href/g), count(worker, /self\.location\.href/g) + count(worker, /import\.meta\.url/g));
	assert.ok(classic.includes('WorkerMessageHandler'), 'the handler itself stays');
});

test('other worker shapes are refused instead of guessed', () => {
	const ok = 'const a=1;export{WorkerMessageHandler};';
	assert.equal(toClassicWorkerScript(ok), 'const a=1;');
	assert.equal(toClassicWorkerScript('var u=import.meta.url;' + ok), 'var u=self.location.href;const a=1;');
	const refused = (code, label) => assert.throws(() => toClassicWorkerScript(code), (e) => e.code === 'unsupported', label);
	refused('const a=1;', 'no export');
	refused(ok + 'export{WorkerMessageHandler};', 'two exports');
	refused(ok + 'export default 1;', 'export default');
	refused(ok + 'export const b=2;', 'export const');
	refused(ok + 'import.meta.resolve("x");', 'import.meta.resolve');
	refused(ok + 'import.meta.url;'.repeat(5), 'more than four import.meta.url');
});
