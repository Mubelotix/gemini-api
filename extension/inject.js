(function() {
  if (window.__gemini_proxy_injected__) return;
  window.__gemini_proxy_injected__ = true;

  console.log('[gemini-proxy-inject] Script injected into main world');

  // Hook Fetch
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const response = await originalFetch(...args);
      const url = args[0];
      const urlString = typeof url === 'string' ? url : (url instanceof URL ? url.href : (url && url.url) || '');
      
      if (urlString && urlString.includes("assistant.lamda.BardFrontendService/StreamGenerate")) {
        console.log("[gemini-proxy-inject] Intercepted StreamGenerate fetch");
        try {
          const cloned = response.clone();
          readFetchStream(cloned).catch(err => {
            console.error("[gemini-proxy-inject] Error reading fetch stream:", err);
          });
        } catch (e) {
          console.error("[gemini-proxy-inject] Error cloning response:", e);
        }
      }
      return response;
    } catch (error) {
      throw error;
    }
  };

  async function readFetchStream(response) {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let accumulated = "";
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        window.postMessage({
          type: "gemini-stream-chunk",
          body: accumulated,
          done: true
        }, "*");
        break;
      }
      accumulated += decoder.decode(value, { stream: true });
      window.postMessage({
        type: "gemini-stream-chunk",
        body: accumulated,
        done: false
      }, "*");
    }
  }

  // Hook XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = typeof url === 'string' ? url : (url instanceof URL ? url.href : '');
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body) {
    try {
      if (this._url && this._url.includes("assistant.lamda.BardFrontendService/StreamGenerate")) {
        console.log("[gemini-proxy-inject] Intercepted StreamGenerate XHR");
        this.addEventListener("progress", () => {
          try {
            window.postMessage({
              type: "gemini-stream-chunk",
              body: this.responseText,
              done: false
            }, "*");
          } catch (e) {
            console.error("[gemini-proxy-inject] XHR progress handler error:", e);
          }
        });
        this.addEventListener("load", () => {
          try {
            window.postMessage({
              type: "gemini-stream-chunk",
              body: this.responseText,
              done: true
            }, "*");
          } catch (e) {
            console.error("[gemini-proxy-inject] XHR load handler error:", e);
          }
        });
      }
    } catch (e) {
      console.error("[gemini-proxy-inject] XHR send hook error:", e);
    }
    return originalSend.call(this, body);
  };
})();
