#!/usr/bin/env bash
#
# This file is part of the CitOmni framework.
# Low overhead, high performance, ready for anything.
#
# For more information, visit https://github.com/citomni
#
# Copyright (c) 2012-present Lars Grove Mortensen
# SPDX-License-Identifier: MIT
#
# For full copyright, trademark, and license information,
# please see the LICENSE file distributed with this source code.
#
# Rebuild assets/vendor/ from the pinned npm releases of PDF.js and Tesseract.js.
#
# Behavior:
# - Downloads the five pinned tarballs with `npm pack` (registry.npmjs.org), or takes them
#   from VENDOR_TGZ_DIR when that is set (offline rebuild from a verified cache).
# - Verifies every tarball against the SHA-256 pinned below before anything is extracted.
# - Replaces assets/vendor/ with the runtime files the reader uses and nothing else.
# - Afterwards run: php tools/build-bundle.php
#
# Selection (see docs/maintenance.md for the reasons):
# - pdfjs-dist: the legacy build only (build/pdf.min.mjs, build/pdf.worker.min.mjs,
#   web/pdf_viewer.mjs), web/pdf_viewer.css + web/images/, wasm/{openjpeg,jbig2,qcms_bg}.wasm,
#   wasm/openjpeg_nowasm_fallback.js, cmaps/, standard_fonts/, iccs/ and all license files.
#   Left out: the modern build, wasm/quickjs-eval.* (PDF scripting), pdf.sandbox*,
#   wasm/jbig2_nowasm_fallback.js, source maps, image_decoders/ and types/.
# - tesseract.js: dist/tesseract.esm.min.js and dist/worker.min.js (+ license files).
# - tesseract.js-core: the three LSTM-only single-file cores (plain, SIMD, relaxed SIMD).
# - Language data: dan and eng, variant 4.0.0_best_int.
#
# Usage:
#   bash tools/vendor-sync.sh
#   VENDOR_TGZ_DIR=/path/to/tarballs bash tools/vendor-sync.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/assets/vendor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pinned tarballs: sha256 of the .tgz as served by registry.npmjs.org.
declare -A PIN=(
	[pdfjs-dist-6.4.299.tgz]=86269b40170eb41740ea05ad2102d71d33de4f122b34eb2f478be0ea7779c415
	[tesseract.js-7.0.0.tgz]=9a93bf51c3387f945d10a24bf8b3a4bf2e45c7c7161b8242aafbaf9d3c4b606a
	[tesseract.js-core-7.0.0.tgz]=ba584355515eaff877552022853c0e71f2cb70466e759d1d6940484929718ee0
	[tesseract.js-data-dan-1.0.0.tgz]=2b29e1c31afa7607940ea7cc933092fe6299ae4697d05b9446b95507c6bee4c5
	[tesseract.js-data-eng-1.0.0.tgz]=c9bddf2e2f0a214ac7918f3f4a3caf45e09ce8674fe26662ae7787ac8927f7bb
)

# -- 1. Fetch and verify the tarballs -------------------------------------------------

cd "$WORK"
if [[ -n "${VENDOR_TGZ_DIR:-}" ]]; then
	for f in "${!PIN[@]}"; do
		cp "$VENDOR_TGZ_DIR/$f" "$WORK/$f"
	done
else
	npm pack --silent \
		pdfjs-dist@6.4.299 \
		tesseract.js@7.0.0 \
		tesseract.js-core@7.0.0 \
		@tesseract.js-data/dan@1.0.0 \
		@tesseract.js-data/eng@1.0.0 >/dev/null
fi

for f in "${!PIN[@]}"; do
	echo "${PIN[$f]}  $f" | sha256sum -c --quiet -
done
echo "Tarball checksums OK"

for f in "${!PIN[@]}"; do
	d="x-${f%.tgz}"
	mkdir -p "$d"
	tar xzf "$f" -C "$d"
done

