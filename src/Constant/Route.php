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

namespace CitOmni\PdfViewer\Constant;

/**
 * URL paths of the viewer routes, relative to the app's public root.
 *
 * Behavior:
 * - The Registry builds ROUTES_HTTP from these constants and the PdfViewer service builds
 *   its URLs from the same constants, so routes and URLs cannot drift apart.
 * - Frame:  {PREFIX}/frame/{bundle key}
 * - Assets: {PREFIX}/assets/{bundle key}/{path below assets/}, at most MAX_ASSET_DEPTH
 *   path segments (one regex route per depth; the Router matches one segment per
 *   placeholder).
 *
 * Notes:
 * - The paths are part of the security model: the frame CSP allows scripts, styles,
 *   fetches and images from the bundle's asset path only, and the host page's frame-src
 *   should allow the frame path only. See docs/security.md.
 */
final class Route {

	/** Common prefix of all viewer routes. */
	public const string PREFIX = '/_pdf-viewer';

	/** Frame document route (followed by "/{bundle key}"). */
	public const string FRAME = self::PREFIX . '/frame';

	/** Asset route (followed by "/{bundle key}/{path}"). */
	public const string ASSETS = self::PREFIX . '/assets';

	/** Maximum number of path segments below the asset base (checked by the bundle build). */
	public const int MAX_ASSET_DEPTH = 5;
}
