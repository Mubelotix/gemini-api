async function focusTabIfPossible(tab) {
  if (!tab?.id) {
    return;
  }

  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    // Ignore focus failures.
  }

  if (tab.windowId !== undefined) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      // Ignore focus failures.
    }
  }
}

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

async function createGeminiTab(url) {
  const tab = await chrome.tabs.create({
    url,
    active: true,
  });

  if (!tab.id) {
    throw new Error('Gemini tab creation failed');
  }

  await focusTabIfPossible(tab);
  return tab;
}

window.focusTabIfPossible = focusTabIfPossible;
window.waitForTabLoad = waitForTabLoad;
window.createGeminiTab = createGeminiTab;
