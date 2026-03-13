const PERSISTENT_PAGE_PATH = 'persistent.html';

let openingPersistentPage = null;
let startupSequence = null;

function requestUpdateCheck() {
	if (typeof chrome.runtime.requestUpdateCheck !== 'function') {
		return Promise.resolve({ status: 'unavailable' });
	}

	return new Promise((resolve, reject) => {
		try {
			chrome.runtime.requestUpdateCheck((status, details) => {
				const lastError = chrome.runtime.lastError;
				if (lastError) {
					reject(new Error(lastError.message));
					return;
				}

				resolve({ status, details });
			});
		} catch (error) {
			reject(error);
		}
	});
}

async function ensureUpdatedBeforeOpeningPage() {
	try {
		const result = await requestUpdateCheck();

		if (result.status === 'update_available') {
			console.log('[extension-something] update available at startup, reloading extension', result.details);
			chrome.runtime.reload();
			return false;
		}

		console.log('[extension-something] startup update-check status', result.status);
		return true;
	} catch (error) {
		console.error('[extension-something] startup update-check failed', error);
		return true;
	}
}

async function ensurePersistentPageOpen() {
	const pageUrl = chrome.runtime.getURL(PERSISTENT_PAGE_PATH);
	const existingTabs = await chrome.tabs.query({ url: pageUrl });

	if (existingTabs.length > 0) {
		console.log('[extension-something] persistent page already open', existingTabs[0].id);
		return;
	}

	const tabs = await chrome.tabs.query({});
	const replacementTab = tabs.find((tab) => tab.id && !tab.url?.startsWith('chrome-extension://'));

	if (replacementTab?.id) {
		const updatedTab = await chrome.tabs.update(replacementTab.id, {
			url: pageUrl,
		});

		console.log('[extension-something] replaced existing tab with persistent page', updatedTab.id);
		return;
	}

	const createdTab = await chrome.tabs.create({ url: pageUrl, active: false });
	console.log('[extension-something] opened persistent page tab', createdTab.id);
}

function initializePersistentPage() {
	if (openingPersistentPage) {
		return openingPersistentPage;
	}

	openingPersistentPage = ensurePersistentPageOpen()
		.catch((error) => {
			console.error('[extension-something] failed to open persistent page', error);
		})
		.finally(() => {
			openingPersistentPage = null;
		});

	return openingPersistentPage;
}

function runStartupSequence() {
	if (startupSequence) {
		return startupSequence;
	}

	startupSequence = (async () => {
		const canProceed = await ensureUpdatedBeforeOpeningPage();
		if (canProceed) {
			await initializePersistentPage();
		}
	})().finally(() => {
		startupSequence = null;
	});

	return startupSequence;
}

chrome.runtime.onInstalled.addListener(() => {
	console.log('[extension-something] installed');
	runStartupSequence();
});

chrome.runtime.onStartup.addListener(() => {
	console.log('[extension-something] startup');
	runStartupSequence();
});

chrome.runtime.onMessage.addListener((message) => {
	if (!message || message.target !== 'background') {
		return;
	}

	if (message.type === 'ws-log') {
		console.log('[extension-something] persistent page websocket message', message.payload);
		return;
	}

	if (message.type === 'ws-status') {
		console.log('[extension-something] persistent page websocket status', message.payload);
		return;
	}

	if (message.type === 'ensure-persistent-page') {
		initializePersistentPage();
	}
});

console.log('[extension-something] background loaded');
runStartupSequence();
