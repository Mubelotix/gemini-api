// Sends a single tab message and resolves with the response.
const GEMINI_RESPONSE_TIMEOUT_MS = 20 * 60 * 1000;

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

// Global reference to the currently active generation request
let activeGenerateRequest = null;

// Helper to extract choice text from StreamGenerate response body
function extractTextFromResponse(body) {
  const regex = /\["wrb\.fr",\s*null,\s*"((?:[^"\\]|\\.)*)"\]/g;
  let match;
  let latestText = "";
  let latestThinking = "";
  let matchCount = 0;
  let parseFailureCount = 0;
  
  while ((match = regex.exec(body)) !== null) {
    matchCount++;
    try {
      const unescaped = JSON.parse('{"t":"' + match[1] + '"}').t;
      const data = JSON.parse(unescaped);
      console.log('[gemini-proxy-extension] match ' + matchCount + ' parsed data: ' + JSON.stringify(data));
      
      // Check newer structure in data[4]
      if (Array.isArray(data) && data.length > 4 && Array.isArray(data[4])) {
        const parts = data[4];
        if (parts.length > 0 && Array.isArray(parts[0]) && parts[0].length > 1) {
          const textList = parts[0][1];
          if (Array.isArray(textList) && textList.length > 0 && typeof textList[0] === 'string') {
            const text = textList[0];
            if (text.length > latestText.length) {
              latestText = text;
            }
          }
          
          // Extract thinking text from parts[0][37]
          if (parts[0].length > 37 && Array.isArray(parts[0][37])) {
            const thinkingSteps = parts[0][37];
            const steps = [];
            for (let i = 0; i < thinkingSteps.length; i += 2) {
              const step = thinkingSteps[i];
              if (Array.isArray(step) && typeof step[0] === 'string' && step[0]) {
                steps.push(step[0]);
              }
            }
            const thinkingText = steps.join("");
            if (thinkingText.length > latestThinking.length) {
              latestThinking = thinkingText;
            }
          }
        }
      }
      
      // Fallback/older structure in data[5]
      if (Array.isArray(data) && data.length > 5 && Array.isArray(data[5])) {
        const choices = data[5];
        if (choices.length > 0 && Array.isArray(choices[0]) && choices[0].length > 1) {
          const textList = choices[0][1];
          if (Array.isArray(textList) && textList.length > 0 && typeof textList[0] === 'string') {
            const text = textList[0];
            if (text.length > latestText.length) {
              latestText = text;
            }
          }
          
          // Extract thinking text from choices[0][37]
          if (choices[0].length > 37 && Array.isArray(choices[0][37])) {
            const thinkingSteps = choices[0][37];
            const steps = [];
            for (let i = 0; i < thinkingSteps.length; i += 2) {
              const step = thinkingSteps[i];
              if (Array.isArray(step) && typeof step[0] === 'string' && step[0]) {
                steps.push(step[0]);
              }
            }
            const thinkingText = steps.join("");
            if (thinkingText.length > latestThinking.length) {
              latestThinking = thinkingText;
            }
          }
        }
      }
    } catch (e) {
      parseFailureCount++;
      console.warn('[gemini-proxy-extension] extractTextFromResponse: failed to parse chunk match', e);
    }
  }
  console.log('[gemini-proxy-extension] extractTextFromResponse summary: ' + JSON.stringify({
    matchCount,
    parseFailureCount,
    extractedLength: latestText.length,
    extractedThinkingLength: latestThinking.length,
  }));
  
  let responseText = "";
  if (latestThinking) {
    responseText += `<think>\n${latestThinking}\n</think>\n\n`;
  }
  responseText += latestText;
  return responseText;
}

