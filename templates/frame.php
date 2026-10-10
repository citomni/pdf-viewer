<?php
declare(strict_types=1);
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
 * Reader frame document, rendered by FrameController::frame().
 *
 * Notes:
 * - Part of the bundle key (tools/build-bundle.php): any change here changes the asset URLs.
 * - No inline code and no inline styles: the configuration is passed as JSON in a <meta>
 *   element, so the frame CSP needs no nonce and the response is the same for every
 *   request of a bundle under the same configuration.
 * - Stylesheets are loaded with crossorigin="anonymous": CORS requests without cookies,
 *   independent of a Cross-Origin-Resource-Policy header on the asset responses.
 * - The visible texts are set by reader/i18n.mjs.
 *
 * @var string $lang       Document language ('en' or 'da').
 * @var string $assetBase  Absolute asset base URL of the bundle (ends with "/").
 * @var string $config     Reader configuration (JSON).
 */

$e = static fn(string $s): string => \htmlspecialchars($s, \ENT_QUOTES | \ENT_SUBSTITUTE | \ENT_HTML5, 'UTF-8');

?><!doctype html>
<html lang="<?= $e($lang) ?>">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="pdf-viewer-config" content="<?= $e($config) ?>">
<title></title>
<link rel="stylesheet" crossorigin="anonymous" href="<?= $e($assetBase) ?>vendor/pdfjs/web/pdf_viewer.css">
<link rel="stylesheet" crossorigin="anonymous" href="<?= $e($assetBase) ?>reader/reader.css">
<script type="module" src="<?= $e($assetBase) ?>reader/reader.mjs"></script>
</head>
<body>
<div id="toolbar" hidden>
	<button type="button" id="btnPrev">&#8249;</button>
	<span id="pageInfo">&ndash;</span>
	<button type="button" id="btnNext">&#8250;</button>
	<button type="button" id="btnZoomOut">&minus;</button>
	<button type="button" id="btnZoomIn">+</button>
	<label><input type="checkbox" id="chkBoxes" checked> <span id="lblBoxes"></span></label>
	<span id="status" role="status"></span>
</div>
<div id="viewerContainer" hidden><div id="viewer" class="pdfViewer"></div></div>
<div id="imageContainer" hidden><div id="imagePage" class="imagePage"><img id="imageEl" alt=""><div class="boxLayer"></div></div></div>
<div id="message" class="message"></div>
</body>
</html>
