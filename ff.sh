#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="./extension"
EXT_ID="extension@something"
XPI_NAME="extension-something.xpi"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Building extension..."
test -f "$EXT_DIR/manifest.json"
(
  cd "$EXT_DIR"
  zip -qr "$TMP_DIR/$XPI_NAME" .
)
echo "Built: $TMP_DIR/$XPI_NAME"

cat > "$TMP_DIR/policies.json" <<JSON
{
  "policies": {
    "ExtensionSettings": {
      "$EXT_ID": {
        "installation_mode": "force_installed",
        "install_url": "file:///extension/$XPI_NAME"
      }
    }
  }
}
JSON

docker run --rm \
  --name=firefox \
  -e PUID=$(id -u) \
  -e PGID=$(id -g) \
  -e TZ=Etc/UTC \
  -e FIREFOX_CLI="https://www.linuxserver.io/ " \
  -p 3000:3000 \
  -v ./config:/config \
  -v "$TMP_DIR/$XPI_NAME:/extension/$XPI_NAME:ro" \
  -v "$TMP_DIR/policies.json:/usr/lib/firefox/distribution/policies.json:ro" \
  --shm-size="1gb" \
  lscr.io/linuxserver/firefox:latest