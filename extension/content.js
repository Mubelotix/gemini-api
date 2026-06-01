console.log('[gemini-proxy-extension] content script injected on', window.location.href);

// ---- Isolated Gemini response markdown extractor ----

function normalizeFenceLanguage(label) {
	const normalized = String(label ?? '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
	if (!/^[a-z0-9_+#-]{1,20}$/.test(normalized)) {
		return '';
	}
	if (/^(copy|code|copycode)$/.test(normalized)) {
		return '';
	}
	return normalized;
}

function detectCodeBlockLanguage(codeBlockEl, codeEl, preEl) {
	const classLang = codeEl?.className?.match(/(?:^|\s)language-([a-zA-Z0-9_+#-]+)/)?.[1];
	if (classLang) {
		return classLang.toLowerCase();
	}

	if (!preEl) {
		return '';
	}

	for (const span of Array.from(codeBlockEl.querySelectorAll('span'))) {
		const relation = span.compareDocumentPosition(preEl);
		if (!(relation & Node.DOCUMENT_POSITION_FOLLOWING)) {
			continue;
		}

		const lang = normalizeFenceLanguage(span.textContent);
		if (lang) {
			return lang;
		}
	}

	return '';
}

function extractCodeBlockMarkdown(codeBlockEl) {
	const preEl = codeBlockEl.querySelector('pre');
	if (!preEl) {
		return Array.from(codeBlockEl.childNodes).map(domToMarkdown).join('');
	}

	const codeEl = preEl.querySelector('code');
	const language = detectCodeBlockLanguage(codeBlockEl, codeEl, preEl);
	const source = (codeEl ?? preEl).textContent ?? '';
	const body = source.replace(/\n+$/, '');

	if (!body.trim()) {
		return '';
	}

	return '```' + language + '\n' + body + '\n```\n\n';
}

function normalizeTableCellMarkdown(value) {
	return String(value ?? '')
		.trim()
		.replace(/\s*\n\s*/g, '<br>')
		.replace(/\|/g, '\\|');
}

function extractTableRows(tableEl) {
	const rows = [];
	for (const child of Array.from(tableEl.children)) {
		const tag = child.tagName.toLowerCase();
		if (tag === 'tr') {
			rows.push(child);
			continue;
		}
		if (tag !== 'thead' && tag !== 'tbody' && tag !== 'tfoot') {
			continue;
		}

		for (const sectionChild of Array.from(child.children)) {
			if (sectionChild.tagName.toLowerCase() === 'tr') {
				rows.push(sectionChild);
			}
		}
	}

	return rows;
}

function extractRowCells(trEl) {
	return Array.from(trEl.children).filter((cellEl) => {
		const tag = cellEl.tagName.toLowerCase();
		return tag === 'td' || tag === 'th';
	});
}

function extractTableMarkdown(tableEl) {
	const rows = extractTableRows(tableEl);
	if (!rows.length) {
		return '';
	}

	const thead = Array.from(tableEl.children).find(
		(el) => el.tagName.toLowerCase() === 'thead',
	);
	let headerRow = null;
	if (thead) {
		headerRow = Array.from(thead.children).find((el) => el.tagName.toLowerCase() === 'tr') ?? null;
	}
	if (!headerRow) {
		headerRow = rows.find((trEl) => extractRowCells(trEl).length > 0) ?? null;
	}
	if (!headerRow) {
		return '';
	}

	const headerCells = extractRowCells(headerRow)
		.map((cellEl) => normalizeTableCellMarkdown(domToMarkdown(cellEl)))
		.filter((cellText) => cellText.length > 0);
	if (!headerCells.length) {
		return '';
	}

	const columnCount = headerCells.length;
	const markdownRows = [];
	markdownRows.push('| ' + headerCells.join(' | ') + ' |');
	markdownRows.push('| ' + Array(columnCount).fill('---').join(' | ') + ' |');

	for (const row of rows) {
		if (row === headerRow) {
			continue;
		}

		const rowCells = extractRowCells(row);
		if (!rowCells.length) {
			continue;
		}

		const values = rowCells
			.slice(0, columnCount)
			.map((cellEl) => normalizeTableCellMarkdown(domToMarkdown(cellEl)));
		while (values.length < columnCount) {
			values.push('');
		}

		markdownRows.push('| ' + values.join(' | ') + ' |');
	}

	return markdownRows.join('\n') + '\n\n';
}

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
		case 'code-block':
			return extractCodeBlockMarkdown(node);
		case 'table-block': {
			const tableEl = node.querySelector('table');
			return tableEl ? extractTableMarkdown(tableEl) : childMd();
		}
		case 'table':
			return extractTableMarkdown(node);
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
		case 'button':
		case 'mat-icon':
			return '';
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

function isGeminiResponding() {
	const stopButton = document.querySelector('button[aria-label="Stop response"]');
	if (!stopButton) {
		return false;
	}

	return stopButton.getAttribute('aria-disabled') !== 'true';
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
			if (isGeminiGuestUploadBlocked()) {
				throw new Error('User is not signed in to Gemini. Please sign in first.');
			}
			const editor = getGeminiEditor();
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

	if (message.type === 'gemini-can-send') {
		const button = document.querySelector('button[aria-label="Send message"]');
		sendResponse({
			canSend: Boolean(button) && button.getAttribute('aria-disabled') !== 'true',
		});
		return true;
	}

	if (message.type === 'gemini-get-innertext') {
		sendResponse({ innerText: document.documentElement?.innerText ?? document.body?.innerText ?? '' });
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

	if (message.type === 'gemini-is-responding') {
		sendResponse({ isResponding: isGeminiResponding() });
		return true;
	}
});
