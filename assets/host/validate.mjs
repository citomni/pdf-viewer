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
 * Host side - validation of everything the reader frame sends.
 *
 * The frame is treated as untrusted: only known message types and known fields are
 * accepted, numbers must be finite, strings and arrays are length-limited, boxes must lie
 * in 0..1 with x0 <= x1 and y0 <= y1. Returns a sanitised copy or null.
 */

export const ERROR_CODES = ['password_required', 'unsupported', 'damaged', 'too_large', 'decoder_missing', 'timeout', 'cancelled'];
const OCR_STATES = ['not_needed', 'done', 'skipped', 'failed'];
const SOURCES = ['text', 'ocr'];
const GRANULARITIES = ['item', 'word', 'line'];
const STAGES = ['received', 'loaded', 'rendered', 'examining', 'ocr', 'busy', 'idle', 'view', 'diag'];
const KINDS = ['pdf', 'image'];
const PHASES = ['start', 'done'];
const MAX_STRING = 500;
const MAX_DIAG_EVENTS = 400;
const MAX_TOTAL_TEXT = 8 * 1024 * 1024;

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

/**
 * Validate one message from the frame.
 *
 * @param {unknown} data
 * @param {string} jobId  Current job id; messages for any other job are rejected.
 * @param {object} limits  Reader limits (maxPages, maxTextItemsPerPage, maxItemTextLength).
 * @returns {object|null}
 */
export function validateFrameMessage(data, jobId, limits) {
	if (data === null || typeof data !== 'object' || data.jobId !== jobId) {
		return null;
	}
	switch (data.type) {
		case 'progress':
			return validateProgress(data, jobId, limits);
		case 'text':
			return validateText(data, jobId, limits);
		case 'error':
			return validateError(data, jobId, limits);
		default:
			return null;
	}
}

function validateProgress(d, jobId, limits) {
	if (!STAGES.includes(d.stage)) {
		return null;
	}
	const out = { type: 'progress', jobId, stage: d.stage };
	const ints = { page: [1, limits.maxPages], numPages: [0, 1e7], bytes: [0, 1e10], words: [0, 1e6], dropped: [0, 1e7] };
	for (const [k, [min, max]] of Object.entries(ints)) {
		if (k in d) {
			if (!isInt(d[k], min, max)) {
				return null;
			}
			out[k] = d[k];
		}
	}
	for (const k of ['ms', 'renderMs']) {
		if (k in d) {
			if (!isNum(d[k]) || d[k] < 0) {
				return null;
			}
			out[k] = d[k];
		}
	}
	if ('kind' in d) {
		if (!KINDS.includes(d.kind)) {
			return null;
		}
		out.kind = d.kind;
	}
	if ('phase' in d) {
		if (!PHASES.includes(d.phase)) {
			return null;
		}
		out.phase = d.phase;
	}
	if ('ocrStatus' in d) {
		if (!isStr(d.ocrStatus, 60)) {
			return null;
		}
		out.ocrStatus = d.ocrStatus;
	}
	if ('ocrProgress' in d) {
		if (d.ocrProgress !== null && !(isNum(d.ocrProgress) && d.ocrProgress >= 0 && d.ocrProgress <= 1)) {
			return null;
		}
		out.ocrProgress = d.ocrProgress;
	}
	for (const k of ['timings', 'ocrTimings']) {
		if (k in d && d[k] !== null) {
			const t = numberMap(d[k], 60);
			if (t === undefined) {
				return null;
			}
			out[k] = t;
		}
	}
	if ('events' in d) {
		if (!Array.isArray(d.events) || d.events.length > MAX_DIAG_EVENTS) {
			return null;
		}
		const events = [];
		for (const ev of d.events) {
			const flat = flatObject(ev, 20);
			if (flat === undefined) {
				return null;
			}
			events.push(flat);
		}
		out.events = events;
	}
	return out;
}