P="$WORK/x-pdfjs-dist-6.4.299/package"
T="$WORK/x-tesseract.js-7.0.0/package"
C="$WORK/x-tesseract.js-core-7.0.0/package"
DAN="$WORK/x-tesseract.js-data-dan-1.0.0/package"
ENG="$WORK/x-tesseract.js-data-eng-1.0.0/package"

# The viewer CSS and its images are taken from web/; they must equal the legacy copies.
cmp -s "$P/legacy/web/pdf_viewer.css" "$P/web/pdf_viewer.css"
diff -rq "$P/legacy/web/images" "$P/web/images" >/dev/null

rm -rf "$VENDOR"
mkdir -p "$VENDOR"/pdfjs/{build,web,wasm,cmaps,standard_fonts,iccs} \
	"$VENDOR/tesseract" "$VENDOR/tesseract-core" "$VENDOR/tessdata"

# -- 2. PDF.js 6.4.299 (legacy build) -------------------------------------------------

cp "$P/LICENSE" "$VENDOR/pdfjs/LICENSE"
cp "$P/legacy/build/pdf.min.mjs" "$P/legacy/build/pdf.worker.min.mjs" "$VENDOR/pdfjs/build/"
cp "$P/legacy/web/pdf_viewer.mjs" "$VENDOR/pdfjs/web/"
cp "$P/web/pdf_viewer.css" "$VENDOR/pdfjs/web/"
cp -r "$P/web/images" "$VENDOR/pdfjs/web/images"
cp "$P/wasm/openjpeg.wasm" "$P/wasm/jbig2.wasm" "$P/wasm/qcms_bg.wasm" "$VENDOR/pdfjs/wasm/"
cp "$P/wasm/openjpeg_nowasm_fallback.js" "$VENDOR/pdfjs/wasm/"
cp "$P"/wasm/LICENSE_* "$VENDOR/pdfjs/wasm/"
cp "$P"/cmaps/* "$VENDOR/pdfjs/cmaps/"
cp "$P"/standard_fonts/* "$VENDOR/pdfjs/standard_fonts/"
cp "$P"/iccs/* "$VENDOR/pdfjs/iccs/"

# -- 3. Tesseract.js 7.0.0 ------------------------------------------------------------

cp "$T/dist/tesseract.esm.min.js" "$T/dist/worker.min.js" "$VENDOR/tesseract/"
cp "$T/dist/worker.min.js.LICENSE.txt" "$T/dist/tesseract.min.js.LICENSE.txt" "$VENDOR/tesseract/"
cp "$T/LICENSE.md" "$VENDOR/tesseract/LICENSE.md"

# -- 4. tesseract.js-core 7.0.0 (LSTM-only single-file builds) ------------------------

cp "$C/tesseract-core-lstm.wasm.js" \
	"$C/tesseract-core-simd-lstm.wasm.js" \
	"$C/tesseract-core-relaxedsimd-lstm.wasm.js" \
	"$C/LICENSE" "$VENDOR/tesseract-core/"

# -- 5. Language data: @tesseract.js-data/{dan,eng}@1.0.0, variant 4.0.0_best_int ------

cp "$DAN/4.0.0_best_int/dan.traineddata.gz" "$VENDOR/tessdata/"
cp "$ENG/4.0.0_best_int/eng.traineddata.gz" "$VENDOR/tessdata/"
cat > "$VENDOR/tessdata/NOTICE.txt" <<'EOF'
dan.traineddata.gz and eng.traineddata.gz are taken unmodified from the npm packages
@tesseract.js-data/dan@1.0.0 and @tesseract.js-data/eng@1.0.0, folder 4.0.0_best_int
(Tesseract.js' default LSTM data). The npm packages are published under the MIT license;
the models originate from tesseract-ocr/tessdata_best (Apache License 2.0), converted
to integer precision.
EOF

echo "Vendor files copied to $VENDOR"
echo "Next: php tools/build-bundle.php"
