// Run with: node --test tests/recovery.test.cjs (requires the playwright package and Chrome).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const settings = { origins: ['http://tavern.test'], filterFrontend: true, extraSelectors: '' };
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, options = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('http://tavern.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <div id="chat" data-chat-id="example"></div>
    <div id="options_button">Menu</div>
    <div id="options" style="display:none"><button id="option_delete_mes">Delete messages</button><button id="option_regenerate">Regenerate</button></div>
    <div id="dialogue_del_mes" style="display:none"><button id="dialogue_del_mes_ok">Delete</button><button id="dialogue_del_mes_cancel">Cancel</button></div>
    <div id="send_form"><textarea id="send_textarea"></textarea><button id="send_but">Send</button></div>
    <button id="mes_stop" style="display:none">Stop</button>` }));
  await page.goto('http://tavern.test/');
  await page.evaluate(({ settings, options }) => {
    const listeners = [];
    window.chrome = { storage: { local: { get: async () => ({ settings }) }, onChanged: { addListener() {} } },
      runtime: { id: 'test-extension', onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: async () => {} } };
    window.extensionRequest = message => new Promise(resolve => {
      listeners[0](message, { id: 'test-extension' }, resolve);
    });
    window.stats = { opened: 0, confirmed: 0, cancelled: 0, selected: null, sends: 0, regenerated: 0, menuClosed: 0 };
    window.addMessage = (id, role, text) => {
      const node = document.createElement('div');
      node.className = 'mes';
      node.setAttribute('mesid', id);
      node.setAttribute('is_user', String(role === 'user'));
      node.setAttribute('is_system', String(role === 'system'));
      node.innerHTML = '<input type="checkbox" class="del_checkbox" style="display:none"><div class="mes_text"></div>';
      node.querySelector('.mes_text').textContent = text;
      document.getElementById('chat').append(node);
      return node;
    };
    addMessage('0', 'user', 'Earlier user message');
    addMessage('1', 'assistant', 'Previous AI reply');
    addMessage('2', options.lastRole || 'user', 'Please continue.\nSecond line.');
    const $ = id => document.getElementById(id);
    const nodes = () => [...$('chat').children];
    let deleting = false;
    let selectedId = -1;
    function exitDeletion() {
      deleting = false;
      $('dialogue_del_mes').style.display = 'none';
      $('send_form').style.display = 'block';
      for (const node of nodes()) {
        node.classList.remove('selected');
        node.firstElementChild.checked = false;
        node.firstElementChild.style.display = 'none';
      }
    }
    $('options_button').onclick = () => { $('options').style.display = $('options').style.display === 'none' ? 'block' : 'none'; };
    // Native SillyTavern closes its menu on document clicks unless the menu/trigger is hovered or focused.
    if (options.autoCloseMenu) document.addEventListener('click', () => {
      if ($('options').style.display !== 'none'
          && !$('options').matches(':hover, :focus-within') && !$('options_button').matches(':hover, :focus')) {
        $('options').style.display = 'none';
        stats.menuClosed++;
      }
    });
    $('option_regenerate').onclick = () => {
      stats.regenerated++;
      $('mes_stop').style.display = 'block';
      $('options').style.display = 'none';
    };
    $('option_delete_mes').onclick = () => {
      stats.opened++;
      deleting = true;
      $('options').style.display = 'none';
      $('dialogue_del_mes').style.display = 'block';
      $('send_form').style.display = 'none';
      for (const node of nodes()) node.firstElementChild.style.display = options.missingCheckbox ? 'none' : 'block';
      if (options.switchOnOpen) $('chat').setAttribute('data-chat-id', 'different');
    };
    // SillyTavern's native selector deletes the selected message AND all subsequent messages.
    $('chat').onclick = event => {
      if (!deleting) return;
      const target = event.target.closest('.mes');
      selectedId = Number(target.getAttribute('mesid'));
      stats.selected = selectedId;
      for (const node of nodes()) {
        const checked = Number(node.getAttribute('mesid')) >= selectedId || !!options.selectOlder;
        node.classList.toggle('selected', checked);
        node.firstElementChild.checked = checked;
      }
      if (options.appendOnSelection) addMessage('3', 'assistant', 'Late response');
      if (options.busyOnSelection) $('mes_stop').style.display = 'block';
    };
    $('dialogue_del_mes_cancel').onclick = () => { stats.cancelled++; exitDeletion(); };
    $('dialogue_del_mes_ok').onclick = () => {
      stats.confirmed++;
      if (options.noAcknowledgement) return;
      for (const node of nodes()) if (Number(node.getAttribute('mesid')) >= selectedId) node.remove();
      exitDeletion();
    };
    $('send_but').onclick = () => { stats.sends++; addMessage('2', 'user', $('send_textarea').value); $('send_textarea').value = ''; };
    $('mes_stop').onclick = () => { $('mes_stop').style.display = 'none'; };
    if (options.busy) $('mes_stop').style.display = 'block';
    if (options.pageDraft) $('send_textarea').value = options.pageDraft;
    if (options.editing) nodes().at(-1).insertAdjacentHTML('beforeend', '<textarea class="edit_textarea">Unsaved edit</textarea>');
    if (options.missingControls) $('option_delete_mes').remove();
    if (options.existingDeletion) { $('options_button').click(); $('option_delete_mes').click(); nodes()[0].click(); }
  }, { settings, options });
  for (const name of ['config.js', 'shared.js', 'content.js']) await page.addScriptTag({ path: path.join(root, name) });
  const request = message => page.evaluate(message => window.extensionRequest(message), message);
  const state = async () => (await request({ type: 'TC_GET_STATE' })).state;
  const deletion = async (overrides = {}) => {
    const before = await state();
    return { type: 'TC_ACTION', requestId: 'delete-1', action: 'deleteLastUser',
      chatKey: before.chatKey, revision: before.revision, messageId: before.lastMessageId, ...overrides };
  };
  const stats = () => page.evaluate(() => ({ ...window.stats,
    ids: [...document.getElementById('chat').children].map(node => node.getAttribute('mesid')) }));
  return { context, page, request, state, deletion, stats };
}

test('native deletion removes only the final user message; duplicate delivery never clicks twice', async t => {
  const f = await fixture(t, { pageDraft: 'Keep the original page draft' });
  const action = await f.deletion();
  const result = await f.request(action);
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.state.lastRole, 'assistant');
  assert.deepEqual((await f.stats()).ids, ['0', '1']);
  assert.equal(await f.page.locator('#send_textarea').inputValue(), 'Keep the original page draft');
  await f.request(action);
  assert.equal((await f.stats()).confirmed, 1);
});

test('deletion opens the native auto-closing menu while the tavern tab is in the background', async t => {
  const f = await fixture(t, { autoCloseMenu: true });
  const other = await f.context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  const result = await f.request(await f.deletion());
  assert.equal(result.ok, true, result.error);
  assert.equal(result.confirmed, true);
  assert.equal((await f.stats()).confirmed, 1);
  assert.equal((await f.stats()).menuClosed, 0);
  assert.deepEqual((await f.stats()).ids, ['0', '1']);
});

test('regeneration opens the same auto-closing menu without moving focus to the tavern', async t => {
  const f = await fixture(t, { autoCloseMenu: true, lastRole: 'assistant' });
  const other = await f.context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  const result = await f.request({ ...await f.deletion(), action: 'regenerate' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.confirmed, true);
  assert.equal((await f.stats()).regenerated, 1);
  assert.equal((await f.stats()).menuClosed, 0);
});

for (const options of [
  { lastRole: 'assistant' }, { lastRole: 'system' }, { busy: true },
  { editing: true }, { missingControls: true }, { existingDeletion: true },
]) test(`deletion is unavailable for ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options);
  assert.equal((await f.state()).canDeleteLastUser, false);
  assert.equal((await f.request(await f.deletion())).ok, false);
  assert.equal((await f.stats()).confirmed, 0);
  assert.deepEqual((await f.stats()).ids, ['0', '1', '2']);
});

