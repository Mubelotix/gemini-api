// Sends a single tab message and resolves with the response.
const widgetMarkerUrl = 'http://googleusercontent.com/immersive_entry_chip/0';

function createWidgetMarkerError(source) {
  const error = new Error(`Debug halt: detected Gemini immersive widget marker (${widgetMarkerUrl}) in ${source}`);
  error.code = 'GEMINI_WIDGET_MARKER_DETECTED';
  error.markerUrl = widgetMarkerUrl;
  return error;
}

function containsWidgetMarker(text) {
  return String(text ?? '').includes(widgetMarkerUrl);
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

// Polls response markdown and stop-button state until Gemini finishes responding.
async function waitForGeminiResponse(tabId, baselineResponse, timeoutMs = 120000, onChunk) {
  const start = Date.now();
  let lastEmittedResponse = baselineResponse ?? '';
  const POLL_INTERVAL_MS = 1000;
  let prevIsTyping = null;
  let tick = 0;

  console.log('[gemini-proxy-extension] waitForGeminiResponse:start', {
    timeoutMs,
    baselineLength: lastEmittedResponse.length,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => window.setTimeout(r, POLL_INTERVAL_MS));
    tick += 1;

    const currentResponse = await tryExtractResponseMarkdown(tabId);
    if (containsWidgetMarker(currentResponse)) {
      throw createWidgetMarkerError('response markdown');
    }

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

    // Prefer explicit UI state from the Stop response button.
    let isTyping = false;
    try {
      const status = await sendTabMessage(tabId, { type: 'gemini-is-responding' });
      isTyping = Boolean(status?.isResponding);
    } catch {
      // If status is temporarily unavailable, keep polling.
      continue;
    }

    if (prevIsTyping !== isTyping) {
      console.log('[gemini-proxy-extension] waitForGeminiResponse:typing-state-changed', {
        elapsedMs: Date.now() - start,
        isTyping,
        currentLength: currentResponse?.length ?? 0,
      });
      prevIsTyping = isTyping;
    }

    if (tick % 10 === 0) {
      console.log('[gemini-proxy-extension] waitForGeminiResponse:tick', {
        elapsedMs: Date.now() - start,
        isTyping,
        currentLength: currentResponse?.length ?? 0,
      });
    }

    if (isTyping) {
      // Still generating.
      continue;
    }

    if (currentResponse && currentResponse !== baselineResponse) {
      console.log('[gemini-proxy-extension] waitForGeminiResponse:typing-complete', {
        elapsedMs: Date.now() - start,
        currentLength: currentResponse.length,
      });
      return currentResponse;
    }
  }

  console.log('[gemini-proxy-extension] waitForGeminiResponse:timeout', {
    elapsedMs: Date.now() - start,
    timeoutMs,
  });
  throw new Error('Timed out waiting for Gemini response');
}

// Extracts the final Gemini response as markdown via the content script.
async function tryExtractResponseMarkdown(tabId) {
  try {
    const result = await sendTabMessage(tabId, { type: 'gemini-get-response-markdown' });
    if (result?.markdown) return result.markdown;
  } catch {
    // fall through
  }
  return null;
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
  let keepTabOpenForDebug = false;

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

    // Snapshot the latest markdown BEFORE clicking send so we can detect new output.
    const baselineResponse = await tryExtractResponseMarkdown(tabId);

    // Click the send button.
    const sendResult = await sendTabMessage(tabId, { type: 'gemini-click-send' });

    if (!sendResult?.success) {
      throw new Error(sendResult?.error ?? 'Failed to click Send message button');
    }

    onStatus({ state: 'gemini-generate-sent' });

    // Poll until response is complete.
    const responseText = await waitForGeminiResponse(tabId, baselineResponse, 120000, onChunk);
    if (containsWidgetMarker(responseText)) {
      throw createWidgetMarkerError('final response text');
    }

    console.log('[gemini-proxy-extension] gemini generate response', responseText);
    onResult({ text: responseText });

  } catch (error) {
    if (error?.code === 'GEMINI_WIDGET_MARKER_DETECTED') {
      keepTabOpenForDebug = true;
      onStatus({
        state: 'gemini-generate-debug-halt-widget-detected',
        markerUrl: widgetMarkerUrl,
        tabId,
      });
      console.error('[gemini-proxy-extension] debug halt: immersive widget marker detected; tab left open', {
        tabId,
        markerUrl: widgetMarkerUrl,
      });
    }

    onStatus({ state: 'gemini-generate-error', error: String(error) });
    onResult({ text: '', error: String(error) });
  } finally {
    if (tabId !== null && !keepTabOpenForDebug) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

window.runGeminiGenerate = runGeminiGenerate;
