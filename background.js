'use strict';
importScripts('config.js');
const Config = globalThis.TavernConfig;
const peers = new Set();
let opening = null;
let settings = Config.defaults;
const SCRIPT_ID = 'tavern-listener-v2';
let registrationQueue = Promise.resolve();

async function grantedPatterns(value) {
  const patterns = Config.patterns(value.origins);
  const granted = await Promise.all(patterns.map(async origin =>
    await chrome.permissions.contains({ origins: [origin] }) ? origin : null));
  return granted.filter(Boolean);
}

async function applyRegistration(value) {
  const matches = await grantedPatterns(value);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  const registration = { id: SCRIPT_ID, matches, js: ['config.js', 'shared.js', 'content.js'],
    runAt: 'document_idle', persistAcrossSessions: true, allFrames: false };
  if (existing.length) await chrome.scripting.updateContentScripts([registration]);
  else await chrome.scripting.registerContentScripts([registration]);
}

function syncRegistration(value) {
  const task = registrationQueue.catch(() => {}).then(() => applyRegistration(value));
  registrationQueue = task;
  return task;
}

const initialized = chrome.storage.local.get('settings').then(async result => {
  settings = Config.normalizeSettings(result.settings);
  await syncRegistration(settings);
}).catch(error => { console.warn('监听脚本初始化失败，将在读取时补注入：', error); });

function allowed(url) {
  try { const value = new URL(url); return settings.origins.includes(value.origin); }
  catch { return false; }
}

function notify(message) {
  for (const port of peers) {
    try { port.postMessage(message); } catch { peers.delete(port); }
  }
}

async function targetTab(id) {
  if (!Number.isInteger(id)) throw new Error('请先选择一个酒馆标签页。');
  let tab;
  try { tab = await chrome.tabs.get(id); }
  catch { throw new Error('酒馆标签页已关闭，请重新选择或打开酒馆。'); }
  if (!allowed(tab.url)) throw new Error('选中的标签页已离开这个酒馆网站，请重新选择。');
  return tab;
}

async function listTabs() {
  const patterns = await grantedPatterns(settings);
  const tabs = patterns.length ? await chrome.tabs.query({ url: patterns }) : [];
  return tabs.filter(tab => allowed(tab.url)).map(tab => ({ id: tab.id, windowId: tab.windowId, title: tab.title || 'SillyTavern',
    origin: new URL(tab.url).origin,
    active: tab.active, discarded: !!tab.discarded, loading: tab.status === 'loading' }));
}

async function readState(id) {
  const tab = await targetTab(id);
  if (tab.discarded) throw new Error('酒馆标签页已休眠。点击“打开原页”恢复，加载后会自动连接。');
  if (tab.status === 'loading') throw new Error('酒馆页面正在加载，请稍候。');
  let result;
  try { result = await chrome.tabs.sendMessage(id, { type: 'TC_GET_STATE', settings }, { frameId: 0 }); }
  catch {
    // Existing tabs predate installation. Injection is only retried for a read, never an action.
    try {
      await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, files: ['config.js', 'shared.js', 'content.js'] });
      result = await chrome.tabs.sendMessage(id, { type: 'TC_GET_STATE', settings }, { frameId: 0 });
    } catch { throw new Error('暂时无法连接酒馆。请打开原页确认已登录；更新插件后请刷新原页。'); }
  }
  if (!result?.ok || !result.state) throw new Error(result?.error || '页面未返回聊天数据。');
  return result;
}

async function focusTarget(id) {
  const tab = await targetTab(id);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  return { ok: true };
}

