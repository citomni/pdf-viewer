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
 * Filesystem locations inside the package.
 *
 * Notes:
 * - Paths are relative to this file, so they follow the package wherever Composer installs it.
 * - FRAME_TEMPLATE_ID is the name under which the frame template enters the version list
 *   (and thereby the bundle key).
 */
final class PackagePath {

	/** Directory whose files the asset route serves (only those listed in Bundle::FILES). */
	public const string ASSET_DIR = __DIR__ . '/../../assets';

	/** Frame document template. */
	public const string FRAME_TEMPLATE = __DIR__ . '/../../templates/frame.php';

	/** Version list name of the frame template. */
	public const string FRAME_TEMPLATE_ID = 'templates/frame.php';

	/** Generated manifest class (written by tools/build-bundle.php). */
	public const string BUNDLE_CLASS_FILE = __DIR__ . '/Bundle.php';
}
