console.log('[gemini-proxy-extension] content script injected on', window.location.href);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!message) {
		return;
	}

	if (message.type === 'check-gemini-signin' || message.type === 'check-gemini-signin-details') {
		const innerText = document.body?.innerText ?? '';
		const normalized = innerText.replace(/\s+/g, ' ').trim();
		const signInPresent = /(^|\s)sign\s*in(\s|$)/i.test(normalized);
		sendResponse({ signInPresent, innerText });
		return true;
	}

	if (message.type === 'gemini-inject-prompt') {
		try {
			const inputArea = document.querySelector('input-area-v2');
			if (!inputArea) {
				sendResponse({ success: false, error: 'Could not find input-area-v2' });
				return true;
			}
			const editor = inputArea.querySelector('.ql-editor');
			if (!editor) {
				sendResponse({ success: false, error: 'Could not find .ql-editor inside input-area-v2' });
				return true;
			}
			// Escape HTML entities to prevent injection.
			const safe = String(message.prompt)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');
			editor.innerHTML = `<p>${safe}</p>`;
			editor.classList.remove('ql-blank');
			editor.dispatchEvent(new Event('input', { bubbles: true }));
			sendResponse({ success: true });
		} catch (e) {
			sendResponse({ success: false, error: String(e) });
		}
		return true;
	}

	if (message.type === 'gemini-click-send') {
		try {
			const button = document.querySelector('button[aria-label="Send message"]');
			if (!button) {
				sendResponse({ success: false, error: 'Could not find button[aria-label="Send message"]' });
				return true;
			}
			button.click();
			sendResponse({ success: true });
		} catch (e) {
			sendResponse({ success: false, error: String(e) });
		}
		return true;
	}

	if (message.type === 'gemini-get-innertext') {
		sendResponse({ innerText: document.body?.innerText ?? '' });
		return true;
	}
});
