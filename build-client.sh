#!/usr/bin/env bash
set -euo pipefail

# Usage: ./build-client.sh <source-dir> <build-service-url> [outDir] [buildCmd]
#
# Zips the source directory, POSTs it to the build service, and extracts the
# returned portals.zip into ./dist-output/.

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <source-dir> <build-service-url> [outDir] [buildCmd]" >&2
  exit 1
fi

SOURCE_DIR="$1"
SERVICE_URL="${2%/}"
OUT_DIR="${3:-portals}"
BUILD_CMD="${4:-pnpm install && pnpm build}"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Error: source directory '$SOURCE_DIR' does not exist" >&2
  exit 1
fi

TMP_ZIP="$(mktemp /tmp/build-upload-XXXXXX.zip)"
TMP_DOWNLOAD="$(mktemp /tmp/build-output-XXXXXX.zip)"

cleanup() {
  rm -f "$TMP_ZIP" "$TMP_DOWNLOAD"
}
trap cleanup EXIT

# ── 1. Zip source dir (exclude noise) ────────────────────────────────────────
echo "Zipping $SOURCE_DIR ..."
(
  cd "$SOURCE_DIR"
  zip -r "$TMP_ZIP" . \
    --exclude "node_modules/*" \
    --exclude ".git/*" \
    --exclude "dist/*" \
    --exclude "portals/*" \
    -q
)
echo "Upload size: $(du -sh "$TMP_ZIP" | cut -f1)"

# ── 2. POST zip and receive portals.zip synchronously ────────────────────────
echo "Building at $SERVICE_URL/build ..."

# URL-encode the query params
ENCODED_OUT="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$OUT_DIR" 2>/dev/null || printf '%s' "$OUT_DIR")"
ENCODED_CMD="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$BUILD_CMD" 2>/dev/null || printf '%s' "$BUILD_CMD")"

HTTP_STATUS="$(curl -s -w "%{http_code}" \
  -F "source=@${TMP_ZIP};type=application/zip" \
  "${SERVICE_URL}/build?outDir=${ENCODED_OUT}&buildCmd=${ENCODED_CMD}" \
  -o "$TMP_DOWNLOAD")"

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "Error: build service returned HTTP $HTTP_STATUS" >&2
  # The response body is the error JSON
  cat "$TMP_DOWNLOAD" >&2
  echo "" >&2
  exit 1
fi

# ── 3. Extract portals.zip ────────────────────────────────────────────────────
OUTPUT_DIR="./dist-output"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
unzip -q "$TMP_DOWNLOAD" -d "$OUTPUT_DIR"

FILE_COUNT="$(find "$OUTPUT_DIR" -type f | wc -l | tr -d ' ')"
TOTAL_SIZE="$(du -sh "$OUTPUT_DIR" | cut -f1)"
echo "Done! Output: $OUTPUT_DIR ($FILE_COUNT files, $TOTAL_SIZE)"
