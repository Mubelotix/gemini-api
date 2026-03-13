const PERSISTENT_PAGE_PATH = 'persistent.html';

let openingPersistentPage = null;

async function ensurePersistentPageOpen() {
	const pageUrl = chrome.runtime.getURL(PERSISTENT_PAGE_PATH);
	const existingTabs = await chrome.tabs.query({ url: pageUrl });

	if (existingTabs.length > 0) {
		console.log('[gemini-proxy-extension] persistent page already open', existingTabs[0].id);
		return;
	}

	const tabs = await chrome.tabs.query({});
	const replacementTab = tabs.find((tab) => tab.id && !tab.url?.startsWith('chrome-extension://'));

	if (replacementTab?.id) {
		const updatedTab = await chrome.tabs.update(replacementTab.id, {
			url: pageUrl,
		});

		console.log('[gemini-proxy-extension] replaced existing tab with persistent page', updatedTab.id);
		return;
	}

	const createdTab = await chrome.tabs.create({ url: pageUrl, active: false });
	console.log('[gemini-proxy-extension] opened persistent page tab', createdTab.id);
}

function initializePersistentPage() {
	if (openingPersistentPage) {
		return openingPersistentPage;
	}

	openingPersistentPage = ensurePersistentPageOpen()
		.catch((error) => {
			console.error('[gemini-proxy-extension] failed to open persistent page', error);
		})
		.finally(() => {
			openingPersistentPage = null;
		});

	return openingPersistentPage;
}

// Reopen the persistent page whenever it is closed.
chrome.tabs.onRemoved.addListener((tabId) => {
	const pageUrl = chrome.runtime.getURL(PERSISTENT_PAGE_PATH);

	// We don't have the URL of the closed tab anymore, so we check whether
	// the persistent page is still open anywhere. If not, reopen it.
	chrome.tabs.query({ url: pageUrl }, (tabs) => {
		if (tabs.length === 0) {
			console.log('[gemini-proxy-extension] persistent page closed (tab', tabId, '), reopening');
			initializePersistentPage();
		}
	});
});

// Reopen if the persistent page tab is navigated away from persistent.html.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (!changeInfo.url) {
		return;
	}

	const pageUrl = chrome.runtime.getURL(PERSISTENT_PAGE_PATH);

	if (!changeInfo.url.startsWith(pageUrl)) {
		// Something navigated away; check if persistent page is still open elsewhere.
		chrome.tabs.query({ url: pageUrl }, (tabs) => {
			if (tabs.length === 0) {
				console.log('[gemini-proxy-extension] persistent page navigated away (tab', tabId, '), reopening');
				initializePersistentPage();
			}
		});
	}
});

chrome.runtime.onInstalled.addListener(() => {
	console.log('[gemini-proxy-extension] installed');
	initializePersistentPage();
});

chrome.runtime.onStartup.addListener(() => {
	console.log('[gemini-proxy-extension] startup');
	initializePersistentPage();
});

chrome.runtime.onMessage.addListener((message) => {
	if (!message || message.target !== 'background') {
		return;
	}

	if (message.type === 'ws-log') {
		console.log('[gemini-proxy-extension] persistent page websocket message', message.payload);
		return;
	}

	if (message.type === 'ws-status') {
		console.log('[gemini-proxy-extension] persistent page websocket status', message.payload);
		return;
	}

	if (message.type === 'ensure-persistent-page') {
		initializePersistentPage();
	}

    console.warn('[gemini-proxy-extension] unknown message to background', message);
});

console.log('[gemini-proxy-extension] background loaded');
initializePersistentPage();
