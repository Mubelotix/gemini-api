// Sends a single tab message and resolves with the response.
const GEMINI_RESPONSE_TIMEOUT_MS = 20 * 60 * 1000;
// Tab registry helpers (geminiTabRegistry, computePromptHashes, findReusableTab,
// stripMatchedMessages, pruneExpiredTabs) are defined in gemini_tab_registry.js.

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
// streamBaseline controls the starting point for incremental chunk emission.
// Pass null for reused tabs so the new response is streamed from scratch instead
// of being compared against the previous turn's text (which has no prefix relation).
async function waitForGeminiResponse(tabId, baselineResponse, timeoutMs = GEMINI_RESPONSE_TIMEOUT_MS, onChunk, streamBaseline = baselineResponse) {
  const start = Date.now();
  let lastEmittedResponse = streamBaseline ?? '';
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
  let isReusedTab = false;

  pruneExpiredTabs();
  const requestHashes = computePromptHashes(prompt);
  const reuse = findReusableTab(requestHashes);

  console.log('[gemini-proxy-extension] gemini-generate request hashes', {
    hashCount: requestHashes.length,
  });

  try {
    onStatus({ state: 'gemini-generate-started' });

    let effectivePrompt = prompt;
    let effectiveFiles = files;

    if (reuse) {
      // Reuse an existing conversation tab by injecting only the new messages.
      tabId = reuse.tabId;
      isReusedTab = true;
      const entry = geminiTabRegistry.get(tabId);
      entry.generating = true;
      entry.lastUsedAt = Date.now();
      const stripped = stripMatchedMessages(prompt, files, reuse.matchCount);
      effectivePrompt = stripped.prompt;
      effectiveFiles = stripped.files;
      console.log('[gemini-proxy-extension] reusing gemini tab', tabId, {
        stripped: reuse.matchCount,
        remaining: requestHashes.length - reuse.matchCount,
      });
    } else {
      // Open a fresh Gemini tab and wait for the SPA to finish loading.
      console.log('[gemini-proxy-extension] no reusable tab found, opening new tab');
      await ensureTabCapacityForNewConversation();

      const tab = await window.createGeminiTab('https://gemini.google.com/app');
      tabId = tab.id;
      geminiTabRegistry.set(tabId, { generating: true, messageHashes: [], lastUsedAt: Date.now() });

      // waitForTabLoad is defined in gemini_tabs.js.
      await waitForTabLoad(tabId);

      // Extra delay for the Gemini SPA to finish rendering its editor.
      await new Promise((r) => window.setTimeout(r, 3000));
    }

    // Inject the (possibly stripped) prompt into the Quill editor.
    const injectResult = await sendTabMessage(tabId, {
      type: 'gemini-inject-prompt',
      prompt: effectivePrompt,
    });

    if (!injectResult?.success) {
      throw new Error(injectResult?.error ?? 'Failed to inject prompt into Gemini editor');
    }

    onStatus({ state: 'gemini-generate-prompt-injected' });

    if (effectiveFiles.length > 0) {
      const pasteResult = await sendTabMessage(tabId, {
        type: 'gemini-paste-files',
        files: effectiveFiles,
      });

      if (!pasteResult?.success) {
        throw new Error(pasteResult?.error ?? 'Failed to paste files into Gemini editor');
      }

      onStatus({ state: 'gemini-generate-files-pasted', count: effectiveFiles.length });
      await waitForSendButtonEnabled(tabId);
    }

    // Small pause so Angular/Quill can register the change before we click send.
    await new Promise((r) => window.setTimeout(r, 500));

    // Snapshot the last response BEFORE clicking send. For a reused tab this is
    // the previous turn's response; for a new tab it is null. It is used both as
    // the completion sentinel (new response ≠ baseline) and, for new tabs only,
    // as the streaming start point. Reused tabs stream from '' so the new
    // response is emitted as fresh incremental chunks.
    const baselineResponse = await tryExtractResponseMarkdown(tabId);

    // Click the send button.
    const sendResult = await sendTabMessage(tabId, { type: 'gemini-click-send' });

    if (!sendResult?.success) {
      throw new Error(sendResult?.error ?? 'Failed to click Send message button');
    }

    onStatus({ state: 'gemini-generate-sent' });

    // Poll until response is complete.
    const responseText = await waitForGeminiResponse(
      tabId,
      baselineResponse,
      GEMINI_RESPONSE_TIMEOUT_MS,
      onChunk,
      isReusedTab ? null : baselineResponse,
    );
    console.log('[gemini-proxy-extension] gemini generate response', responseText);

    // Mark the tab as idle and record the full request hashes so future requests
    // with a matching prefix can reuse this conversation.
    const entry = geminiTabRegistry.get(tabId);
    if (entry) {
      entry.generating = false;
      entry.messageHashes = requestHashes;
      entry.lastUsedAt = Date.now();
    }

    onResult({ text: responseText });

  } catch (error) {
    // Ensure the tab is no longer marked as generating so it can be reused or
    // cleaned up by the next pruneExpiredTabs() call.
    if (tabId !== null) {
      const entry = geminiTabRegistry.get(tabId);
      if (entry) entry.generating = false;
    }

    onStatus({ state: 'gemini-generate-error', error: String(error) });
    onResult({ text: '', error: String(error) });
  } finally {
    if (!isReusedTab && tabId !== null) {
      // New tab: keep it open only if generation succeeded (entry has hashes).
      // On failure the entry is empty; close the tab and clean up the registry.
      const entry = geminiTabRegistry.get(tabId);
      if (!entry || entry.messageHashes.length === 0) {
        geminiTabRegistry.delete(tabId);
        chrome.tabs.remove(tabId).catch(() => {});
      }
    }
    // Reused tabs are always kept open (idle) for future reuse.
  }
}

window.runGeminiGenerate = runGeminiGenerate;
