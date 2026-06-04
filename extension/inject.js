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
          cloned.text().then(text => {
            window.postMessage({
              type: "gemini-response-finished",
              body: text
            }, "*");
          }).catch(err => {
            console.error("[gemini-proxy-inject] Error reading clone text:", err);
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
        this.addEventListener("load", () => {
          try {
            window.postMessage({
              type: "gemini-response-finished",
              body: this.responseText
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
