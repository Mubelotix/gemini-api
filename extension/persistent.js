const websocketUrl = 'ws://host.docker.internal:1111/incoming-requests';

const reconnectDelayMs = 1000;
const imagePreviewLifetimeMs = 5000;
let websocket = null;
let reconnectTimer = null;

function ensurePreviewContainer() {
  let container = document.getElementById('debug-image-previews');
  if (container) {
    return container;
  }

  container = document.createElement('div');
  container.id = 'debug-image-previews';
  Object.assign(container.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    alignItems: 'flex-end',
    pointerEvents: 'none',
    maxWidth: 'min(320px, 90vw)',
  });

  document.body.appendChild(container);
  return container;
}

function showImagePreviewInPage(file, index) {
  const contentType = String(file?.contentType ?? file?.content_type ?? '');
  const bytes = String(file?.bytes ?? '');
  if (!contentType.startsWith('image/') || !bytes) {
    return;
  }

  const container = ensurePreviewContainer();
  const card = document.createElement('div');
  Object.assign(card.style, {
    background: 'rgba(20, 20, 20, 0.92)',
    color: '#fff',
    borderRadius: '12px',
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
    padding: '10px',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '12px',
    lineHeight: '1.4',
    pointerEvents: 'auto',
  });

  const label = document.createElement('div');
  label.textContent = `image attachment #${index + 1} · ${contentType}`;
  label.style.marginBottom = '8px';

  const image = new Image();
  image.src = `data:${contentType};base64,${bytes}`;
  image.alt = `attachment-${index + 1}`;
  Object.assign(image.style, {
    display: 'block',
    maxWidth: '280px',
    maxHeight: '220px',
    borderRadius: '8px',
    background: '#111',
  });

  card.appendChild(label);
  card.appendChild(image);
  container.appendChild(card);

  window.setTimeout(() => {
    card.remove();
    if (container.childElementCount === 0) {
      container.remove();
    }
  }, imagePreviewLifetimeMs);
}

function estimateBase64ByteLength(base64) {
  const normalized = String(base64 ?? '').replace(/\s+/g, '');
  if (normalized.length === 0) {
    return 0;
  }

  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

function sanitizeFileForLogging(file) {
  const contentType = String(file?.contentType ?? file?.content_type ?? 'application/octet-stream');
  const bytes = String(file?.bytes ?? '');

  return {
    ...file,
    contentType,
    bytes: `[redacted ${estimateBase64ByteLength(bytes)} bytes]`,
  };
}

function logImagePreview(file, index) {
  const contentType = String(file?.contentType ?? file?.content_type ?? '');
  const bytes = String(file?.bytes ?? '');
  if (!contentType.startsWith('image/') || !bytes) {
    return;
  }

  showImagePreviewInPage(file, index);
  console.log(`[gemini-proxy-extension] websocket image attachment #${index + 1}`, {
    contentType,
    bytes: `[redacted ${estimateBase64ByteLength(bytes)} bytes]`,
  });
}

function sanitizeWebSocketLogPayload(rawData) {
  try {
    const parsed = JSON.parse(rawData);
    if (!Array.isArray(parsed?.files)) {
      return parsed;
    }

    return {
      ...parsed,
      files: parsed.files.map(sanitizeFileForLogging),
    };
  } catch {
    return rawData;
  }
}

function logWebSocketMessage(rawData) {
  const sanitizedPayload = sanitizeWebSocketLogPayload(rawData);
  console.log('[gemini-proxy-extension] websocket message', sanitizedPayload);

  try {
    const parsed = JSON.parse(rawData);
    if (Array.isArray(parsed?.files)) {
      parsed.files.forEach(logImagePreview);
    }
  } catch {
    // Ignore non-JSON websocket payloads.
  }

  return sanitizedPayload;
}

function sendToBackground(type, payload) {
  chrome.runtime.sendMessage({
    target: 'background',
    type,
    payload,
  }).catch((error) => {
    console.error('[gemini-proxy-extension] failed to send runtime message', error);
  });
}

function scheduleReconnect() {
  if (reconnectTimer !== null) {
    return;
  }

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, reconnectDelayMs);
}

function connectWebSocket() {
  const url = websocketUrl;

  sendToBackground('ws-status', { state: 'connecting', url });
  websocket = new WebSocket(url);

  websocket.addEventListener('open', () => {
    sendToBackground('ws-status', { state: 'open', url });
  });

  websocket.addEventListener('message', (event) => {
    const sanitizedPayload = logWebSocketMessage(event.data);
    sendToBackground('ws-log', { url, data: sanitizedPayload });
    handleBackendMessage(event.data);
  });

  websocket.addEventListener('error', () => {
    sendToBackground('ws-status', { state: 'error', url });
  });

  websocket.addEventListener('close', (event) => {
    sendToBackground('ws-status', {
      state: 'closed',
      url,
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });

    websocket = null;
    scheduleReconnect();
  });
}

function handleBackendMessage(rawData) {
  try {
    const message = JSON.parse(rawData);
    const requestId = message?.id;

    if (typeof requestId !== 'number') {
      sendToBackground('ws-status', {
        state: 'backend-message-missing-id',
        message,
      });
      return;
    }

    if (message?.type === 'check-gemini-login') {
      if (typeof window.runGeminiLoginCheck !== 'function') {
        sendToBackground('ws-status', {
          state: 'gemini-check-error',
          error: 'Gemini login checker is unavailable',
        });
        return;
      }

      window.runGeminiLoginCheck({
        onStatus: (payload) => {
          sendToBackground('ws-status', payload);
        },
        onResult: ({ signInPresent }) => {
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              id: requestId,
              type: 'gemini-login-status',
              signInPresent,
              done: true,
            }));
          }
        },
      });
    }

    if (message?.type === 'gemini-generate') {
      if (typeof window.runGeminiGenerate !== 'function') {
        sendToBackground('ws-status', {
          state: 'gemini-generate-error',
          error: 'Gemini generate handler is unavailable',
        });
        return;
      }

      const prompt = message.prompt ?? '';
        const files = Array.isArray(message.files) ? message.files : [];
      let streamedText = '';
      window.runGeminiGenerate({
        prompt,
          files,
        onStatus: (payload) => {
          sendToBackground('ws-status', payload);
        },
        onChunk: (text) => {
          const chunk = String(text ?? '');
          if (chunk.length === 0) {
            return;
          }

          streamedText += chunk;

          if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              id: requestId,
              type: 'gemini-generate-response',
              text: chunk,
              error: null,
              done: false,
            }));
          }
        },
        onResult: ({ text, error }) => {
          const finalText = String(text ?? '');
          const tail = finalText.startsWith(streamedText)
            ? finalText.slice(streamedText.length)
            : finalText;

          if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              id: requestId,
              type: 'gemini-generate-response',
              text: tail,
              error: error ?? null,
              done: true,
            }));
          }
        },
      });
    }
  } catch {
    // Ignore non-JSON websocket payloads.
  }
}

window.addEventListener('load', () => {
  sendToBackground('ws-status', { state: 'persistent-page-loaded' });
  connectWebSocket();
});