test('stale chat, stale revision, and a different message ID are rejected before opening the menu', async t => {
  const f = await fixture(t);
  for (const overrides of [{ chatKey: 'stale' }, { revision: 'stale' }, { messageId: '0' }]) {
    assert.equal((await f.request(await f.deletion({ requestId: JSON.stringify(overrides), ...overrides }))).ok, false);
  }
  assert.equal((await f.stats()).opened, 0);
});

for (const options of [{ selectOlder: true }, { appendOnSelection: true }, { busyOnSelection: true }, { missingCheckbox: true }]) {
  test(`cancels native selection if ${JSON.stringify(options)}`, async t => {
    const f = await fixture(t, options);
    const result = await f.request(await f.deletion());
    assert.equal(result.ok, false);
    assert.equal((await f.stats()).confirmed, 0);
    assert.equal((await f.stats()).cancelled, 1);
    assert.ok((await f.stats()).ids.includes('2'));
    assert.equal(await f.page.locator('#send_textarea').isVisible(), true);
  });
}

test('switching chats while the native menu opens never confirms deletion', async t => {
  const f = await fixture(t, { switchOnOpen: true });
  assert.equal((await f.request(await f.deletion())).ok, false);
  assert.equal((await f.stats()).confirmed, 0);
});

test('uncertain acknowledgement stays unconfirmed and is never retried', async t => {
  const f = await fixture(t, { noAcknowledgement: true });
  const action = await f.deletion();
  const result = await f.request(action);
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, false);
  assert.match(result.message, /尚未确认/);
  await f.request(action);
  assert.equal((await f.stats()).confirmed, 1);
});

