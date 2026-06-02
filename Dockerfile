# syntax=docker/dockerfile:1
FROM lscr.io/linuxserver/chrome:latest

# Switch to root to perform installations and configurations
USER root

# Install Python 3, venv, and development tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    build-essential \
    openssl \
    xxd \
    && rm -rf /var/lib/apt/lists/*

# Copy the extension source code to build/pack it
COPY extension /app/extension

# Pack the Chrome extension and save the extension ID
# HOME=/tmp prevents Chrome from creating root-owned files in /config (the default HOME)
RUN mkdir -p /tmp/extension-src && \
    cp -r /app/extension/* /tmp/extension-src/ && \
    openssl genrsa -out /app/extension.pem 2048 && \
    EXT_ID=$(openssl rsa -in /app/extension.pem -pubout -outform DER 2>/dev/null \
      | openssl dgst -sha256 -binary \
      | xxd -p -c 256 \
      | cut -c1-32 \
      | tr '0-9a-f' 'a-p') && \
    echo "$EXT_ID" > /tmp/ext_id.txt && \
    HOME=/tmp google-chrome-stable --no-sandbox --pack-extension=/tmp/extension-src --pack-extension-key=/app/extension.pem && \
    mkdir -p /usr/share/chrome-ext && \
    mkdir -p /opt/google/chrome/extensions && \
    mkdir -p /etc/opt/chrome/policies/managed && \
    mv /tmp/extension-src.crx /usr/share/chrome-ext/extension.crx && \
    chmod 755 /usr/share/chrome-ext && \
    chmod 644 /usr/share/chrome-ext/extension.crx

# Generate the JSON configurations using Python
RUN python3 - <<'PY'
import json

with open('/tmp/ext_id.txt', 'r', encoding='utf-8') as f:
    ext_id = f.read().strip()

with open('/tmp/extension-src/manifest.json', 'r', encoding='utf-8') as f:
    manifest = json.load(f)
version = manifest['version']

# Write extension configuration
ext_conf = {
    "external_crx": "/usr/share/chrome-ext/extension.crx",
    "external_version": version
}
with open(f'/opt/google/chrome/extensions/{ext_id}.json', 'w', encoding='utf-8') as f:
    json.dump(ext_conf, f, indent=2)

# Write force-install policy
policy_conf = {
    "ExtensionSettings": {
        ext_id: {
            "minimum_version_required": version
        }
    }
}
with open('/etc/opt/chrome/policies/managed/gemini-proxy-extension-policy.json', 'w', encoding='utf-8') as f:
    json.dump(policy_conf, f, indent=2)

print(f"Packed extension configured with ID: {ext_id} version: {version}")
PY

# Cleanup temporary build files
RUN rm -rf /tmp/extension-src /tmp/ext_id.txt

# Overwrite default autostart scripts to always include required chrome flags and support HEADLESS=true
RUN cat <<'EOF' > /defaults/autostart
#!/bin/bash
REQUIRED_FLAGS="--enable-logging --v=1 --log-file=/config/chrome.log --auto-open-devtools-for-tabs"
if [ "${HEADLESS}" = "true" ]; then
  REQUIRED_FLAGS="${REQUIRED_FLAGS} --headless=new"
fi
exec wrapped-chrome ${REQUIRED_FLAGS} ${CHROME_CLI}
EOF

RUN cat <<'EOF' > /defaults/autostart_wayland
#!/bin/bash
REQUIRED_FLAGS="--enable-logging --v=1 --log-file=/config/chrome.log --auto-open-devtools-for-tabs"
if [ "${HEADLESS}" = "true" ]; then
  REQUIRED_FLAGS="${REQUIRED_FLAGS} --headless=new"
fi
exec wrapped-chrome --enable-features=UseOzonePlatform --ozone-platform=wayland ${REQUIRED_FLAGS} ${CHROME_CLI}
EOF

RUN chmod +x /defaults/autostart /defaults/autostart_wayland

# Force-copy updated autostart scripts to the mounted config folder on container startup
RUN mkdir -p /custom-cont-init.d && \
    cat <<'EOF' > /custom-cont-init.d/50-copy-autostart
#!/bin/bash
echo "[gemini-api] Force-updating autostart scripts in /config/.config/..."
mkdir -p /config/.config/labwc /config/.config/openbox
cp -f /defaults/autostart /config/.config/openbox/autostart
cp -f /defaults/autostart_wayland /config/.config/labwc/autostart
chown -R abc:abc /config/.config
EOF
RUN chmod +x /custom-cont-init.d/50-copy-autostart


# Copy uv binary from the official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Set up the Python virtual environment using uv
WORKDIR /app
COPY pyproject.toml uv.lock /app/
RUN uv sync --frozen --no-dev

# Copy backend files
COPY backend /app/backend

# Configure s6-overlay services
# 1. Add longrun service for LiteLLM backend and ensure hosts file is configured at launch
RUN mkdir -p /etc/s6-overlay/s6-rc.d/backend && \
    echo "longrun" > /etc/s6-overlay/s6-rc.d/backend/type
RUN cat <<'EOF' > /etc/s6-overlay/s6-rc.d/backend/run
#!/command/with-contenv bash
echo "127.0.0.1 host.docker.internal" >> /etc/hosts || true
cd /app
exec .venv/bin/python backend/service.py
EOF
RUN chmod +x /etc/s6-overlay/s6-rc.d/backend/run && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/backend

# Expose ports:
# 3000: Chrome desktop UI via KasmVNC
# 1111: BentoML backend API
EXPOSE 3000 1111
