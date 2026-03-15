// ---- Tab registry for Gemini conversation reuse ----
//
// Tracks open Gemini tabs so that subsequent requests sharing a common
// message history can be sent as a continuation rather than opening a
// new tab each time.
//
// Map<tabId, { generating: bool, messageHashes: string[], lastUsedAt: number }>
const geminiTabRegistry = new Map();
const TAB_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TRACKED_GEMINI_TABS = 3;

function summarizeHashes(hashes, max = 6) {
  const list = Array.isArray(hashes) ? hashes : [];
  if (list.length <= max) {
    return list;
  }
  return [...list.slice(0, max), `...(+${list.length - max})`];
}

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(36);
}

// Parses a prompt that begins with a JSON array, returning { messages, extra }
// where extra is any trailing text after the closing ']'. Returns null on failure.
function parsePromptJsonArray(prompt) {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('[')) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const arrayStr = trimmed.slice(0, i + 1);
        const extra = trimmed.slice(i + 1).trim();
        try {
          const messages = JSON.parse(arrayStr);
          if (Array.isArray(messages)) return { messages, extra };
        } catch { return null; }
        return null;
      }
    }
  }
  return null;
}

// Returns an array that starts with a system-prompt hash (if present), then
// hashes for each message in order.
//
// Important: trailing non-JSON content (tool instructions appended after the
// messages array) is intentionally ignored for reuse matching. That content is
// not part of the conversation history and previously caused false mismatches
// when additional messages were appended in later turns.
function computePromptHashes(prompt) {
  const parsed = parsePromptJsonArray(prompt);
  if (!parsed || parsed.messages.length === 0) return [hashString(prompt)];
  const { messages, extra } = parsed;
  const hashes = [];

  const firstMessage = messages[0];
  if (firstMessage?.role === 'system') {
    hashes.push(hashString(JSON.stringify(firstMessage.content ?? '')));
  }

  for (const message of messages) {
    hashes.push(hashString(JSON.stringify(message)));
  }

  if (extra) {
    console.log('[gemini-proxy-extension] tab-reuse ignored trailing prompt suffix for hashing', {
      suffixLength: extra.length,
      messageCount: messages.length,
    });
  }

  return hashes;
}

// Returns { tabId, matchCount } for the best non-generating tab whose
// messageHashes form a *strict* prefix of requestHashes (i.e. at least one new
// message remains to be sent). Returns null if no suitable tab exists.
function findReusableTab(requestHashes) {
  console.log('[gemini-proxy-extension] tab-reuse selection start', {
    requestHashCount: requestHashes.length,
    requestHashes: summarizeHashes(requestHashes),
    trackedTabs: geminiTabRegistry.size,
  });

  let bestTabId = null;
  let bestCount = 0;

  for (const [tabId, info] of geminiTabRegistry) {
    const mh = info.messageHashes;
    const debug = {
      tabId,
      generating: info.generating,
      tabHashCount: mh.length,
      tabHashes: summarizeHashes(mh),
    };

    if (info.generating) {
      console.log('[gemini-proxy-extension] tab-reuse candidate skipped', {
        ...debug,
        reason: 'tab-generating',
      });
      continue;
    }

    if (mh.length === 0) {
      console.log('[gemini-proxy-extension] tab-reuse candidate skipped', {
        ...debug,
        reason: 'no-recorded-message-hashes',
      });
      continue;
    }

    if (mh.length >= requestHashes.length) {
      console.log('[gemini-proxy-extension] tab-reuse candidate skipped', {
        ...debug,
        reason: 'candidate-history-not-strict-prefix',
      });
      continue;
    }

    let match = true;
    let mismatchIndex = -1;
    for (let i = 0; i < mh.length; i++) {
      if (mh[i] !== requestHashes[i]) {
        match = false;
        mismatchIndex = i;
        break;
      }
    }

    if (!match) {
      console.log('[gemini-proxy-extension] tab-reuse candidate skipped', {
        ...debug,
        reason: 'hash-prefix-mismatch',
        mismatchIndex,
        candidateHashAtMismatch: mh[mismatchIndex],
        requestHashAtMismatch: requestHashes[mismatchIndex],
      });
      continue;
    }

    if (match && mh.length > bestCount) {
      bestTabId = tabId;
      bestCount = mh.length;
      console.log('[gemini-proxy-extension] tab-reuse candidate best-so-far', {
        ...debug,
        matchCount: mh.length,
      });
    } else {
      console.log('[gemini-proxy-extension] tab-reuse candidate matched-not-selected', {
        ...debug,
        matchCount: mh.length,
        bestCount,
      });
    }
  }

  if (bestTabId !== null) {
    console.log('[gemini-proxy-extension] tab-reuse selected', {
      tabId: bestTabId,
      matchCount: bestCount,
    });
    return { tabId: bestTabId, matchCount: bestCount };
  }

  console.log('[gemini-proxy-extension] tab-reuse no-match', {
    requestHashCount: requestHashes.length,
    trackedTabs: geminiTabRegistry.size,
  });
  return null;
}