function validateText(d, jobId, limits) {
	if (!Array.isArray(d.pages) || d.pages.length < 1 || d.pages.length > limits.maxPages) {
		return null;
	}
	let totalText = 0;
	const pages = [];
	const seen = new Set();
	for (const p of d.pages) {
		if (p === null || typeof p !== 'object' || !isInt(p.page, 1, limits.maxPages) || seen.has(p.page)) {
			return null;
		}
		seen.add(p.page);
		if (typeof p.examined !== 'boolean' || !OCR_STATES.includes(p.ocr) || !Array.isArray(p.items) || p.items.length > limits.maxTextItemsPerPage) {
			return null;
		}
		const items = [];
		for (const it of p.items) {
			const v = validateItem(it, p.page, limits);
			if (!v) {
				return null;
			}
			totalText += v.text.length;
			if (totalText > MAX_TOTAL_TEXT) {
				return null;
			}
			items.push(v);
		}
		const page = { page: p.page, examined: p.examined, ocr: p.ocr, items };
		if (p.rule !== null && p.rule !== undefined) {
			const rule = flatObject(p.rule, 12);
			if (rule === undefined) {
				return null;
			}
			page.rule = rule;
		}
		if (p.ocrMeta !== null && p.ocrMeta !== undefined) {
			const meta = numberMap(p.ocrMeta, 12, true);
			if (meta === undefined) {
				return null;
			}
			page.ocrMeta = meta;
		}
		pages.push(page);
	}
	return { type: 'text', jobId, pages };
}

function validateItem(it, pageNo, limits) {
	if (it === null || typeof it !== 'object') {
		return null;
	}
	if (it.page !== pageNo || !isStr(it.text, limits.maxItemTextLength) || !SOURCES.includes(it.source) || !GRANULARITIES.includes(it.granularity)) {
		return null;
	}
	const b = it.box;
	if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => isNum(v) && v >= 0 && v <= 1) || b[0] > b[2] || b[1] > b[3]) {
		return null;
	}
	const out = { page: pageNo, text: it.text, source: it.source, granularity: it.granularity, box: [b[0], b[1], b[2], b[3]] };
	if (it.source === 'ocr') {
		if (!isNum(it.confidence) || it.confidence < 0 || it.confidence > 100) {
			return null;
		}
		out.confidence = it.confidence;
	} else if ('confidence' in it) {
		return null;
	}
	return out;
}

function validateError(d, jobId, limits) {
	if (!ERROR_CODES.includes(d.code)) {
		return null;
	}
	const out = { type: 'error', jobId, code: d.code };
	if ('page' in d) {
		if (!isInt(d.page, 1, limits.maxPages)) {
			return null;
		}
		out.page = d.page;
	}
	if ('detail' in d) {
		if (!isStr(d.detail, 300)) {
			return null;
		}
		out.detail = d.detail;
	}
	return out;
}

/** Object with string keys and finite-number (or null) values. undefined = invalid. */
function numberMap(v, maxKeys, allowNull = false) {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) {
		return undefined;
	}
	const keys = Object.keys(v);
	if (keys.length > maxKeys) {
		return undefined;
	}
	const out = {};
	for (const k of keys) {
		if (!isStr(k, 40)) {
			return undefined;
		}
		const x = v[k];
		if (x === null && allowNull) {
			out[k] = null;
		} else if (isNum(x)) {
			out[k] = x;
		} else {
			return undefined;
		}
	}
	return out;
}

/** Flat object whose values are bounded strings, finite numbers, booleans or null. */
function flatObject(v, maxKeys) {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) {
		return undefined;
	}
	const keys = Object.keys(v);
	if (keys.length > maxKeys) {
		return undefined;
	}
	const out = {};
	for (const k of keys) {
		if (!isStr(k, 40)) {
			return undefined;
		}
		const x = v[k];
		if (x === null || typeof x === 'boolean' || isNum(x)) {
			out[k] = x;
		} else if (typeof x === 'string') {
			out[k] = x.slice(0, MAX_STRING);
		} else {
			return undefined;
		}
	}
	return out;
}
