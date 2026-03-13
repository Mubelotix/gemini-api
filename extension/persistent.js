const websocketUrls = [
  'ws://host.docker.internal:1111/incoming-requests',
  'ws://127.0.0.1:1111/incoming-requests',
];

const reconnectDelayMs = 1000;
let websocket = null;
let reconnectTimer = null;
let nextUrlIndex = 0;

function sendToBackground(type, payload) {
  chrome.runtime.sendMessage({
    target: 'background',
    type,
    payload,
  }).catch((error) => {
    console.error('[extension-something] failed to send runtime message', error);
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
  const url = websocketUrls[nextUrlIndex % websocketUrls.length];
  nextUrlIndex += 1;

  sendToBackground('ws-status', { state: 'connecting', url });
  websocket = new WebSocket(url);

  websocket.addEventListener('open', () => {
    sendToBackground('ws-status', { state: 'open', url });
  });

  websocket.addEventListener('message', (event) => {
    console.log('[extension-something] websocket message', event.data);
    sendToBackground('ws-log', { url, data: event.data });
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
              type: 'gemini-login-status',
              signInPresent,
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
      window.runGeminiGenerate({
        prompt,
        onStatus: (payload) => {
          sendToBackground('ws-status', payload);
        },
        onResult: ({ text, error }) => {
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              type: 'gemini-generate-response',
              text: text ?? '',
              error: error ?? null,
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
