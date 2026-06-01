chrome.devtools.network.onRequestFinished.addListener((request) => {
  const url = request.request?.url ?? "";
  if (url.includes("assistant.lamda.BardFrontendService/StreamGenerate")) {
    request.getContent((body) => {
      chrome.runtime.sendMessage({
        type: 'devtools-network-request',
        url: url,
        body: body ?? ""
      });
    });
  }
});
