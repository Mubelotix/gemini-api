#!/usr/bin/env bash
set -euo pipefail

TIMESTAMP="$(date +%s)"
EXT_VERSION="1.0.$TIMESTAMP"
CONFIG_DIR="$PWD/config"
EXT_DIR="$PWD/extension"
BUILD_DIR="$CONFIG_DIR/chrome-ext"
KEY_FILE="$BUILD_DIR/extension.pem"
CRX_FILE="$BUILD_DIR/extension.crx"
POLICY_FILE="$BUILD_DIR/gemini-proxy-extension-policy.json"

test -f "$EXT_DIR/manifest.json"
mkdir -p "$BUILD_DIR"

if [[ ! -f "$KEY_FILE" ]]; then
  openssl genrsa -out "$KEY_FILE" 2048 >/dev/null 2>&1
fi

EXT_ID="$(openssl rsa -in "$KEY_FILE" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | xxd -p -c 256 \
  | cut -c1-32 \
  | tr '0-9a-f' 'a-p')"


rm -rf "$BUILD_DIR/src"
cp -R "$EXT_DIR" "$BUILD_DIR/src"
rm -f "$BUILD_DIR/src.crx"

python3 - "$BUILD_DIR/src/manifest.json" "$EXT_VERSION" <<'PY'
import json
import sys

manifest_path = sys.argv[1]
version = sys.argv[2]

with open(manifest_path, "r", encoding="utf-8") as f:
    manifest = json.load(f)

manifest["version"] = version

with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e PUID=$(id -u) \
  -e PGID=$(id -g) \
  -v "$BUILD_DIR:/work" \
  lscr.io/linuxserver/chrome:latest \
  /bin/bash -lc '
    set -e
    CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser)"
    "$CHROME_BIN" --no-sandbox --pack-extension=/work/src --pack-extension-key=/work/extension.pem >/dev/null 2>&1
  '

mv -f "$BUILD_DIR/src.crx" "$CRX_FILE"
rm -rf "$BUILD_DIR/src"

cat > "$BUILD_DIR/$EXT_ID.json" <<JSON
{
  "external_crx": "/config/chrome-ext/extension.crx",
  "external_version": "$EXT_VERSION"
}
JSON

cat > "$POLICY_FILE" <<JSON
{
  "ExtensionSettings": {
    "$EXT_ID": {
      "minimum_version_required": "$EXT_VERSION"
    }
  }
}
JSON

echo "Force-installed extension id: $EXT_ID version $EXT_VERSION"

rm ./config/chrome.log
docker run --rm \
  --name=chrome \
  -e PUID=$(id -u) \
  -e PGID=$(id -g) \
  -e TZ=Etc/UTC \
  -e CHROME_CLI="--enable-logging --v=1 --log-file=/config/chrome.log" \
  -p 3000:3000 \
  -p 3001:3001 \
  --add-host=host.docker.internal:host-gateway \
  -v "$CONFIG_DIR:/config" \
  -v "$BUILD_DIR/$EXT_ID.json:/opt/google/chrome/extensions/$EXT_ID.json:ro" \
  -v "$POLICY_FILE:/etc/opt/chrome/policies/managed/gemini-proxy-extension-policy.json:ro" \
  --shm-size="2gb" \
  lscr.io/linuxserver/chrome:latest
