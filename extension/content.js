console.log('[extension-something] content script injected on', window.location.href);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!message || (message.type !== 'check-gemini-signin' && message.type !== 'check-gemini-signin-details')) {
		return;
	}

	const innerText = document.body?.innerText ?? '';
	const normalized = innerText.replace(/\s+/g, ' ').trim();
	const signInPresent = /(^|\s)sign\s*in(\s|$)/i.test(normalized);

	sendResponse({ signInPresent, innerText });
});
