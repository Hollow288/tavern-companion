(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const { renderHTML } = globalThis.TavernCompanion;
  const Config = globalThis.TavernConfig;
  let settings = Config.defaults;
  let savingSettings = false;
  let noticeTimer = null;
  const pending = new Map();
  let port = null;
  let reconnectTimer = null;
  let reconnectDelay = 600;
  let selectedTabId = null;
  let snapshot = null;
  let live = false;
  let inFlight = false;
  let polling = false;
  let listing = false;
  let initialized = false;
  let mode = 'latest';
  let draftKey = null;
  let draftReady = false;
  let renderKey = '';
  let follow = true;
  let fontSize = 0;
  let connectionEpoch = 0;
  let newestObservation = 0;
  let tabs = [];
  let deleteTarget = null;

  function status(text, kind = '') {
    $('status').dataset.kind = kind;
    $('status').lastElementChild.textContent = text;
  }

  function notice(text, kind = 'info') {
    clearTimeout(noticeTimer);
    $('notice').hidden = !text;
    $('notice').textContent = text;
    $('notice').dataset.kind = kind;
    if (text && kind === 'info') noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 3000);
  }

  function failConnection(error) {
    live = false;
    status(snapshot ? '连接断开 · 显示上次内容' : '尚未连接', 'error');
    $('connectionHint').textContent = error;
    $('connectionHint').hidden = false;
    $('openTarget').hidden = tabs.length > 0;
    $('openTarget').textContent = settings.origins.length ? '打开酒馆并登录 ↗' : '设置监听地址';
    updateControls();
  }

  function request(op, args = {}) {
    return new Promise((resolve, reject) => {
      if (!port) { reject(new Error('正在重新连接插件后台，请稍候。')); return; }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(op === 'ACTION' ? '未收到操作结果，请检查原页后再操作。' : '连接超时，请打开原页检查。'));
      }, op === 'ACTION' ? 15000 : 8000);
      pending.set(id, { resolve, reject, timer });
      try { port.postMessage({ id, op, ...args }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }

  function connect() {
    clearTimeout(reconnectTimer);
    try { port = chrome.runtime.connect({ name: 'tavern-ui' }); }
    catch { retry(); return; }
    const current = port;
    current.onMessage.addListener(message => {
      if (message.id) {
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (!message.result?.ok) entry.reject(new Error(message.result?.error || '页面未返回结果。'));
        else entry.resolve(message.result);
        return;
      }
      if (message.event === 'STATE' && message.tabId === selectedTabId) applyState(message.state);
      if (message.event === 'SETTINGS_CHANGED') {
        settings = Config.normalizeSettings(message.settings);
        renderKey = '';
        void loadTabs().then(() => refreshState());
      }
      if (message.event === 'TAB_REMOVED' && message.tabId === selectedTabId) {
        connectionEpoch++;
        failConnection('酒馆标签页已关闭。请重新打开，或选择其他酒馆标签页。');
      }
      if (message.event === 'TABS_CHANGED' || message.event === 'TAB_REMOVED') void loadTabs();
    });
    current.onDisconnect.addListener(() => {
      // Reading lastError consumes Chrome's diagnostic message for an expected disconnect.
      void chrome.runtime.lastError;
      if (port !== current) return;
      port = null;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('后台连接中断。发送类操作不会自动重试，请检查原页。'));
      }
      pending.clear();
      failConnection('插件后台暂时断开，正在自动恢复连接。');
      retry();
    });
    reconnectDelay = 600;
    void request('GET_SETTINGS').then(result => { settings = Config.normalizeSettings(result.settings); })
      .catch(() => {}).then(() => loadTabs()).then(() => refreshState());
  }

  function retry() {
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  }

  async function loadTabs() {
    if (listing || !port) return;
    listing = true;
    try {
      const result = await request('LIST_TABS');
      tabs = result.tabs;
      const selector = $('target');
      selector.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = tabs.length ? '选择要连接的酒馆标签页'
        : settings.origins.length ? '未找到酒馆标签页' : '尚未设置监听地址';
      selector.append(placeholder);
      for (const tab of tabs) {
        const option = document.createElement('option');
        option.value = String(tab.id);
        option.textContent = `${tab.title} · #${tab.id}${tab.discarded ? '（已休眠）' : ''}`;
        selector.append(option);
      }
      // Only auto-select on first use with exactly one candidate. Never silently replace a closed target.
      if (!initialized && selectedTabId === null && tabs.length === 1) {
        selectedTabId = tabs[0].id;
        void chrome.storage.local.set({ selectedTabId }).catch(() => {});
      }
      initialized = true;
      selector.value = tabs.some(tab => tab.id === selectedTabId) ? String(selectedTabId) : '';
      $('openTarget').hidden = tabs.length > 0;
      if (!tabs.some(tab => tab.id === selectedTabId)) {
        failConnection(!settings.origins.length ? '请先在设置中填写监听地址并允许访问。'
          : tabs.length ? '请选择要控制的酒馆标签页。原目标不可用时不会自动切换。'
          : '请先在 Chrome 中打开酒馆并登录，然后回到这个小窗。');
      }
      updateControls();
    } catch (error) { failConnection(error.message); }
    finally { listing = false; }
  }

  async function refreshState() {
    if (polling || !port || !Number.isInteger(selectedTabId)) return;
    polling = true;
    const id = selectedTabId;
    const epoch = connectionEpoch;
    try {
      const result = await request('GET_STATE', { tabId: id });
      if (id === selectedTabId && epoch === connectionEpoch) applyState(result.state);
    } catch (error) {
      if (id === selectedTabId && epoch === connectionEpoch) failConnection(error.message);
    } finally {
      polling = false;
      if (id !== selectedTabId || epoch !== connectionEpoch) void refreshState();
    }
  }

  function draftStorageKey(state) { return `draft:${selectedTabId}:${state.chatKey}`; }

  function changeDraft(state) {
    const nextKey = state.chatKey ? draftStorageKey(state) : null;
    if (nextKey === draftKey) return;
    draftKey = nextKey;
    draftReady = false;
    $('draft').value = '';
    $('draftState').textContent = '正在读取本机草稿…';
    if (!nextKey) { $('draftState').textContent = '选择聊天后可输入'; return; }
    chrome.storage.local.get(nextKey).then(result => {
      if (draftKey !== nextKey) return;
      $('draft').value = typeof result[nextKey] === 'string' ? result[nextKey] : '';
      draftReady = true;
      $('draftState').textContent = $('draft').value ? '已恢复此聊天的本机草稿' : '草稿仅保存在本机';
      updateControls();
    }).catch(() => {
      if (draftKey !== nextKey) return;
      draftReady = true;
      $('draftState').textContent = '草稿读取失败，可继续输入';
      updateControls();
    });
  }

  function saveDraft() {
    if (!draftKey || !draftReady) return;
    const text = $('draft').value;
    const key = draftKey;
    const task = text ? chrome.storage.local.set({ [key]: text }) : chrome.storage.local.remove(key);
    $('draftState').textContent = text ? '正在保存草稿…' : '草稿仅保存在本机';
    task.then(() => {
      if (key === draftKey && text === $('draft').value) $('draftState').textContent = text ? '草稿已保存在本机' : '草稿仅保存在本机';
    }).catch(() => { if (key === draftKey) $('draftState').textContent = '草稿保存失败，请保留输入内容'; });
  }

  function applyState(state) {
    if (!state || state.version !== 1 || !Array.isArray(state.messages) || state.observedAt < newestObservation) return;
    if (snapshot?.chatKey !== state.chatKey) {
      renderKey = '';
      follow = true;
    }
    newestObservation = state.observedAt;
    snapshot = state;
    live = !!state.ready;
    if (live) {
      $('connectionHint').hidden = true;
      status(state.busy ? '正在生成回复' : state.pending ? '等待页面响应' : '已连接', state.busy || state.pending ? 'busy' : 'ready');
    } else {
      status('等待选择聊天', 'error');
      $('connectionHint').textContent = '请在原页完成登录并选择聊天。未识别到聊天标识时，插件不会发送消息。';
      $('connectionHint').hidden = false;
    }
    $('count').textContent = `${state.loadedCount} 条已加载消息`;
    $('historyCount').textContent = String(state.messages.length);
    $('activity').textContent = state.busy ? '正在同步生成内容…' : state.chatName;
    $('activity').title = state.chatName;
    $('reader').setAttribute('aria-busy', String(state.busy));
    changeDraft(state);
    renderMessages();
    updateControls();
  }

  function latestReply() { return snapshot?.messages.findLast(message => message.role === 'assistant'); }

  function renderMessages(force = false) {
    const key = `${mode}:${snapshot?.revision || ''}:${snapshot?.filterFrontend}:${settings.extraSelectors}`;
    if (!force && key === renderKey) return;
    const firstRender = !renderKey;
    renderKey = key;
    const reader = $('reader');
    const oldScroll = reader.scrollTop;
    const wasFollowing = follow;
    const list = mode === 'history' ? snapshot?.messages || [] : latestReply() ? [latestReply()] : [];
    const fragment = document.createDocumentFragment();
    for (const message of list) {
      const article = document.createElement('article');
      article.className = 'message';
      article.dataset.role = message.role;
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const name = document.createElement('span');
      name.className = 'message-name';
      name.textContent = message.name;
      const role = document.createElement('span');
      role.className = 'role-label';
      role.textContent = message.role === 'assistant' ? `AI · #${message.id}` : message.role === 'user' ? '你' : '系统';
      const time = document.createElement('span');
      time.className = 'message-time';
      time.textContent = message.time;
      meta.append(name, role, time);
      const body = document.createElement('div');
      body.className = 'message-body';
      if (message.role === 'user') body.textContent = message.text;
      else body.append(renderHTML(message.html, message.text));
      if (!message.text && !body.textContent) body.textContent = message.filteredParts
        ? '这条回复只包含已识别的小前端，已按设置隐藏。可在设置中关闭过滤。'
        : snapshot?.busy ? '正在等待内容…' : '这条消息没有可展示的正文。';
      article.append(meta, body);
      if (message.filteredParts) {
        const note = document.createElement('p');
        note.className = 'filtered-note';
        note.textContent = `已过滤 ${message.filteredParts} 处小前端 · 可在设置中关闭`;
        article.append(note);
      }
      fragment.append(article);
    }
    $('messages').replaceChildren(fragment);
    $('empty').hidden = list.length > 0;
    $('empty').querySelector('h2').textContent = snapshot?.ready ? '还没有 AI 回复' : '对话即将出现在这里';
    $('empty').querySelector('p').textContent = snapshot?.ready ? '输入消息并发送，新的回复会同步到这里。' : '保持酒馆页面打开，随时在这个小窗继续聊天。';
    $('historyNote').hidden = mode !== 'history' || !list.length;
    $('historyNote').textContent = snapshot?.truncated
      ? `当前展示最近 ${list.length} 条记录；页面已加载 ${snapshot.loadedCount} 条。为保持流畅，小窗最多展示 500 条 / 约 200 万字符。`
      : '显示原页已加载的聊天记录；不含未加载的历史和其他回复分支。';
    if (firstRender && mode === 'latest' && !snapshot?.busy) {
      reader.scrollTop = 0;
      follow = reader.scrollHeight - reader.clientHeight < 70;
    } else if (wasFollowing) reader.scrollTop = reader.scrollHeight;
    else reader.scrollTop = oldScroll;
    updateFollow();
  }

  function updateFollow() { $('toBottom').textContent = follow ? '已跟随最新 ↓' : '跟随最新 ↓'; }

  function updateControls() {
    const connected = live && port && snapshot;
    const available = connected && !inFlight && !snapshot.pending;
    $('send').disabled = !available || !snapshot.canSend || !draftReady || !$('draft').value.trim();
    $('regenerate').disabled = !available || snapshot.busy || snapshot.lastRole !== 'assistant' || !latestReply();
    $('deleteRow').hidden = snapshot?.lastRole !== 'user';
    $('deleteLastUser').disabled = !available || snapshot.busy || !snapshot.canDeleteLastUser;
    $('deleteLastUser').title = !connected ? '请先连接酒馆聊天。'
      : snapshot.busy ? '请等待生成完成或先停止。'
      : !snapshot.canDeleteLastUser ? '原页删除操作不可用；更新扩展后请刷新酒馆原页。' : '删除当前聊天最后一条自己的消息';
    $('stop').hidden = !snapshot?.busy;
    $('stop').disabled = !connected || !snapshot.busy || inFlight;
    // Drafts remain editable during generation and temporary disconnects for the same chat.
    $('draft').disabled = !draftReady || inFlight;
    $('focusTarget').disabled = !Number.isInteger(selectedTabId) || !tabs.some(tab => tab.id === selectedTabId);
    $('copy').disabled = !latestReply()?.text?.trim();
    $('target').disabled = inFlight;
    $('draftHint').hidden = !connected || !snapshot.hasPageDraft;
    $('draftHint').textContent = '原页输入框有草稿；内容不一致时，插件会阻止覆盖。';
    $('send').textContent = inFlight ? '处理中' : '发送';
    $('regenerate').hidden = !!snapshot?.busy;
    $('settingsButton').disabled = inFlight;
  }

  async function perform(action, deletion = null) {
    if (!live || !snapshot || inFlight) return;
    const source = deletion?.source || { tabId: selectedTabId, chatKey: snapshot.chatKey, revision: snapshot.revision };
    const text = $('draft').value;
    const sourceDraft = draftKey;
    inFlight = true;
    notice('');
    updateControls();
    try {
      const result = await request('ACTION', { ...source, action, text: action === 'send' ? text : undefined });
      if (source.tabId === selectedTabId) applyState(result.state);
      if (action === 'send' && result.confirmed && sourceDraft === draftKey && $('draft').value === text) {
        $('draft').value = '';
        saveDraft();
      }
      let message = result.message || '操作已触发。';
      if (action === 'deleteLastUser' && result.confirmed && source.tabId === selectedTabId
          && source.chatKey === snapshot?.chatKey && sourceDraft === draftKey && draftReady && !$('draft').value) {
        $('draft').value = deletion.text;
        saveDraft();
        message += ' 文字已放回输入框，可修改后重新发送。';
      }
      notice(message, result.confirmed ? 'info' : 'warning');
    } catch (error) { notice(error.message, 'error'); }
    finally {
      inFlight = false;
      updateControls();
      void refreshState();
    }
  }

  async function selectTarget(id) {
    connectionEpoch++;
    selectedTabId = Number.isInteger(id) ? id : null;
    snapshot = null;
    newestObservation = 0;
    live = false;
    draftKey = null;
    draftReady = false;
    renderKey = '';
    $('draft').value = '';
    $('count').textContent = '—';
    $('historyCount').textContent = '0';
    $('activity').textContent = '只在本机同步';
    renderMessages(true);
    notice('');
    status('正在连接');
    updateControls();
    void chrome.storage.local.set({ selectedTabId }).catch(() => {});
    if (selectedTabId === null) {
      failConnection('请选择要控制的酒馆标签页。');
      return;
    }
    // A read for the old target can still be in flight; refresh again after it settles.
    if (polling) setTimeout(() => void refreshState(), 500);
    else await refreshState();
  }

  $('target').addEventListener('change', () => void selectTarget($('target').value ? Number($('target').value) : null));
  $('draft').addEventListener('input', () => { saveDraft(); updateControls(); });
  $('draft').addEventListener('keydown', event => {
    if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!$('send').disabled) void perform('send');
    }
  });
  $('send').addEventListener('click', () => void perform('send'));
  $('regenerate').addEventListener('click', () => void perform('regenerate'));
  $('deleteLastUser').addEventListener('click', () => {
    if ($('deleteLastUser').disabled) return;
    const last = snapshot.messages.at(-1);
    if (last?.role !== 'user' || last.id !== snapshot.lastMessageId) return;
    deleteTarget = { source: { tabId: selectedTabId, chatKey: snapshot.chatKey,
      revision: snapshot.revision, messageId: last.id }, text: last.text };
    $('deletePreview').textContent = last.text || '（这条消息没有可读取的文字）';
    $('deleteDialog').showModal();
    $('cancelDelete').focus();
  });
  $('cancelDelete').addEventListener('click', () => $('deleteDialog').close());
  $('deleteDialog').addEventListener('close', () => { deleteTarget = null; });
  $('confirmDelete').addEventListener('click', () => {
    const deletion = deleteTarget;
    $('deleteDialog').close();
    if (deletion) void perform('deleteLastUser', deletion);
  });
  $('stop').addEventListener('click', () => void perform('stop'));
  $('refresh').addEventListener('click', () => { void loadTabs().then(() => refreshState()); });
  $('focusTarget').addEventListener('click', () => request('FOCUS_TARGET', { tabId: selectedTabId }).catch(error => notice(error.message, 'error')));
  $('openTarget').addEventListener('click', async () => {
    if (!settings.origins.length) { $('settingsButton').click(); return; }
    try {
      const result = await request('OPEN_TARGET');
      await selectTarget(result.tabId);
      await loadTabs();
    } catch (error) { notice(error.message, 'error'); }
  });
  for (const [id, view] of [['latestTab', 'latest'], ['historyTab', 'history']]) {
    $(id).addEventListener('click', () => {
      mode = view;
      $('latestTab').classList.toggle('selected', mode === 'latest');
      $('historyTab').classList.toggle('selected', mode === 'history');
      $('latestTab').setAttribute('aria-pressed', String(mode === 'latest'));
      $('historyTab').setAttribute('aria-pressed', String(mode === 'history'));
      follow = mode === 'history';
      renderMessages(true);
      if (mode === 'latest') { $('reader').scrollTop = 0; follow = $('reader').scrollHeight - $('reader').clientHeight < 70; updateFollow(); }
    });
  }
  $('reader').addEventListener('scroll', () => {
    follow = $('reader').scrollHeight - $('reader').scrollTop - $('reader').clientHeight < 70;
    updateFollow();
  }, { passive: true });
  $('toBottom').addEventListener('click', () => {
    follow = true;
    $('reader').scrollTop = $('reader').scrollHeight;
    updateFollow();
  });
  $('copy').addEventListener('click', async () => {
    const message = latestReply();
    if (!message) return;
    try { await navigator.clipboard.writeText(message.text); notice('最新回复已复制。'); }
    catch { notice('复制失败，可直接选中正文复制。', 'warning'); }
  });
  $('fontSize').addEventListener('click', () => {
    fontSize = (fontSize + 1) % 3;
    document.documentElement.dataset.fontSize = String(fontSize);
    void chrome.storage.local.set({ fontSize }).catch(() => {});
  });

  $('settingsButton').addEventListener('click', () => {
    $('filterFrontend').checked = settings.filterFrontend;
    $('listeningOrigins').value = settings.origins.join('\n');
    $('extraSelectors').value = settings.extraSelectors;
    $('settingsError').hidden = true;
    $('settingsDialog').showModal();
  });
  const closeSettings = () => { if (!savingSettings) $('settingsDialog').close(); };
  $('closeSettings').addEventListener('click', closeSettings);
  $('cancelSettings').addEventListener('click', closeSettings);
  $('settingsDialog').addEventListener('cancel', event => { if (savingSettings) event.preventDefault(); });
  $('settingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (savingSettings) return;
    $('settingsError').hidden = true;
    let next;
    try {
      next = Config.normalizeSettings({ origins: Config.normalizeOrigins($('listeningOrigins').value),
        filterFrontend: $('filterFrontend').checked, extraSelectors: $('extraSelectors').value });
      for (const selector of Config.selectors(next.extraSelectors)) document.createElement('div').querySelectorAll(selector);
    } catch (error) {
      $('settingsError').textContent = error.message;
      $('settingsError').hidden = false;
      return;
    }
    savingSettings = true;
    $('saveSettings').disabled = true;
    $('closeSettings').disabled = true;
    $('cancelSettings').disabled = true;
    try {
      // Called directly from the submit gesture; Chrome asks only for the submitted site patterns.
      const origins = Config.patterns(next.origins);
      const granted = !origins.length || await chrome.permissions.request({ origins });
      if (!granted) throw new Error('未获得站点访问权限，设置没有更改。');
      const result = await request('SAVE_SETTINGS', { settings: next });
      settings = Config.normalizeSettings(result.settings);
      connectionEpoch++;
      live = false;
      renderKey = '';
      $('settingsDialog').close();
      await loadTabs();
      if (tabs.some(tab => tab.id === selectedTabId)) await refreshState();
      notice('设置已保存。');
    } catch (error) {
      $('settingsError').textContent = error.message;
      $('settingsError').hidden = false;
    } finally {
      savingSettings = false;
      $('saveSettings').disabled = false;
      $('closeSettings').disabled = false;
      $('cancelSettings').disabled = false;
      updateControls();
    }
  });

  // No persistent chat cache: transcripts stay in this window's memory only.
  chrome.storage.local.get(['selectedTabId', 'fontSize']).then(preferences => {
    selectedTabId = Number.isInteger(preferences.selectedTabId) ? preferences.selectedTabId : null;
    fontSize = [0, 1, 2].includes(preferences.fontSize) ? preferences.fontSize : 0;
    document.documentElement.dataset.fontSize = String(fontSize);
  }).catch(() => {}).finally(() => {
    connect();
    setInterval(() => void refreshState(), 5000);
    setInterval(() => void loadTabs(), 15000);
  });
  updateControls();
})();