async function uiFixture(t, options = {}) {
  const f = await fixture(t, options);
  const ui = await f.context.newPage();
  await ui.setViewportSize({ width: 530, height: 830 });
  ui.setDefaultTimeout(5000);
  const errors = [];
  ui.on('pageerror', error => errors.push(error.message));
  let actionCount = 0;
  await ui.exposeFunction('backend', async message => {
    if (message.op === 'GET_SETTINGS') return { ok: true, settings };
    if (message.op === 'LIST_TABS') return { ok: true, tabs: [{ id: 1, title: 'Test Tavern' }] };
    if (message.op === 'GET_STATE') return { ok: true, state: await f.state() };
    if (message.op === 'ACTION') {
      actionCount++;
      return f.request({ ...message, type: 'TC_ACTION', requestId: message.id });
    }
    throw new Error(`Unexpected operation ${message.op}`);
  });
  await ui.addInitScript(({ options }) => {
    const storage = { selectedTabId: 1, 'draft:1:unused': '' };
    window.savedDrafts = storage;
    if (options.draft) window.initialDraft = options.draft;
    window.chrome = { runtime: { connect() {
      const listeners = [];
      return { onMessage: { addListener: fn => listeners.push(fn) }, onDisconnect: { addListener() {} },
        postMessage: message => { window.backend(message).then(result => {
          for (const fn of listeners) fn({ id: message.id, result });
        }); } };
    } }, storage: { local: {
      get: async keys => {
        if (typeof keys === 'string') return { [keys]: storage[keys] ?? window.initialDraft ?? '' };
        return storage;
      },
      set: async values => Object.assign(storage, values),
      remove: async key => { delete storage[key]; },
    } } };
  }, { options });
  await ui.route('https://extension.test/**', async route => {
    const filename = new URL(route.request().url()).pathname.slice(1);
    if (!['chat.html', 'chat.css', 'chat.js', 'config.js', 'shared.js'].includes(filename)) return route.fulfill({ status: 404 });
    await route.fulfill({ contentType: filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html',
      body: await readFile(path.join(root, filename)) });
  });
  await ui.goto('https://extension.test/chat.html');
  try {
    await ui.waitForFunction(() => document.getElementById('status').textContent.includes('已连接'));
    await ui.waitForFunction(() => !document.getElementById('draft').disabled);
  } catch (error) {
    throw new Error(`${error.message}; UI errors: ${errors.join('; ')}; ${await ui.locator('body').innerText()}`);
  }
  return { ...f, ui, errors, actionCount: () => actionCount };
}

