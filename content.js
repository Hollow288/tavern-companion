(() => {
  'use strict';
  if (globalThis.__tavernCompanionV2) return;
  globalThis.__tavernCompanionV2 = true;
  const { hash, extractMessage, safeHTML } = globalThis.TavernCompanion;
  let settings = globalThis.TavernConfig.defaults;
  const configurationReady = chrome.storage.local.get('settings').then(result => {
    settings = globalThis.TavernConfig.normalizeSettings(result.settings);
  });
  const siteEnabled = () => settings.origins.includes(location.origin);
  const MAX_MESSAGES = 500;
  const MAX_CHARACTERS = 2000000;
  let watchUntil = 0;
  let updateTimer = null;
  let lastSignature = '';
  let pendingUntil = 0;
  let actionRunning = false;
  const completed = new Map();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = globalThis.TavernConfig.normalizeSettings(changes.settings.newValue);
    lastSignature = '';
    if (!siteEnabled()) watchUntil = 0;
    else schedule();
  });

  // Model-authored HTML can contain IDs/classes. Only controls outside the chat body are trusted.
  const control = id => Array.from(document.querySelectorAll(`[id="${id}"]`))
    .find(node => !node.closest('#chat')) || null;

  const visible = node => !!node && node.isConnected && node.getClientRects().length > 0
    && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
  const enabled = node => !!node && !node.disabled && node.getAttribute('aria-disabled') !== 'true'
    && !node.classList.contains('disabled');
  const busy = () => visible(control('mes_stop'));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  function identity() {
    const select = control('extensionTopBarChatName');
    const selected = select?.selectedOptions?.[0];
    const name = (selected?.textContent || select?.textContent || '').trim();
    // This site exposes a chat-file selector. On other layouts use explicit page metadata.
    const fallback = document.querySelector('#chat')?.getAttribute('data-chat-id') || '';
    const value = select?.value || fallback || name;
    return {
      name: name || '当前聊天',
      key: value ? hash(`${location.origin}${location.pathname}|${value}|${name}`) : null
    };
  }

  function readState() {
    const chat = document.getElementById('chat');
    const input = control('send_textarea');
    const send = control('send_but');
    const id = identity();
    const nodes = chat ? Array.from(chat.children).filter(node => node.matches('.mes[mesid]')) : [];
    const messages = [];
    const sourceRevisions = nodes.map(node => [node.getAttribute('mesid'), node.getAttribute('swipeid'),
      node.getAttribute('is_user'), node.getAttribute('is_system'), node.getAttribute('ch_name'),
      hash(node.querySelector('.mes_text') ? safeHTML(node.querySelector('.mes_text')) : '')]);
    let characters = 0;
    let truncated = nodes.length > MAX_MESSAGES;
    // Keep newest messages when a conversation is very large. Never truncate a single reply.
    for (const node of nodes.slice(-MAX_MESSAGES).reverse()) {
      const body = node.querySelector('.mes_text');
      if (!body) continue;
      const extracted = extractMessage(body, node.getAttribute('is_user') === 'true' ? { filterFrontend: false } : settings);
      const { html, text, filteredParts } = extracted;
      if (messages.length && characters + html.length + text.length > MAX_CHARACTERS) {
        truncated = true; break;
      }
      characters += html.length + text.length;
      messages.push({
        id: node.getAttribute('mesid'),
        swipe: node.getAttribute('swipeid') || '0',
        role: node.getAttribute('is_system') === 'true' ? 'system'
          : node.getAttribute('is_user') === 'true' ? 'user' : 'assistant',
        name: node.getAttribute('ch_name') || node.querySelector('.name_text')?.textContent?.trim() || '角色',
        time: node.getAttribute('timestamp') || node.querySelector('.timestamp')?.textContent?.trim() || '',
        text, html, filteredParts
      });
    }
    messages.reverse();
    const ready = !!chat && !!input && visible(input) && !!id.key;
    const generating = busy();
    const revision = hash(JSON.stringify({ key: id.key, sourceRevisions }));
    const state = {
      version: 1, chatKey: id.key, chatName: id.name, ready, busy: generating,
      filterFrontend: settings.filterFrontend,
      canSend: ready && enabled(input) && visible(send) && enabled(send) && !generating,
      hasPageDraft: !!input?.value?.trim(),
      pending: Date.now() < pendingUntil,
      messages, loadedCount: nodes.length, truncated, revision,
      lastRole: nodes.at(-1)?.getAttribute('is_user') === 'true' ? 'user'
        : nodes.at(-1)?.getAttribute('is_system') === 'true' ? 'system' : 'assistant',
      observedAt: Date.now()
    };
    state.signature = hash(JSON.stringify({ ...state, observedAt: 0 }));
    return state;
  }

  function publish() {
    updateTimer = null;
    if (!siteEnabled() || Date.now() > watchUntil) return;
    const state = readState();
    if (state.signature === lastSignature) return;
    lastSignature = state.signature;
    try {
      chrome.runtime.sendMessage({ type: 'TC_STATE_UPDATE', state }).catch(() => {});
    } catch { /* Extension may have been reloaded. A fresh script will reconnect. */ }
  }

  function schedule() {
    if (Date.now() > watchUntil || updateTimer !== null) return;
    updateTimer = setTimeout(publish, 220);
  }

  function assertChat(request, checkRevision = true) {
    if (!siteEnabled()) throw new Error('这个地址已不在监听设置中，操作已取消。');
    const state = readState();
    if (!state.ready) throw new Error('酒馆尚未就绪。请打开原页，登录并选择一个聊天。');
    if (!request.chatKey || state.chatKey !== request.chatKey) {
      throw new Error('原页面已切换聊天，操作已取消。请查看更新后的聊天再操作。');
    }
    if (checkRevision && state.revision !== request.revision) {
      throw new Error('聊天内容刚刚发生变化，操作已取消。请查看最新回复后再操作。');
    }
    return state;
  }

  async function waitFor(check, timeout = 1800) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (check()) return true;
      await pause(90);
    }
    return !!check();
  }

  async function act(request) {
    if (!['send', 'regenerate', 'stop'].includes(request.action)) throw new Error('不支持的操作。');
    if (actionRunning) throw new Error('上一个操作仍在处理，请稍候。');
    if (request.action !== 'stop' && Date.now() < pendingUntil) {
      throw new Error('刚刚已触发操作，请等待页面响应；不确定时请先检查原页。');
    }
    actionRunning = true;
    try {
      const before = assertChat(request, request.action !== 'stop');
      let confirmed = false;
      if (request.action === 'stop') {
        const stop = control('mes_stop');
        if (!visible(stop)) throw new Error('当前没有可停止的生成任务。');
        stop.click();
        confirmed = await waitFor(() => !busy());
        pendingUntil = 0;
      } else {
        if (before.busy) throw new Error('正在生成中，请等待完成或先停止。');
        if (request.action === 'send') {
          const text = typeof request.text === 'string' ? request.text : '';
          if (!text.trim()) throw new Error('请先输入消息。');
          if (text.length > 100000) throw new Error('消息超过 100,000 个字符，请分段发送。');
          const input = control('send_textarea');
          const send = control('send_but');
          if (!before.canSend || !visible(send) || !enabled(send)) throw new Error('发送按钮当前不可用，请检查原页的 API 连接。');
          if (input.value.trim() && input.value !== text) {
            throw new Error('原页面输入框已有其他草稿。请先处理原页草稿，插件不会覆盖它。');
          }
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          // Input listeners can change the active chat or control state: verify once more.
          assertChat(request);
          if (!visible(send) || !enabled(send) || busy()) throw new Error('页面状态发生变化，未点击发送。');
          pendingUntil = Date.now() + 6000;
          send.click();
          confirmed = await waitFor(() => {
            const now = readState();
            return now.chatKey === before.chatKey && (now.busy || now.messages.some(m =>
              m.role === 'user' && m.text.trim() === text.trim() && !before.messages.some(old => old.id === m.id)));
          });
        } else {
          if (before.lastRole !== 'assistant' || !before.messages.some(m => m.role === 'assistant')) {
            throw new Error('最后一条消息不是 AI 回复，请在原页检查聊天状态。');
          }
          let regenerate = control('option_regenerate');
          if (!regenerate) throw new Error('未找到重新生成菜单，请检查酒馆页面版本。');
          if (!visible(regenerate)) {
            const menu = control('options_button');
            if (!visible(menu)) throw new Error('未找到可用的聊天菜单按钮。');
            menu.click();
            await waitFor(() => visible(control('option_regenerate')), 900);
          }
          assertChat(request);
          regenerate = control('option_regenerate');
          if (!visible(regenerate) || !enabled(regenerate)) throw new Error('重新生成菜单当前不可用，请打开原页检查。');
          pendingUntil = Date.now() + 6000;
          regenerate.click();
          confirmed = await waitFor(() => {
            const now = readState();
            return now.chatKey === before.chatKey && (now.busy || now.revision !== before.revision);
          });
        }
        // A long generation is guarded by busy; a short one still gets a short click cooldown.
        if (confirmed) pendingUntil = Date.now() + 1200;
      }
      const state = readState();
      return { ok: true, triggered: true, confirmed, state,
        message: confirmed ? (request.action === 'stop' ? '生成已停止。' : request.action === 'send' ? '页面已开始处理消息。' : '页面已开始重新生成。')
          : '操作已触发，但页面尚未确认。请打开原页检查；不要立即重复点击。' };
    } finally {
      actionRunning = false;
      schedule();
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (request.type === 'TC_GET_STATE') {
      configurationReady.then(() => {
        if (request.settings) settings = globalThis.TavernConfig.normalizeSettings(request.settings);
        if (!siteEnabled()) { respond({ ok: false, error: '这个地址不在监听设置中。' }); return; }
        watchUntil = Date.now() + 20000;
        const state = readState();
        lastSignature = state.signature;
        respond({ ok: true, state });
      }).catch(error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (request.type !== 'TC_ACTION') return false;
    if (typeof request.requestId !== 'string' || request.requestId.length > 160) {
      respond({ ok: false, error: '操作编号无效。' }); return false;
    }
    // Repeated delivery returns the original result instead of clicking twice.
    if (!completed.has(request.requestId)) {
      completed.set(request.requestId, configurationReady.then(() => act(request)).catch(error => ({ ok: false, error: error.message })));
      if (completed.size > 64) completed.delete(completed.keys().next().value);
    }
    completed.get(request.requestId).then(respond);
    return true;
  });

  new MutationObserver(schedule).observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['style', 'class', 'disabled', 'aria-disabled', 'swipeid', 'is_user', 'is_system', 'mesid', 'ch_name', 'timestamp']
  });
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', schedule, true);
  // Also catches changes which do not produce DOM mutations, and expiry of pending state.
  setInterval(schedule, 1500);
})();
