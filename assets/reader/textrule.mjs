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
 * Reader frame - usable-text rule and geometry helpers (pure functions).
 */

const A4_AREA_PT2 = 595.28 * 841.89;

const RE_SPACE = /\s/u;
const RE_LETTER = /\p{L}/u;
const RE_DIGIT = /\p{Nd}/u;
// Replacement character, private use, control, unassigned and lone surrogates.
const RE_JUNK = /[�\p{Co}\p{Cc}\p{Cn}\p{Cs}]/u;

/**
 * Decide whether a page's text layer is usable (i.e. OCR is not needed).
 *
 * Rule (documented in the test report):
 *   usable = alnum >= minAlnum(page)
 *            AND alnum / nonSpace >= minAlnumRatio
 *            AND junk / nonSpace <= maxJunkRatio
 *   where minAlnum(page) = max(20, round(minAlnum * pageArea / A4 area)).
 *
 * - alnum counts letters (any script) and decimal digits; nonSpace counts all
 *   non-whitespace characters; junk counts U+FFFD, private-use, control, unassigned
 *   and surrogate code points.
 * - A digital page number or a heading on top of a scan stays below minAlnum, so OCR runs.
 * - A garbled layer (symbol soup or replacement characters) fails the ratio checks.
 * - Not detected: a layer with plausible letters but wrong content. The user can still
 *   run OCR manually on the page.
 *
 * @param {string[]} strings  Text item strings of the page.
 * @param {number} pageAreaPt2  Page area in PDF points squared (unrotated view box).
 * @param {{minAlnum: number, minAlnumRatio: number, maxJunkRatio: number}} rule
 * @returns {{usable: boolean, alnum: number, nonSpace: number, junk: number,
 *   alnumRatio: number, junkRatio: number, minAlnum: number}}
 */
export function assessText(strings, pageAreaPt2, rule) {
	let alnum = 0;
	let nonSpace = 0;
	let junk = 0;
	for (const s of strings) {
		for (const ch of s) {
			if (RE_SPACE.test(ch)) {
				continue;
			}
			nonSpace++;
			if (RE_LETTER.test(ch) || RE_DIGIT.test(ch)) {
				alnum++;
			} else if (RE_JUNK.test(ch)) {
				junk++;
			}
		}
	}
	const minAlnum = Math.max(20, Math.round(rule.minAlnum * (pageAreaPt2 > 0 ? pageAreaPt2 / A4_AREA_PT2 : 1)));
	const alnumRatio = nonSpace ? alnum / nonSpace : 0;
	const junkRatio = nonSpace ? junk / nonSpace : 0;
	return {
		usable: alnum >= minAlnum && alnumRatio >= rule.minAlnumRatio && junkRatio <= rule.maxJunkRatio,
		alnum,
		nonSpace,
		junk,
		alnumRatio: round3(alnumRatio),
		junkRatio: round3(junkRatio),
		minAlnum,
	};
}

/**
 * Box of a PDF.js text item in normalised coordinates of the page as displayed.
 *
 * The item's rectangle (baseline start, advance width along the baseline, ascent/descent
 * along the "up" vector of the text matrix) is mapped through the viewport (which applies
 * the page's /Rotate) and normalised to 0..1 with origin top-left.
 *
 * @param {{transform: number[], width: number, height: number}} item
 * @param {{width: number, height: number, convertToViewportPoint: Function}} viewport  scale 1
 * @param {number} ascent   Font ascent as a fraction of the font size (positive).
 * @param {number} descent  Font descent as a fraction of the font size (positive).
 * @returns {number[]|null}  [x0, y0, x1, y1] or null if degenerate.
 */
export function itemBox(item, viewport, ascent, descent) {
	const [a, b, c, d, e, f] = item.transform;
	const lenAB = Math.hypot(a, b);
	const lenCD = Math.hypot(c, d);
	if (!(lenAB > 0) || !(lenCD > 0)) {
		return null;
	}
	const ux = a / lenAB;
	const uy = b / lenAB;
	const vx = c / lenCD;
	const vy = d / lenCD;
	const h = lenCD;
	const w = item.width;
	const corners = [
		[e - vx * h * descent, f - vy * h * descent],
		[e + ux * w - vx * h * descent, f + uy * w - vy * h * descent],
		[e + vx * h * ascent, f + vy * h * ascent],
		[e + ux * w + vx * h * ascent, f + uy * w + vy * h * ascent],
	];
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const [x, y] of corners) {
		const [px, py] = viewport.convertToViewportPoint(x, y);
		x0 = Math.min(x0, px);
		y0 = Math.min(y0, py);
		x1 = Math.max(x1, px);
		y1 = Math.max(y1, py);
	}
	return normaliseBox([x0, y0, x1, y1], viewport.width, viewport.height);
}

/**
 * Normalise a pixel box to 0..1 (clamped, rounded to 5 decimals).
 *
 * @returns {number[]|null}
 */
export function normaliseBox([x0, y0, x1, y1], width, height) {
	if (!(width > 0) || !(height > 0)) {
		return null;
	}
	const nx0 = clamp01(x0 / width);
	const ny0 = clamp01(y0 / height);
	const nx1 = clamp01(x1 / width);
	const ny1 = clamp01(y1 / height);
	if (![nx0, ny0, nx1, ny1].every(Number.isFinite)) {
		return null;
	}
	return [round5(Math.min(nx0, nx1)), round5(Math.min(ny0, ny1)), round5(Math.max(nx0, nx1)), round5(Math.max(ny0, ny1))];
}

function clamp01(v) {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round3(v) {
	return Math.round(v * 1000) / 1000;
}

function round5(v) {
	return Math.round(v * 100000) / 100000;
}
