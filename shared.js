/* Shared between the isolated content script and the extension window. No network access. */
(() => {
  'use strict';
  if (globalThis.TavernCompanion?.version === 2) return;
  const allowed = new Set(['P', 'DIV', 'SPAN', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL',
    'BLOCKQUOTE', 'PRE', 'CODE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'DETAILS', 'SUMMARY', 'SUP', 'SUB', 'A']);
  const drop = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE',
    'NOSCRIPT', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'AUDIO', 'VIDEO', 'IMG', 'FORM']);

  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return (value >>> 0).toString(36);
  }

  // Rebuild an allowlisted DOM. Attributes, media and embedded scripts never cross the bridge.
  function safeFragment(source, targetDocument = document, excluded = new Set()) {
    const fragment = targetDocument.createDocumentFragment();
    function copy(node, parent) {
      if (node.nodeType === 3) { parent.append(targetDocument.createTextNode(node.textContent)); return; }
      if (node.nodeType !== 1 || excluded.has(node) || drop.has(node.tagName)) return;
      if (!allowed.has(node.tagName)) {
        for (const child of node.childNodes) copy(child, parent);
        return;
      }
      const clean = targetDocument.createElement(node.tagName.toLowerCase());
      if (node.tagName === 'A') {
        try {
          // Only absolute links survive, preventing relative links from targeting the extension.
          const url = new URL(node.getAttribute('href') || '');
          if (['https:', 'http:'].includes(url.protocol)) {
            clean.href = url.href;
            clean.target = '_blank';
            clean.rel = 'noopener noreferrer';
          }
        } catch { /* Render unsafe/relative links as text. */ }
      }
      if (node.tagName === 'OL' && /^\d{1,6}$/.test(node.getAttribute('start') || '')) {
        clean.setAttribute('start', node.getAttribute('start'));
      }
      for (const child of node.childNodes) copy(child, clean);
      parent.append(clean);
    }
    for (const child of source.childNodes) copy(child, fragment);
    return fragment;
  }

  function safeHTML(source) {
    const box = document.createElement('div');
    box.append(safeFragment(source));
    return box.innerHTML;
  }

  function readableText(source) {
    const blocks = new Set(['P', 'DIV', 'PRE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'DETAILS']);
    function read(node) {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1 && node.nodeType !== 11) return '';
      if (node.tagName === 'BR' || node.tagName === 'HR') return '\n';
      const text = Array.from(node.childNodes, read).join('');
      return blocks.has(node.tagName) ? `\n${text}\n` : text;
    }
    return read(source).replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractMessage(source, settings = {}) {
    const excluded = new Set();
    if (settings.filterFrontend !== false) {
      for (const node of source.querySelectorAll('.TH-render, .TH-collapse-code-block-button, iframe')) excluded.add(node);
      for (const code of source.querySelectorAll('pre code')) {
        const known = code.classList.contains('custom-html') && code.classList.contains('custom-language-html');
        const documentCode = /<(?:!doctype\s+html|html(?:\s|>)|head(?:\s|>)|body(?:\s|>))/i.test(code.textContent)
          && /<(?:style|script)(?:\s|>)/i.test(code.textContent);
        const htmlClass = /(?:^|\s)(?:language-html|custom-language-html|custom-html)(?:\s|$)/.test(code.className);
        const componentCode = htmlClass && /<(?:style|script)(?:\s|>)/i.test(code.textContent)
          && /<(?:div|section|main|button|input|form|iframe)(?:\s|>)/i.test(code.textContent);
        if (known || documentCode || componentCode) excluded.add(code.closest('pre'));
      }
      for (const selector of globalThis.TavernConfig?.selectors(settings.extraSelectors) || []) {
        for (const node of source.querySelectorAll(selector)) excluded.add(node);
      }
    }
    const box = document.createElement('div');
    box.append(safeFragment(source, document, excluded));
    const filteredParts = Array.from(excluded).filter(node => !Array.from(excluded).some(parent => parent !== node && parent.contains(node))).length;
    return { html: box.innerHTML, text: readableText(box), filteredParts };
  }

  function renderHTML(html, text) {
    // A template is inert; its contents are rebuilt before they reach the visible document.
    const template = document.createElement('template');
    template.innerHTML = typeof html === 'string' ? html : '';
    const fragment = safeFragment(template.content);
    if (!fragment.hasChildNodes()) fragment.append(document.createTextNode(text || ''));
    return fragment;
  }

  globalThis.TavernCompanion = Object.freeze({ version: 2, hash, safeHTML, renderHTML, extractMessage });
})();
