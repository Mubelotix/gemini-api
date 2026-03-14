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
async function waitForGeminiResponse(tabId, baselineText, timeoutMs = 120000, onChunk) {
  const start = Date.now();
  let lastText = baselineText;
  let lastEmittedResponse = '';
  let stableCount = 0;
  const STABLE_TICKS_REQUIRED = 2;
  const POLL_INTERVAL_MS = 1000;
  let prevIsTyping = null;
  let tick = 0;

  console.log('[gemini-proxy-extension] waitForGeminiResponse:start', {
    timeoutMs,
    baselineLength: baselineText.length,
    pollIntervalMs: POLL_INTERVAL_MS,
    stableTicksRequired: STABLE_TICKS_REQUIRED,
  });

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => window.setTimeout(r, POLL_INTERVAL_MS));
    tick += 1;

    let currentText;
    try {
      const result = await sendTabMessage(tabId, { type: 'gemini-get-innertext' });
      currentText = result?.innerText ?? '';
    } catch {
      // Tab may not be ready yet; keep polling.
      continue;
    }

    const currentResponse = await tryExtractResponseMarkdown(tabId);
    if (typeof onChunk === 'function' && currentResponse && currentResponse !== lastEmittedResponse) {
      if (currentResponse.startsWith(lastEmittedResponse)) {
        const delta = currentResponse.slice(lastEmittedResponse.length);
        if (delta.length > 0) {
          onChunk(delta);
        }
        lastEmittedResponse = currentResponse;
      } else if (lastEmittedResponse.startsWith(currentResponse)) {
        // UI re-rendered to a shorter intermediate representation; don't emit.
      } else {
        // Non-monotonic rewrite (formatting/layout churn). Skip incremental emit.
        // Final fallback (onResult) will still return the complete response.
      }
    }

    // Gemini transient status is visible in page text; inspect full document innerText.
    const isTyping = /gemini is (thinking|typing)/i.test(currentText);

    if (prevIsTyping !== isTyping) {
      console.log('[gemini-proxy-extension] waitForGeminiResponse:typing-state-changed', {
        elapsedMs: Date.now() - start,
        isTyping,
        currentLength: currentText.length,
      });
      prevIsTyping = isTyping;
    }

    if (tick % 10 === 0) {
      console.log('[gemini-proxy-extension] waitForGeminiResponse:tick', {
        elapsedMs: Date.now() - start,
        isTyping,
        stableCount,
        currentLength: currentText.length,
      });
    }

    if (isTyping) {
      // Still generating – reset stability counter.
      stableCount = 0;
      lastText = currentText;
      continue;
    }

    if (currentText.length > baselineText.length) {
      if (currentText === lastText) {
        stableCount++;
      } else {
        stableCount = 0;
        lastText = currentText;
      }

      if (stableCount >= STABLE_TICKS_REQUIRED) {
        console.log('[gemini-proxy-extension] waitForGeminiResponse:stable-complete', {
          elapsedMs: Date.now() - start,
          stableCount,
          currentLength: currentText.length,
        });
        return await extractResponseMarkdown(tabId, baselineText, currentText);
      }
    } else {
      stableCount = 0;
      lastText = currentText;
    }
  }

  console.log('[gemini-proxy-extension] waitForGeminiResponse:timeout', {
    elapsedMs: Date.now() - start,
    timeoutMs,
    stableCount,
  });
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

// Extracts the final Gemini response as markdown via the content script.
// Falls back to innerText diff on any error.
async function tryExtractResponseMarkdown(tabId) {
  try {
    const result = await sendTabMessage(tabId, { type: 'gemini-get-response-markdown' });
    if (result?.markdown) return result.markdown;
  } catch {
    // fall through
  }
  return null;
}

async function extractResponseMarkdown(tabId, baselineText, currentText) {
  const markdown = await tryExtractResponseMarkdown(tabId);
  if (markdown) {
    return markdown;
  }
  return extractNewContent(baselineText, currentText);
}

async function waitForSendButtonEnabled(tabId, timeoutMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await sendTabMessage(tabId, { type: 'gemini-can-send' });
    if (result?.canSend) {
      return;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }

  throw new Error('Timed out waiting for Gemini send button to become enabled');
}

async function runGeminiGenerate({ prompt, files = [], onStatus, onChunk, onResult }) {
  let tabId = null;

  try {
    onStatus({ state: 'gemini-generate-started' });

    const tab = await window.createGeminiTab('https://gemini.google.com/app');

    tabId = tab.id;

    // waitForTabLoad is defined in gemini_tabs.js.
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

    if (files.length > 0) {
      const pasteResult = await sendTabMessage(tabId, {
        type: 'gemini-paste-files',
        files,
      });

      if (!pasteResult?.success) {
        throw new Error(pasteResult?.error ?? 'Failed to paste files into Gemini editor');
      }

      onStatus({ state: 'gemini-generate-files-pasted', count: files.length });
      await waitForSendButtonEnabled(tabId);
    }

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
    const responseText = await waitForGeminiResponse(tabId, baselineText, 120000, onChunk);

    console.log('[gemini-proxy-extension] gemini generate response', responseText);
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
