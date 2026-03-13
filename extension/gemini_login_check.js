function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let timeout = null;

    const cleanup = () => {
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) {
        return;
      }

      if (changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Gemini tab load'));
    }, timeoutMs);
  });
}

function queryGeminiSignInDetails(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'check-gemini-signin-details' }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      if (!response || typeof response.signInPresent !== 'boolean') {
        reject(new Error('Missing signInPresent response from content script'));
        return;
      }

      resolve(response);
    });
  });
}

async function runGeminiLoginCheck({ onStatus, onResult }) {
  let tabId = null;

  try {
    onStatus({ state: 'gemini-check-started' });

    const tab = await chrome.tabs.create({
      url: 'https://gemini.google.com/',
      active: false,
    });

    if (!tab.id) {
      throw new Error('Gemini tab creation failed');
    }

    tabId = tab.id;
    await waitForTabLoad(tabId);

    const details = await queryGeminiSignInDetails(tabId);
    onResult({ signInPresent: details.signInPresent });

    onStatus({
      state: 'gemini-check-complete',
      signInPresent: details.signInPresent,
    });

    console.log('[extension-something] gemini document.innerText', details.innerText ?? '');
  } catch (error) {
    onStatus({
      state: 'gemini-check-error',
      error: String(error),
    });
  } finally {
    if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Ignore if tab is already gone.
      }
    }
  }
}

window.runGeminiLoginCheck = runGeminiLoginCheck;
