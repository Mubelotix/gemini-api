const websocketUrl = 'ws://host.docker.internal:1111/incoming-requests';

const reconnectDelayMs = 1000;
let websocket = null;
let reconnectTimer = null;

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
    console.log('[gemini-proxy-extension] websocket message', event.data);
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
    const requestId = message?.id;

    if (typeof requestId !== 'number') {
      sendToBackground('ws-status', {
        state: 'backend-message-missing-id',
        message,
      });
      return;
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
      
      window.runGeminiGenerate({
        prompt,
        files,
        onStatus: (payload) => {
          sendToBackground('ws-status', payload);
        },
        onChunk: (text) => {
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              id: requestId,
              type: 'gemini-generate-response',
              text: text,
              error: null,
              done: false,
            }));
          }
        },
        onResult: ({ text, error }) => {
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              id: requestId,
              type: 'gemini-generate-response',
              text: text,
              error: error ?? null,
              done: true,
            }));
          }
        },
      });
    }
  } catch (e) {
    // Ignore non-JSON websocket payloads.
  }
}

// Receive captured network request responses or stream chunks
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message) {
    if (message.type === 'devtools-network-request') {
      console.log('[gemini-proxy-extension] received devtools network request response');
      if (typeof window.handleDevToolsNetworkRequest === 'function') {
        window.handleDevToolsNetworkRequest(message.body);
      }
    } else if (message.type === 'gemini-stream-chunk') {
      console.log('[gemini-proxy-extension] received gemini stream chunk');
      if (typeof window.handleGeminiStreamChunk === 'function') {
        window.handleGeminiStreamChunk(message.body);
      }
    }
  }
});

window.addEventListener('load', () => {
  sendToBackground('ws-status', { state: 'persistent-page-loaded' });
  connectWebSocket();
});