test('confirmation can be cancelled, then deletion restores text into an empty local draft and can be resent', async t => {
  const f = await uiFixture(t);
  assert.equal(await f.ui.locator('#regenerate').isDisabled(), true);
  assert.equal(await f.ui.locator('#deleteLastUser').isEnabled(), true);
  if (process.env.TC_SCREENSHOT_DIR) {
    await mkdir(process.env.TC_SCREENSHOT_DIR, { recursive: true });
    await f.ui.screenshot({ path: path.join(process.env.TC_SCREENSHOT_DIR, 'recovery.png') });
  }
  await f.ui.locator('#deleteLastUser').click();
  assert.equal(await f.ui.locator('#deletePreview').innerText(), 'Please continue.\nSecond line.');
  if (process.env.TC_SCREENSHOT_DIR) {
    await f.ui.setViewportSize({ width: 360, height: 640 });
    await f.ui.screenshot({ path: path.join(process.env.TC_SCREENSHOT_DIR, 'confirmation-narrow.png') });
    await f.ui.setViewportSize({ width: 530, height: 830 });
  }
  await f.ui.locator('#cancelDelete').click();
  assert.equal(f.actionCount(), 0);
  await f.ui.locator('#deleteLastUser').click();
  await f.ui.locator('#confirmDelete').click();
  await f.ui.waitForFunction(() => document.getElementById('draft').value.startsWith('Please continue.'));
  assert.deepEqual((await f.stats()).ids, ['0', '1']);
  assert.match(await f.ui.locator('#notice').innerText(), /已放回输入框/);
  await new Promise(resolve => setTimeout(resolve, 1300));
  await f.ui.locator('#refresh').click();
  await f.ui.waitForFunction(() => !document.getElementById('send').disabled);
  assert.equal(await f.ui.locator('#regenerate').isEnabled(), true);
  await f.ui.locator('#send').click();
  await f.ui.waitForFunction(() => document.getElementById('draft').value === '');
  assert.equal((await f.stats()).sends, 1);
  assert.equal((await f.stats()).confirmed, 1);
  assert.deepEqual(f.errors, []);
});

for (const draft of ['Keep my new draft', '   ']) test(`deletion preserves the existing draft ${JSON.stringify(draft)}`, async t => {
  const f = await uiFixture(t, { draft });
  await f.ui.locator('#deleteLastUser').click();
  await f.ui.locator('#confirmDelete').click();
  await f.ui.waitForFunction(() => document.getElementById('notice').textContent.includes('已删除'));
  assert.equal(await f.ui.locator('#draft').inputValue(), draft);
  assert.deepEqual(f.errors, []);
});

test('a message arriving during the confirmation dialog invalidates its captured revision', async t => {
  const f = await uiFixture(t);
  await f.ui.locator('#deleteLastUser').click();
  await f.page.evaluate(() => addMessage('3', 'assistant', 'A delayed AI response'));
  await f.ui.locator('#confirmDelete').click();
  await f.ui.waitForFunction(() => document.getElementById('notice').textContent.includes('发生变化'));
  assert.equal((await f.stats()).confirmed, 0);
  assert.deepEqual((await f.stats()).ids, ['0', '1', '2', '3']);
});

test('background routes the deletion target ID and rejects unsupported actions', async () => {
  const sent = [];
  const registrations = [];
  const event = () => ({ addListener() {} });
  const chrome = { storage: { local: { get: async () => ({ settings }) } },
    permissions: { contains: async () => true, onAdded: event(), onRemoved: event() },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async value => registrations.push(value) },
    runtime: { onConnect: event(), onMessage: event() },
    tabs: { get: async () => ({ id: 1, url: 'http://tavern.test/' }),
      sendMessage: async (id, message) => { sent.push({ id, message }); return { ok: true }; }, onRemoved: event(), onUpdated: event() },
    action: { onClicked: event() } };
  const sandbox = vm.createContext({ chrome, URL, console, importScripts() {} });
  vm.runInContext(await readFile(path.join(root, 'config.js'), 'utf8'), sandbox);
  vm.runInContext(await readFile(path.join(root, 'background.js'), 'utf8'), sandbox);
  const result = await sandbox.route({ op: 'ACTION', id: 'request-1', action: 'deleteLastUser',
    tabId: 1, chatKey: 'example', revision: 'revision-1', messageId: '2' });
  assert.equal(result.ok, true);
  assert.equal(sent[0].message.messageId, '2');
  assert.equal(sent[0].message.action, 'deleteLastUser');
  assert.equal(registrations.length, 1);
  await assert.rejects(sandbox.route({ op: 'ACTION', tabId: 1, action: 'deleteEverything' }), /不支持/);
});
