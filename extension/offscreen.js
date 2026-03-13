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

window.addEventListener('load', () => {
  sendToBackground('ws-status', { state: 'offscreen-loaded' });
  connectWebSocket();
});
