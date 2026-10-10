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
 * Reader frame - user interface texts.
 *
 * The frame shows only short status and error texts; the host page owns the rest of the
 * user interface. The language comes from the server configuration (pdf_viewer.language).
 */

const TEXTS = Object.freeze({
	en: Object.freeze({
		title: 'Document',
		loading: 'Loading…',
		previousPage: 'Previous page',
		nextPage: 'Next page',
		zoomOut: 'Zoom out',
		zoomIn: 'Zoom in',
		boxes: 'Boxes',
		embeddedOnly: 'The viewer can only be used embedded in the app.',
		invalidAddress: 'Invalid address.',
		noConnection: 'No valid connection to the app.',
		cancelled: 'Cancelled.',
		pageIncomplete: (code) => 'The page is incomplete (' + code + '). Open the original.',
		error: Object.freeze({
			password_required: 'The document is protected by a password and cannot be shown here. Open the original.',
			too_large: 'The document is too large to be shown here. Open the original.',
			unsupported: 'The document cannot be shown in this browser. Open the original.',
			decoder_missing: 'The document needs a decoder that is not available. Open the original.',
			timeout: 'Processing took too long.',
			damaged: 'The document could not be read. Open the original.',
		}),
	}),
	da: Object.freeze({
		title: 'Dokument',
		loading: 'Indlæser…',
		previousPage: 'Forrige side',
		nextPage: 'Næste side',
		zoomOut: 'Zoom ud',
		zoomIn: 'Zoom ind',
		boxes: 'Bokse',
		embeddedOnly: 'Fremviseren kan kun bruges indlejret i appen.',
		invalidAddress: 'Ugyldig adresse.',
		noConnection: 'Ingen gyldig forbindelse til appen.',
		cancelled: 'Afbrudt.',
		pageIncomplete: (code) => 'Siden er ufuldstændig (' + code + '). Åbn originalen.',
		error: Object.freeze({
			password_required: 'Dokumentet er beskyttet med adgangskode og kan ikke vises her. Åbn originalen.',
			too_large: 'Dokumentet er for stort til at blive vist her. Åbn originalen.',
			unsupported: 'Dokumentet kan ikke vises i denne browser. Åbn originalen.',
			decoder_missing: 'Dokumentet kræver en dekoder, som ikke er tilgængelig. Åbn originalen.',
			timeout: 'Behandlingen tog for lang tid.',
			damaged: 'Dokumentet kunne ikke læses. Åbn originalen.',
		}),
	}),
});

/** Languages with a complete text set. */
export const LANGUAGES = Object.freeze(Object.keys(TEXTS));

/**
 * Text set for a language; English when the language is unknown.
 *
 * @param {string} language  'en' or 'da'.
 * @returns {object}
 */
export function textsFor(language) {
	return Object.hasOwn(TEXTS, language) ? TEXTS[language] : TEXTS.en;
}

/**
 * Error text for an error code; the generic "could not be read" text for unknown codes.
 *
 * @param {object} texts  Result of textsFor().
 * @param {string} code
 * @returns {string}
 */
export function errorText(texts, code) {
	return Object.hasOwn(texts.error, code) ? texts.error[code] : texts.error.damaged;
}
