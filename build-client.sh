#!/usr/bin/env bash
set -euo pipefail

# Usage: ./build-client.sh <source-dir> <build-service-url> [outDir] [buildCmd]

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <source-dir> <build-service-url> [outDir] [buildCmd]" >&2
  exit 1
fi

SOURCE_DIR="$1"
SERVICE_URL="${2%/}"  # strip trailing slash
OUT_DIR="${3:-dist}"
BUILD_CMD="${4:-pnpm install && pnpm build}"
POLL_INTERVAL=3
POLL_TIMEOUT=360

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Error: source directory '$SOURCE_DIR' does not exist" >&2
  exit 1
fi

# Create temp files for zip and output
TMP_ZIP="$(mktemp /tmp/build-upload-XXXXXX.zip)"
TMP_DOWNLOAD="$(mktemp /tmp/build-output-XXXXXX.zip)"

cleanup() {
  rm -f "$TMP_ZIP" "$TMP_DOWNLOAD"
}
trap cleanup EXIT

echo "Zipping source directory: $SOURCE_DIR"
(
  cd "$SOURCE_DIR"
  zip -r "$TMP_ZIP" . \
    --exclude "node_modules/*" \
    --exclude ".git/*" \
    --exclude "dist/*" \
    -q
)
echo "Zip created: $(du -sh "$TMP_ZIP" | cut -f1)"

echo "Posting to $SERVICE_URL/build ..."
RESPONSE="$(curl -sf \
  -F "source=@${TMP_ZIP};type=application/zip" \
  "${SERVICE_URL}/build?outDir=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${OUT_DIR}')" 2>/dev/null || printf '%s' "$OUT_DIR")&buildCmd=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${BUILD_CMD}')" 2>/dev/null || printf '%s' "$BUILD_CMD")" \
  2>&1)" || {
  echo "Error: Failed to POST to build service" >&2
  exit 1
}

JOB_ID="$(echo "$RESPONSE" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)"
if [[ -z "$JOB_ID" ]]; then
  echo "Error: Could not parse jobId from response: $RESPONSE" >&2
  exit 1
fi

echo "Job accepted. jobId: $JOB_ID"
echo "Polling for build status (timeout: ${POLL_TIMEOUT}s) ..."

START_TIME="$(date +%s)"
ELAPSED=0

while true; do
  NOW="$(date +%s)"
  ELAPSED=$(( NOW - START_TIME ))

  if [[ $ELAPSED -ge $POLL_TIMEOUT ]]; then
    echo "Timeout: build did not complete within ${POLL_TIMEOUT}s" >&2
    exit 1
  fi

  STATUS_RESPONSE="$(curl -sf "${SERVICE_URL}/build/${JOB_ID}" 2>&1)" || {
    echo "Warning: failed to poll status, retrying..." >&2
    sleep "$POLL_INTERVAL"
    continue
  }

  STATUS="$(echo "$STATUS_RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)"
  ELAPSED_MS="$(echo "$STATUS_RESPONSE" | grep -o '"elapsedMs":[0-9]*' | cut -d':' -f2)"

  echo "  [${ELAPSED}s elapsed] status=${STATUS} elapsedMs=${ELAPSED_MS:-?}"

  if [[ "$STATUS" == "complete" ]]; then
    echo "Build complete! Downloading output..."

    curl -sf "${SERVICE_URL}/build/${JOB_ID}/download" -o "$TMP_DOWNLOAD" || {
      echo "Error: Failed to download build output" >&2
      exit 1
    }

    OUTPUT_DIR="./dist-output"
    mkdir -p "$OUTPUT_DIR"
    unzip -q "$TMP_DOWNLOAD" -d "$OUTPUT_DIR"

    FILE_COUNT="$(find "$OUTPUT_DIR" -type f | wc -l)"
    TOTAL_SIZE="$(du -sh "$OUTPUT_DIR" | cut -f1)"
    echo "Output extracted to: $OUTPUT_DIR"
    echo "Files: $FILE_COUNT, Total size: $TOTAL_SIZE"
    exit 0

  elif [[ "$STATUS" == "failed" ]]; then
    echo "Build failed!" >&2
    LOGS="$(echo "$STATUS_RESPONSE" | grep -o '"logs":"[^"]*"' | cut -d'"' -f4 | sed 's/\\n/\n/g')"
    ERROR="$(echo "$STATUS_RESPONSE" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)"
    if [[ -n "$ERROR" ]]; then
      echo "Error: $ERROR" >&2
    fi
    if [[ -n "$LOGS" ]]; then
      echo "--- Build Logs ---" >&2
      echo "$LOGS" >&2
      echo "------------------" >&2
    fi
    exit 1
  fi

  sleep "$POLL_INTERVAL"
done