async function route(message) {
  await initialized;
  switch (message.op) {
    case 'GET_SETTINGS': return { ok: true, settings };
    case 'SAVE_SETTINGS': {
      const next = Config.normalizeSettings(message.settings);
      const patterns = await grantedPatterns(next);
      if (patterns.length !== Config.patterns(next.origins).length) throw new Error('尚未获得新站点的访问权限，请在设置里重新保存并允许访问。');
      await syncRegistration(next);
      const previous = settings;
      try { await chrome.storage.local.set({ settings: next }); }
      catch (error) { await syncRegistration(previous); throw error; }
      settings = next;
      const removed = Config.patterns(previous.origins).filter(pattern =>
        !Config.patterns(next.origins).includes(pattern));
      if (removed.length) await chrome.permissions.remove({ origins: removed }).catch(() => {});
      notify({ event: 'SETTINGS_CHANGED', settings });
      return { ok: true, settings };
    }
    case 'LIST_TABS': return { ok: true, tabs: await listTabs() };
    case 'GET_STATE': return readState(message.tabId);
    case 'FOCUS_TARGET': return focusTarget(message.tabId);
    case 'OPEN_TARGET': {
      if (!settings.origins.length) throw new Error('请先在设置中填写监听地址并允许访问。');
      const tab = await chrome.tabs.create({ url: settings.origins[0] + '/' });
      return { ok: true, tabId: tab.id };
    }
    case 'ACTION': {
      const tab = await targetTab(message.tabId);
      if (tab.discarded || tab.status === 'loading') throw new Error('原页正在加载或已休眠，请打开原页恢复后再操作。');
      if (!['send', 'regenerate', 'stop', 'deleteLastUser'].includes(message.action)) throw new Error('不支持的操作。');
      // Never auto-retry a mutating action: an uncertain acknowledgement is not a failed click.
      try {
        return await chrome.tabs.sendMessage(tab.id, {
          type: 'TC_ACTION', requestId: message.id, action: message.action,
          chatKey: message.chatKey, revision: message.revision, text: message.text, messageId: message.messageId
        }, { frameId: 0 });
      } catch { throw new Error('操作结果未收到，可能尚未执行或已在原页触发。请检查原页后再操作。'); }
    }
    default: throw new Error('未知请求。');
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'tavern-ui' || port.sender?.id !== chrome.runtime.id
      || port.sender?.url !== chrome.runtime.getURL('chat.html')) { port.disconnect(); return; }
  peers.add(port);
  port.onDisconnect.addListener(() => peers.delete(port));
  port.onMessage.addListener(message => {
    if (typeof message?.id !== 'string') return;
    Promise.resolve().then(() => route(message)).then(
      result => { try { port.postMessage({ id: message.id, result }); } catch {} },
      error => { try { port.postMessage({ id: message.id, result: { ok: false, error: error.message } }); } catch {} }
    );
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'TC_STATE_UPDATE' || sender.id !== chrome.runtime.id
      || sender.frameId !== 0 || !allowed(sender.url) || !sender.tab?.id) return false;
  if (message.state?.version === 1) notify({ event: 'STATE', tabId: sender.tab.id, state: message.state });
  return false;
});

chrome.tabs.onRemoved.addListener(id => notify({ event: 'TAB_REMOVED', tabId: id }));
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if ((change.url || change.status || change.discarded !== undefined) && (allowed(tab.url) || change.url)) {
    notify({ event: 'TABS_CHANGED', tabId: id });
  }
});

function permissionsChanged() {
  void initialized.then(() => syncRegistration(settings)).then(() => notify({ event: 'TABS_CHANGED' }))
    .catch(error => console.warn('站点权限变更：', error));
}
chrome.permissions.onAdded.addListener(permissionsChanged);
chrome.permissions.onRemoved.addListener(permissionsChanged);

async function openWindow() {
  const url = chrome.runtime.getURL('chat.html');
  const windows = await chrome.windows.getAll({ populate: true });
  const existing = windows.find(win => win.tabs?.some(tab => tab.url === url));
  if (existing) { await chrome.windows.update(existing.id, { focused: true }); return; }
  await chrome.windows.create({ url, type: 'popup', width: 530, height: 830, focused: true });
}

chrome.action.onClicked.addListener(() => {
  if (!opening) opening = openWindow().catch(error => console.error('无法打开酒馆随聊：', error))
    .finally(() => { opening = null; });
});
