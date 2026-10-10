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
 * Reader frame - compatibility adaptations for the libraries. Nothing runs on import.
 *
 * - installReadableStreamIteration(): a shim, installed only when the engine lacks the
 *   feature, in the frame's own realm (the frame is a sandboxed opaque origin, so nothing
 *   outside the reader is affected). The reader reports the result as a 'compat'
 *   diagnostics event.
 * - toClassicWorkerScript(): turns the PDF.js module worker into a classic worker script.
 *
 * Both depend on the PDF.js build. tests/js/compat.test.mjs and tests/js/worker.test.mjs
 * check them; the latter runs toClassicWorkerScript() on the vendored worker file.
 */

/**
 * Install async iteration of ReadableStream (values() and [Symbol.asyncIterator]).
 *
 * PDF.js 6.4.299 iterates ReadableStreams with "for await" in PDFPageProxy.getTextContent()
 * and in callers of it (the viewer's find and "select all" copy). Safari before 27 has no
 * ReadableStream async iteration, so every getTextContent() call throws "undefined is not
 * a function (near '...t of e...')" there (seen on iOS Safari 26.6.1). The legacy build
 * does not polyfill it (upstream pdf.js issue #21557).
 *
 * Behavior (Streams Standard, ReadableStream async iterator):
 * - values({preventCancel}) locks the stream with a default reader.
 * - next() reads one chunk; at the end, or on an error, the lock is released.
 * - return(value) cancels the stream unless preventCancel, then releases the lock.
 * - Calls to next()/return() run one after the other.
 *
 * Notes:
 * - The PDF.js worker has one more "for await" (asyncGetBytesFromDecompressionStream). It
 *   catches the error and falls back to synchronous decoding, so the worker is left as is.
 *
 * @return {boolean} true if the shim was installed.
 */
export function installReadableStreamIteration() {
	const proto = globalThis.ReadableStream?.prototype;
	if (!proto || typeof proto[Symbol.asyncIterator] === 'function') {
		return false;
	}
	// %AsyncIteratorPrototype%: gives the iterator [Symbol.asyncIterator]() { return this }.
	const asyncIteratorProto = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}).prototype);
	function values({ preventCancel = false } = {}) {
		const reader = this.getReader();
		let finished = false;
		let queue = Promise.resolve();
		const step = async () => {
			if (finished) {
				return { value: undefined, done: true };
			}
			let result;
			try {
				result = await reader.read();
			} catch (e) {
				finished = true;
				reader.releaseLock();
				throw e;
			}
			if (result.done) {
				finished = true;
				reader.releaseLock();
			}
			return result;
		};
		const finish = async (value) => {
			if (!finished) {
				finished = true;
				if (preventCancel) {
					reader.releaseLock();
				} else {
					const cancelled = reader.cancel(value);
					reader.releaseLock();
					await cancelled;
				}
			}
			return { value, done: true };
		};
		const iterator = Object.create(asyncIteratorProto);
		iterator.next = () => (queue = queue.then(step, step));
		iterator.return = (value) => (queue = queue.then(() => finish(value), () => finish(value)));
		return iterator;
	}
	Object.defineProperty(proto, 'values', { value: values, writable: true, configurable: true });
	Object.defineProperty(proto, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
	return true;
}

/**
 * Turn pdf.worker.min.mjs into a classic worker script.
 *
 * A module worker created from a blob: URL does not start in an opaque origin (verified in
 * Chromium 141: the worker fires 'error'; the same code works as a classic blob worker), so
 * the reader runs the PDF.js worker as a classic worker. The worker build has exactly one
 * module-only construct per kind: the final "export{WorkerMessageHandler};" and two
 * "import.meta.url" reads in the Emscripten glue (only used to compute a base URL inside a
 * try/catch). Anything else unexpected makes this function throw instead of guessing.
 *
 * @param {string} code
 * @returns {string}
 * @throws {Error}  code 'unsupported': the build has another shape.
 */
export function toClassicWorkerScript(code) {
	const exportRe = /export\s*\{\s*WorkerMessageHandler\s*\}\s*;?/g;
	const exportCount = (code.match(exportRe) || []).length;
	const metaUrlCount = (code.match(/import\.meta\.url/g) || []).length;
	const otherMeta = /import\.meta(?!\.url)/.test(code);
	const otherExport = /(^|[;}\s])export\s*(\{|default|const|let|var|function|class)/.test(code.replace(exportRe, ''));
	if (exportCount !== 1 || metaUrlCount > 4 || otherMeta || otherExport) {
		throw Object.assign(new Error('unexpected worker build shape'), { code: 'unsupported' });
	}
	return code.replace(exportRe, '').replace(/import\.meta\.url/g, 'self.location.href');
}