// Strips the first matchCount messages from the prompt JSON array.
// File indices referenced by kept messages are remapped to start from 0.
function stripMatchedMessages(prompt, files, matchCount) {
  const parsed = parsePromptJsonArray(prompt);
  if (!parsed) return { prompt, files };
  const { messages, extra } = parsed;
  const kept = messages.slice(matchCount);

  const keptIndices = new Set();
  for (const msg of kept) {
    if (Array.isArray(msg.images)) {
      for (const idx of msg.images) keptIndices.add(idx);
    }
  }
  const sorted = Array.from(keptIndices).sort((a, b) => a - b);
  const remapIndex = new Map(sorted.map((old, i) => [old, i]));
  const newFiles = sorted.map(idx => files[idx]);

  const remapped = kept.map(msg => {
    if (!Array.isArray(msg.images) || msg.images.length === 0) return msg;
    return { ...msg, images: msg.images.map(idx => remapIndex.get(idx)) };
  });

  const newPrompt = extra ? JSON.stringify(remapped) + '\n\n' + extra : JSON.stringify(remapped);
  return { prompt: newPrompt, files: newFiles };
}

function pruneExpiredTabs() {
  const now = Date.now();
  let closedCount = 0;
  for (const [tabId, info] of geminiTabRegistry) {
    if (!info.generating && now - info.lastUsedAt > TAB_EXPIRY_MS) {
      geminiTabRegistry.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
      closedCount += 1;
      console.log('[gemini-proxy-extension] closed expired gemini tab', tabId);
    }
  }

  if (closedCount > 0) {
    console.log('[gemini-proxy-extension] tab registry after expiry prune', {
      closedCount,
      remaining: geminiTabRegistry.size,
      maxTracked: MAX_TRACKED_GEMINI_TABS,
    });
  }
}

async function ensureTabCapacityForNewConversation() {
  if (geminiTabRegistry.size < MAX_TRACKED_GEMINI_TABS) {
    return;
  }

  const idleCandidates = Array.from(geminiTabRegistry.entries())
    .filter(([, info]) => !info.generating)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

  while (geminiTabRegistry.size >= MAX_TRACKED_GEMINI_TABS && idleCandidates.length > 0) {
    const [tabId] = idleCandidates.shift();
    geminiTabRegistry.delete(tabId);
    await chrome.tabs.remove(tabId).catch(() => {});
    console.log('[gemini-proxy-extension] closed idle tab to enforce max-tab limit', {
      closedTabId: tabId,
      remaining: geminiTabRegistry.size,
      maxTracked: MAX_TRACKED_GEMINI_TABS,
    });
  }

  if (geminiTabRegistry.size >= MAX_TRACKED_GEMINI_TABS) {
    const busyTabs = Array.from(geminiTabRegistry.entries())
      .filter(([, info]) => info.generating)
      .map(([tabId]) => tabId);
    const errorMessage = `Cannot open a new Gemini tab: all ${MAX_TRACKED_GEMINI_TABS} tracked tabs are currently generating`;
    console.warn('[gemini-proxy-extension] max-tab limit reached with no idle tabs to evict', {
      maxTracked: MAX_TRACKED_GEMINI_TABS,
      busyTabs,
    });
    throw new Error(errorMessage);
  }
}

// Keep the registry clean when tabs are closed externally.
chrome.tabs.onRemoved.addListener((closedTabId) => {
  if (geminiTabRegistry.has(closedTabId)) {
    geminiTabRegistry.delete(closedTabId);
    console.log('[gemini-proxy-extension] gemini tab', closedTabId, 'closed externally, removed from registry');
  }
});
