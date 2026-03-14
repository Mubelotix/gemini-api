console.log('[gemini-proxy-extension] content script injected on', window.location.href);

// ---- Isolated Gemini response markdown extractor ----

function domToMarkdown(node) {
	if (node.nodeType === Node.TEXT_NODE) {
		return node.textContent;
	}
	if (node.nodeType !== Node.ELEMENT_NODE) {
		return '';
	}

	const tag = node.tagName.toLowerCase();
	const childMd = () => Array.from(node.childNodes).map(domToMarkdown).join('');

	switch (tag) {
		case 'p':      return childMd().trim() + '\n\n';
		case 'h1':     return '# '      + childMd().trim() + '\n\n';
		case 'h2':     return '## '     + childMd().trim() + '\n\n';
		case 'h3':     return '### '    + childMd().trim() + '\n\n';
		case 'h4':     return '#### '   + childMd().trim() + '\n\n';
		case 'h5':     return '##### '  + childMd().trim() + '\n\n';
		case 'h6':     return '###### ' + childMd().trim() + '\n\n';
		case 'strong':
		case 'b':      return '**' + childMd() + '**';
		case 'em':
		case 'i':      return '*' + childMd() + '*';
		case 'code':
			if (node.closest('pre')) return node.textContent;
			return '`' + node.textContent + '`';
		case 'pre': {
			const codeEl = node.querySelector('code');
			const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] ?? '';
			return '```' + lang + '\n' + (codeEl ?? node).textContent + '\n```\n\n';
		}
		case 'ul':
			return Array.from(node.children)
				.filter(el => el.tagName.toLowerCase() === 'li')
				.map(li => '- ' + domToMarkdown(li).trim())
				.join('\n') + '\n\n';
		case 'ol': {
			const start = parseInt(node.getAttribute('start') ?? '1', 10);
			return Array.from(node.children)
				.filter(el => el.tagName.toLowerCase() === 'li')
				.map((li, i) => `${start + i}. ` + domToMarkdown(li).trim())
				.join('\n') + '\n\n';
		}
		case 'li':  return childMd();
		case 'a':   return '[' + childMd() + '](' + (node.getAttribute('href') ?? '') + ')';
		case 'hr':  return '\n---\n\n';
		case 'br':  return '\n';
		default:    return childMd();
	}
}

function extractGeminiResponseMarkdown() {
	const containers = document.querySelectorAll('structured-content-container');
	if (!containers.length) throw new Error('No structured-content-container found');
	const container = containers[containers.length - 1];
	// Locate the rendered content div via its aria-live attribute (semantic, stable across updates).
	const contentEl = container.querySelector('[aria-live]') ?? container;
	return domToMarkdown(contentEl).trim();
}

// ---- End markdown extractor ----

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

	if (message.type === 'gemini-get-response-markdown') {
		try {
			sendResponse({ markdown: extractGeminiResponseMarkdown() });
		} catch (e) {
			sendResponse({ markdown: null, error: String(e) });
		}
		return true;
	}
});
