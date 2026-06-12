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
        onResult: ({ text, error, cache }) => {
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              id: requestId,
              type: 'gemini-generate-response',
              text: text,
              error: error ?? null,
              done: true,
              cache: cache ?? null,
            }));
          }
        },
      });
    }
  } catch (e) {
    // Ignore non-JSON websocket payloads.
  }
}

function logToBackend(message) {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({
      type: 'log',
      message: message
    }));
  }
}

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = function(...args) {
  originalConsoleLog.apply(console, args);
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  logToBackend(msg);
};

console.warn = function(...args) {
  originalConsoleWarn.apply(console, args);
  const msg = '[WARN] ' + args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  logToBackend(msg);
};

console.error = function(...args) {
  originalConsoleError.apply(console, args);
  const msg = '[ERROR] ' + args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  logToBackend(msg);
};

// Receive captured response body when network request completes
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'gemini-response-finished') {
    console.log('[gemini-proxy-extension] received gemini response finished');
    if (typeof window.handleGeminiResponseFinished === 'function') {
      window.handleGeminiResponseFinished(message.body);
    }
  }
  if (message && message.type === 'gemini-log') {
    logToBackend(message.message);
  }
});

window.addEventListener('load', () => {
  sendToBackground('ws-status', { state: 'persistent-page-loaded' });
  connectWebSocket();
});
