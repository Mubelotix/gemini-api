// Sends a single tab message and resolves with the response.
function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

// Polls the tab innerText every second, waiting until Gemini finishes responding.
// Returns the new content (diff vs baseline).
async function waitForGeminiResponse(tabId, baselineText, timeoutMs = 120000) {
  const start = Date.now();
  let seenTyping = false;

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => window.setTimeout(r, 1000));

    let currentText;
    try {
      const result = await sendTabMessage(tabId, { type: 'gemini-get-innertext' });
      currentText = result?.innerText ?? '';
    } catch {
      // Tab may not be ready yet; keep polling.
      continue;
    }

    const isTyping = /gemini is (thinking|typing)/i.test(currentText);

    if (isTyping) {
      seenTyping = true;
    }

    // Response is complete when we have seen the typing indicator and it is now gone,
    // and the page has grown beyond the baseline.
    if (seenTyping && !isTyping && currentText.length > baselineText.length) {
      return extractNewContent(baselineText, currentText);
    }
  }

  throw new Error('Timed out waiting for Gemini response');
}

// Returns the text in `current` that was not present in `baseline`.
function extractNewContent(baseline, current) {
  if (current.startsWith(baseline)) {
    return current.slice(baseline.length).trim();
  }

  // Find the longest matching prefix and return the rest.
  let i = 0;
  const minLen = Math.min(baseline.length, current.length);
  while (i < minLen && baseline[i] === current[i]) {
    i++;
  }
  return current.slice(i).trim();
}

async function runGeminiGenerate({ prompt, onStatus, onResult }) {
  let tabId = null;

  try {
    onStatus({ state: 'gemini-generate-started' });

    const tab = await chrome.tabs.create({
      url: 'https://gemini.google.com/app',
      active: false,
    });

    if (!tab.id) {
      throw new Error('Gemini tab creation failed');
    }

    tabId = tab.id;

    // waitForTabLoad is defined in gemini_login_check.js (loaded before this script).
    await waitForTabLoad(tabId);

    // Extra delay for the Gemini SPA to finish rendering its editor.
    await new Promise((r) => window.setTimeout(r, 3000));

    // Inject the prompt into the Quill editor.
    const injectResult = await sendTabMessage(tabId, {
      type: 'gemini-inject-prompt',
      prompt,
    });

    if (!injectResult?.success) {
      throw new Error(injectResult?.error ?? 'Failed to inject prompt into Gemini editor');
    }

    onStatus({ state: 'gemini-generate-prompt-injected' });

    // Small pause so Angular/Quill can register the change before we click send.
    await new Promise((r) => window.setTimeout(r, 500));

    // Snapshot the page BEFORE clicking send so we can diff afterwards.
    const baselineResult = await sendTabMessage(tabId, { type: 'gemini-get-innertext' });
    const baselineText = baselineResult?.innerText ?? '';

    // Click the send button.
    const sendResult = await sendTabMessage(tabId, { type: 'gemini-click-send' });

    if (!sendResult?.success) {
      throw new Error(sendResult?.error ?? 'Failed to click Send message button');
    }

    onStatus({ state: 'gemini-generate-sent' });

    // Poll until response is complete.
    const responseText = await waitForGeminiResponse(tabId, baselineText);

    console.log('[extension-something] gemini generate response', responseText);
    onResult({ text: responseText });

  } catch (error) {
    onStatus({ state: 'gemini-generate-error', error: String(error) });
    onResult({ text: '', error: String(error) });
  } finally {
    if (tabId !== null) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

window.runGeminiGenerate = runGeminiGenerate;
