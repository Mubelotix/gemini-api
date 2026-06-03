console.log('[gemini-proxy-extension] content script injected on', window.location.href);

function getGeminiEditor() {
	const inputArea = document.querySelector('input-area-v2');
	if (!inputArea) {
		throw new Error('Could not find input-area-v2');
	}

	const editor = inputArea.querySelector('.ql-editor');
	if (!editor) {
		throw new Error('Could not find .ql-editor inside input-area-v2');
	}

	return editor;
}

function isGeminiGuestUploadBlocked() {
	const innerText = document.body?.innerText ?? '';
	const normalized = innerText.replace(/\s+/g, ' ').trim();
	return /(^|\s)sign\s*in(\s|$)/i.test(normalized);
}

function decodeBase64ToBytes(base64) {
	const normalized = String(base64 ?? '').replace(/\s+/g, '');
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function inferFileExtension(contentType) {
	const knownExtensions = {
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/gif': 'gif',
		'image/webp': 'webp',
		'application/pdf': 'pdf',
		'text/plain': 'txt',
	};

	return knownExtensions[contentType] ?? 'bin';
}

function moveCaretToEnd(element) {
	if (!element || typeof window.getSelection !== 'function') {
		return;
	}

	const selection = window.getSelection();
	if (!selection) {
		return;
	}

	const range = document.createRange();
	range.selectNodeContents(element);
	range.collapse(false);
	selection.removeAllRanges();
	selection.addRange(range);
}

function createPasteEvent(dataTransfer) {
	try {
		return new ClipboardEvent('paste', {
			bubbles: true,
			cancelable: true,
			clipboardData: dataTransfer,
		});
	} catch {
		const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(pasteEvent, 'clipboardData', {
			value: dataTransfer,
		});
		return pasteEvent;
	}
}

function createBeforeInputEvent(dataTransfer) {
	try {
		return new InputEvent('beforeinput', {
			bubbles: true,
			cancelable: true,
			inputType: 'insertFromPaste',
			dataTransfer,
		});
	} catch {
		const inputEvent = new Event('beforeinput', { bubbles: true, cancelable: true });
		Object.defineProperty(inputEvent, 'inputType', {
			value: 'insertFromPaste',
		});
		Object.defineProperty(inputEvent, 'dataTransfer', {
			value: dataTransfer,
		});
		return inputEvent;
	}
}

function dispatchSyntheticFilePaste(target, dataTransfer) {
	const beforeInputEvent = createBeforeInputEvent(dataTransfer);
	target.dispatchEvent(beforeInputEvent);

	const pasteEvent = createPasteEvent(dataTransfer);
	return target.dispatchEvent(pasteEvent);
}

function pasteFilesIntoGemini(files) {
	if (isGeminiGuestUploadBlocked()) {
		throw new Error('Gemini guest mode does not allow file upload; sign in first');
	}

	const inputArea = document.querySelector('input-area-v2');
	if (!inputArea) {
		throw new Error('Could not find input-area-v2');
	}

	const editor = getGeminiEditor();
	const dataTransfer = new DataTransfer();

	for (const [index, file] of files.entries()) {
		const contentType = String(file?.contentType ?? file?.content_type ?? 'application/octet-stream');
		const bytes = decodeBase64ToBytes(file?.bytes ?? '');
		const extension = inferFileExtension(contentType);
		const blobFile = new File([bytes], `attachment-${index + 1}.${extension}`, {
			type: contentType,
		});
		dataTransfer.items.add(blobFile);
	}

	editor.focus();
	moveCaretToEnd(editor);

	const dispatchedOnEditor = dispatchSyntheticFilePaste(editor, dataTransfer);
	const dispatchedOnInputArea = dispatchSyntheticFilePaste(inputArea, dataTransfer);
	if (!dispatchedOnEditor && !dispatchedOnInputArea) {
		throw new Error('Paste event was cancelled');
	}

	return files.length;
}

function findSendButton() {
	// Try standard English
	let btn = document.querySelector('button[aria-label="Send message"]');
	if (btn) return btn;

	// Try common translations
	btn = document.querySelector('button[aria-label*="Send"], button[aria-label*="send"], button[aria-label*="Envoyer"], button[aria-label*="envoyer"], button[aria-label*="Enviar"], button[aria-label*="enviar"], button[aria-label*="Senden"], button[aria-label*="senden"]');
	if (btn) return btn;

	// Fallback to input area buttons
	const inputArea = document.querySelector('input-area-v2') || document.querySelector('input-area');
	if (inputArea) {
		const buttons = Array.from(inputArea.querySelectorAll('button'));
		for (const b of buttons) {
			const label = (b.getAttribute('aria-label') || '').toLowerCase();
			if (label.includes('send') || label.includes('envoyer') || label.includes('enviar') || label.includes('senden') || label.includes('submit')) {
				return b;
			}
		}
		if (buttons.length > 0) {
			return buttons[buttons.length - 1];
		}
	}
	return null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!message) {
		return;
	}

	if (message.type === 'gemini-inject-prompt') {
		try {
			if (isGeminiGuestUploadBlocked()) {
				throw new Error('User is not signed in to Gemini. Please sign in first.');
			}
			const editor = getGeminiEditor();
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

	if (message.type === 'gemini-paste-files') {
		try {
			const files = Array.isArray(message.files) ? message.files : [];
			const count = pasteFilesIntoGemini(files);
			sendResponse({ success: true, count });
		} catch (e) {
			sendResponse({ success: false, error: String(e) });
		}
		return true;
	}

	if (message.type === 'gemini-click-send') {
		try {
			const button = findSendButton();
			if (!button) {
				sendResponse({ success: false, error: 'Could not find the Send button' });
				return true;
			}
			button.click();
			sendResponse({ success: true });
		} catch (e) {
			sendResponse({ success: false, error: String(e) });
		}
		return true;
	}

	if (message.type === 'gemini-can-send') {
		const button = findSendButton();
		sendResponse({
			canSend: Boolean(button) && button.getAttribute('aria-disabled') !== 'true',
		});
		return true;
	}
});

window.addEventListener("message", (event) => {
	if (event.source !== window) return;
	const message = event.data;
	if (message && message.type === "gemini-stream-chunk") {
		chrome.runtime.sendMessage({
			type: "gemini-stream-chunk",
			body: message.body,
			done: message.done
		}).catch(() => {});
	}
});