// Callback invoked when the main world script posts the finished response body
function handleGeminiResponseFinished(body) {
  console.log('[gemini-proxy-extension] handleGeminiResponseFinished called: ' + JSON.stringify({
    hasActiveRequest: !!activeGenerateRequest,
    bodyLength: body?.length ?? 0,
  }));

  if (!activeGenerateRequest) {
    return;
  }
  
  const text = extractTextFromResponse(body);
  if (text) {
    if (activeGenerateRequest.timeout) {
      clearTimeout(activeGenerateRequest.timeout);
    }
    activeGenerateRequest.resolve(text);
    activeGenerateRequest = null;
  } else {
    if (activeGenerateRequest.timeout) {
      clearTimeout(activeGenerateRequest.timeout);
    }
    activeGenerateRequest.reject(new Error("Failed to extract text from StreamGenerate response"));
    activeGenerateRequest = null;
  }
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
      console.log('[gemini-proxy-extension] no reusable tab found, opening new tab');
      await ensureTabCapacityForNewConversation();

      const tab = await window.createGeminiTab('https://gemini.google.com/app');
      tabId = tab.id;
      geminiTabRegistry.set(tabId, { generating: true, messageHashes: [], lastUsedAt: Date.now() });

      await waitForTabLoad(tabId);
      await new Promise((r) => window.setTimeout(r, 3000));
    }

    // Ensure the tab's Send button is ready and not stuck on Stop response.
    const readyResult = await sendTabMessage(tabId, { type: 'gemini-ensure-send-ready' }).catch(err => ({ success: false, error: err.message }));
    if (!readyResult?.success) {
      console.warn('[gemini-proxy-extension] Tab send button stuck on Stop response, attempted to reset but it did not transition. Proceeding anyway.', readyResult?.error);
    }

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
      
      // Wait for send button
      let buttonEnabled = false;
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const result = await sendTabMessage(tabId, { type: 'gemini-can-send' });
        if (result?.canSend) {
          buttonEnabled = true;
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      if (!buttonEnabled) {
        throw new Error('Timed out waiting for Gemini send button to become enabled');
      }
    }

    await new Promise((r) => window.setTimeout(r, 500));

    // Prepare active generate request callbacks to await network response
    let resolveResponsePromise;
    let rejectResponsePromise;
    const responsePromise = new Promise((resolve, reject) => {
      resolveResponsePromise = resolve;
      rejectResponsePromise = reject;
    });

    let sentLength = 0;

    activeGenerateRequest = {
      tabId: tabId,
      onChunk: (text) => {
        const delta = text.slice(sentLength);
        if (delta) {
          onChunk(delta);
          sentLength = text.length;
        }
      },
      onResult: onResult,
      resolve: resolveResponsePromise,
      reject: rejectResponsePromise,
      timeout: setTimeout(() => {
        if (activeGenerateRequest) {
          activeGenerateRequest.reject(new Error("Timeout waiting for response from network capture"));
          activeGenerateRequest = null;
        }
      }, GEMINI_RESPONSE_TIMEOUT_MS)
    };

    // Click the send button.
    const sendResult = await sendTabMessage(tabId, { type: 'gemini-click-send' });

    if (!sendResult?.success) {
      throw new Error(sendResult?.error ?? 'Failed to click Send message button');
    }

    onStatus({ state: 'gemini-generate-sent' });

    // Await the promise resolved when the network request completes
    const responseText = await responsePromise;
    console.log('[gemini-proxy-extension] gemini generate response (from network capture)', responseText);

    const entry = geminiTabRegistry.get(tabId);
    if (entry) {
      entry.generating = false;
      entry.messageHashes = requestHashes;
      entry.lastUsedAt = Date.now();
    }

    const finalDelta = responseText.slice(sentLength);
    onResult({ text: finalDelta });

  } catch (error) {
    if (tabId !== null) {
      const entry = geminiTabRegistry.get(tabId);
      if (entry) entry.generating = false;
    }
    if (activeGenerateRequest) {
      if (activeGenerateRequest.timeout) {
        clearTimeout(activeGenerateRequest.timeout);
      }
      activeGenerateRequest = null;
    }
    onStatus({ state: 'gemini-generate-error', error: String(error) });
    onResult({ text: '', error: String(error) });
  } finally {
    if (!isReusedTab && tabId !== null) {
      const entry = geminiTabRegistry.get(tabId);
      if (!entry || entry.messageHashes.length === 0) {
        geminiTabRegistry.delete(tabId);
        chrome.tabs.remove(tabId).catch(() => {});
      }
    }
  }
}

window.runGeminiGenerate = runGeminiGenerate;
window.handleGeminiResponseFinished = handleGeminiResponseFinished;
