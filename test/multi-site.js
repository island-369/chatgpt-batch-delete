/**
 * 多站点适配器回归测试：在无头 Chrome 中拦截各站点请求，
 * 验证「站点识别 → 列表加载 → 勾选 → 删除请求 → 行隐藏」全流程。
 * 用法：node multi-site.js
 */
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCRIPTS = ['shared', 'chatgpt', 'claude', 'grok', 'gemini', 'kimi', 'qwen', 'deepseek', 'chatglm', 'yuanbao', 'doubao'];
const results = [];

function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail != null ? ' | ' + detail : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const GEMINI_IDS = ['aa11bb22cc33dd44', 'ee55ff66aa77bb88'];
const CLAUDE_ORG = '33333333-3333-4333-8333-333333333333';
const GLM_IDS = ['glm00000000000001', 'glm00000000000002'];
const YB_IDS = ['735123456789012345', '735123456789012346'];
const DB_IDS = ['3823097283697154', '3823097283697155'];

async function load(page) {
  await page.addStyleTag({ path: path.resolve(__dirname, '..', 'content.css') });
  for (const name of SCRIPTS) await page.addScriptTag({ path: path.resolve(__dirname, '..', 'sites', name + '.js') });
  await page.addScriptTag({ path: path.resolve(__dirname, '..', 'content.js') });
}

async function openAndSelect(page, count, index = 1) {
  await page.evaluate(() => {
    document.querySelector('[data-cgpt-batch-delete]').shadowRoot.querySelector('.fab').click();
  });
  await page.waitForFunction((n) => {
    const sr = document.querySelector('[data-cgpt-batch-delete]')?.shadowRoot;
    return sr && sr.querySelectorAll('.row').length === n;
  }, { timeout: 8000 }, count);
  await page.evaluate((i) => {
    const sr = document.querySelector('[data-cgpt-batch-delete]').shadowRoot;
    sr.querySelectorAll('.row')[i].querySelector('input[type=checkbox]').click();
    sr.querySelector('.btn-del').click();
    sr.querySelector('.confirm-accept').click();
  }, index);
}

async function waitDeleted(page) {
  await page.waitForFunction(() => {
    const sr = document.querySelector('[data-cgpt-batch-delete]')?.shadowRoot;
    const flag = sr?.querySelector('.flag').textContent || '';
    return /已删除/.test(flag) || /完成：/.test(flag) || /已中止/.test(flag);
  }, { timeout: 15000 });
}

async function newPage(browser, origin, html, handler) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    if (request.resourceType() === 'document' && url.origin === origin) {
      return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    try {
      const handled = await handler(request, url);
      if (handled) return;
    } catch (error) {
      console.log('[handler error]', error.message);
    }
    return request.respond({ status: 404, body: '' });
  });
  page.__errors = errors;
  return page;
}

function shadowText(page, selector) {
  return page.evaluate((sel) => {
    const sr = document.querySelector('[data-cgpt-batch-delete]')?.shadowRoot;
    return sr?.querySelector(sel)?.textContent || '';
  }, selector);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--window-size=1280,860'] });

  /* ---------------- Claude ---------------- */
  {
    const writes = [];
    const page = await newPage(browser, 'https://claude.ai',
      `<meta charset="utf-8"><div data-testid="sidebar">${IDS.map((id, i) => `<div><a href="/chat/${id}">Claude chat ${i}</a></div>`).join('')}</div>`,
      async (request, url) => {
        const pathName = url.pathname;
        if (pathName === '/api/organizations/' + CLAUDE_ORG + '/chat_conversations') {
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(IDS.map((id, i) => ({ uuid: id, name: 'Claude chat ' + i, updated_at: new Date().toISOString() }))) });
          return true;
        }
        if (pathName === '/api/organizations/' + CLAUDE_ORG + '/chat_conversations/delete_many') {
          const body = JSON.parse(request.postData());
          writes.push({ path: pathName, body });
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: body.conversation_uuids }) });
          return true;
        }
        return false;
      });
    await page.goto('https://claude.ai/chat/' + IDS[0]);
    await page.evaluate((org) => { document.cookie = 'lastActiveOrg=' + org + '; path=/'; }, CLAUDE_ORG);
    await load(page);
    await openAndSelect(page, 2);
    await waitDeleted(page);
    assert('Claude 列表站点名', (await shadowText(page, '.site')).includes('Claude'), await shadowText(page, '.site'));
    assert('Claude 批量删除请求', writes.length === 1 && writes[0].body.conversation_uuids.length === 1,
      writes.length ? JSON.stringify(writes[0].body) : 'none');
    const hidden = await page.evaluate(() => {
      const row = document.querySelector('a[href="/chat/' + '22222222-2222-4222-8222-222222222222"]')?.closest('div');
      return row ? getComputedStyle(row).display === 'none' : false;
    });
    assert('Claude 删除后隐藏对应行', hidden === true);
    assert('Claude 无页面报错', page.__errors.length === 0, page.__errors.join(' | '));
    await page.close();
  }

  /* ---------------- Grok ---------------- */
  {
    const writes = [];
    const page = await newPage(browser, 'https://grok.com',
      `<meta charset="utf-8"><div data-sidebar="sidebar">${IDS.map((id, i) => `<div><a href="/c/${id}">Grok chat ${i}</a></div>`).join('')}</div>`,
      async (request, url) => {
        if (url.pathname === '/rest/app-chat/conversations') {
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversations: IDS.map((id, i) => ({ conversationId: id, title: 'Grok chat ' + i, modifyTime: new Date().toISOString() })), nextPageToken: '' }) });
          return true;
        }
        if (url.pathname.startsWith('/rest/app-chat/conversations/soft/')) {
          writes.push({ method: request.method(), path: url.pathname });
          request.respond({ status: 200, contentType: 'application/json', body: '{}' });
          return true;
        }
        return false;
      });
    await page.goto('https://grok.com/');
    await load(page);
    await openAndSelect(page, 2);
    await waitDeleted(page);
    assert('Grok 删除请求', writes.length === 1 && writes[0].method === 'DELETE' && writes[0].path.endsWith(IDS[1]), JSON.stringify(writes));
    assert('Grok 无页面报错', page.__errors.length === 0, page.__errors.join(' | '));
    await page.close();
  }

  /* ---------------- Gemini ---------------- */
  {
    const writes = [];
    const page = await newPage(browser, 'https://gemini.google.com',
      `<meta charset="utf-8"><meta name="og-profile-acct" content="fixture@example.test">
       <script>var config={"SNlM0e":"fixture-token","cfb2h":"build","FdrFJe":"sid"}</script>
       <side-navigation-content>${GEMINI_IDS.map((id, i) => `<gem-nav-list-item><a href="/app/${id}" aria-label="Gemini chat ${i}"><span>Gemini chat ${i}</span></a></gem-nav-list-item>`).join('')}</side-navigation-content>`,
      async (request, url) => {
        if (url.pathname === '/_/BardChatUi/data/batchexecute') {
          writes.push(Object.fromEntries(new URLSearchParams(request.postData())));
          request.respond({ status: 200, contentType: 'text/plain', body: ")]}'\n42\n" + JSON.stringify([['wrb.fr', 'GzXR5e', '[]', null, null, null, 'generic']]) });
          return true;
        }
        return false;
      });
    await page.goto('https://gemini.google.com/app');
    await load(page);
    await openAndSelect(page, 2);
    await waitDeleted(page);
    const req = writes[0] ? JSON.parse(writes[0]['f.req']) : null;
    assert('Gemini RPC 请求体', req && req[0][0][1] === JSON.stringify(['c_' + GEMINI_IDS[1]]), writes[0] ? writes[0]['f.req'] : 'none');
    assert('Gemini 无页面报错', page.__errors.length === 0, page.__errors.join(' | '));
    await page.close();
  }

  /* ---------------- Kimi ---------------- */
  {
    const writes = [];
    const page = await newPage(browser, 'https://www.kimi.com',
      `<meta charset="utf-8"><aside class="next-sidebar"><div class="next-sidebar-history-list">${IDS.map((id, i) => `<div class="next-sidebar-history-item"><a href="/chat/${id}" class="next-sidebar-history-item__link"><span class="next-sidebar-history-item__title">Kimi chat ${i}</span></a></div>`).join('')}</div></aside>`,
      async (request, url) => {
        if (url.pathname === '/apiv2/kimi.chat.v1.ChatService/DeleteChat') {
          writes.push({ headers: request.headers(), body: JSON.parse(request.postData()) });
          request.respond({ status: 200, contentType: 'application/json', body: '{}' });
          return true;
        }
        return false;
      });
    await page.goto('https://www.kimi.com/chat/' + IDS[0]);
    await page.evaluate(() => {
      localStorage.setItem('access_token', 'fixture-token');
      localStorage.setItem('msh_user_id', 'user-1');
      localStorage.setItem('volcano-token-info', JSON.stringify({ webId: 'web-1', ssid: 'ssid-1' }));
    });
    await load(page);
    await openAndSelect(page, 2);
    await waitDeleted(page);
    assert('Kimi DeleteChat 请求体', writes.length === 1 && writes[0].body.chat_id === IDS[1], JSON.stringify(writes[0]?.body));
    assert('Kimi 携带登录令牌', writes[0]?.headers.authorization === 'Bearer fixture-token', writes[0]?.headers.authorization);
    assert('Kimi 无页面报错', page.__errors.length === 0, page.__errors.join(' | '));
    await page.close();
  }

  /* ---------------- Qwen ---------------- */
  {
    const writes = [];
    const page = await newPage(browser, 'https://chat.qwen.ai',
      `<meta charset="utf-8"><div id="sidebar"><div class="session-list"></div></div>`,
      async (request, url) => {
        if (url.pathname === '/api/v2/chats/pinned') {
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
          return true;
        }
        if (url.pathname === '/api/v2/chats/') {
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: IDS.map((id, i) => ({ id, title: 'Qwen chat ' + i, created_at: new Date().toISOString() })) }) });
          return true;
        }
        if (url.pathname === '/api/v2/chats/' + IDS[1] && request.method() === 'DELETE') {
          writes.push({ method: request.method(), path: url.pathname, headers: request.headers() });
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: true }) });
          return true;
        }
        return false;
      });
    await page.goto('https://chat.qwen.ai/');
    await load(page);
    await openAndSelect(page, 2);
    await waitDeleted(page);
    assert('Qwen 删除请求', writes.length === 1 && writes[0].path === '/api/v2/chats/' + IDS[1] && writes[0].headers.source === 'web', JSON.stringify(writes));
    assert('Qwen 无页面报错', page.__errors.length === 0, page.__errors.join(' | '));
    await page.close();
  }

  /* ---------------- DeepSeek ---------------- */
  {
    const writes = [];
    const page = await newPage(browser, 'https://chat.deepseek.com',
      `<meta charset="utf-8"><aside><div class="ds-scroll-area"><div class="ds-scroll-area">${
        IDS.map((id, i) => `<div class="ds-row"><a href="/a/chat/s/${id}"><span>DeepSeek chat ${i}</span></a></div>`).join('')
      }</div></div></aside>`,
      async (request, url) => {
        if (url.pathname === '/api/v0/chat_session/fetch_page') {
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { chat_sessions: IDS.map((id, i) => ({ id, title: 'DeepSeek chat ' + i, updated_at: 1760000000 + i })), has_more: false } } }) });
          return true;
        }
        if (url.pathname === '/api/v0/chat_session/delete') {
          writes.push({ headers: request.headers(), body: JSON.parse(request.postData()) });
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: {} } }) });
          return true;
        }
        return false;
      });
    await page.goto('https://chat.deepseek.com/a/chat/s/' + IDS[0]);
    await page.evaluate(() => { localStorage.setItem('userToken', JSON.stringify({ value: 'fixture-token' })); });
    await load(page);
    await openAndSelect(page, 2);
    await waitDeleted(page);
    assert('DeepSeek 批量删除请求', writes.length === 1
      && JSON.stringify(writes[0].body.chat_session_ids) === JSON.stringify([IDS[1]])
      && writes[0].headers.authorization === 'Bearer fixture-token', JSON.stringify(writes[0]?.body));
    const hidden = await page.evaluate((id) => {
      const row = document.querySelector('a[href="/a/chat/s/' + id + '"]')?.parentElement;
      return row ? getComputedStyle(row).display === 'none' : false;
    }, IDS[1]);
    assert('DeepSeek 删除后隐藏对应行', hidden === true);
    assert('DeepSeek 无页面报错', page.__errors.length === 0, page.__errors.join(' | '));
    await page.close();
  }

  /* ---------------- 智谱清言 ---------------- */
  {
    const writes = [];
    const page = await newPage(browser, 'https://chatglm.cn',
      `<meta charset="utf-8"><div id="sidebar">${
        GLM_IDS.map((id, i) => `<div><a href="/main/chat?cid=${id}"><span>清言 chat ${i}</span></a></div>`).join('')
      }</div>`,
      async (request, url) => {
        if (url.pathname === '/chatglm/mainchat-api/conversation/recent_list') {
          const pageNo = JSON.parse(request.postData()).page;
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(pageNo === 1
            ? { status: 0, result: { conversation_list: GLM_IDS.map((id, i) => ({ conversation_id: id, assistant_id: 'assistant-' + i, title: '清言 chat ' + i, update_time: 1760000000 + i })), has_more: false } }
            : { status: 0, result: { conversation_list: [], has_more: false } }) });
          return true;
        }
        if (url.pathname === '/chatglm/backend-api/assistant/conversation/delete') {
          writes.push({ headers: request.headers(), body: JSON.parse(request.postData()) });
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 0 }) });
          return true;
        }
        return false;
      });
    await page.goto('https://chatglm.cn/main/chat?cid=' + GLM_IDS[0]);
    await page.evaluate(() => { document.cookie = 'chatglm_token=fixture-token; path=/'; });
    await load(page);
    await openAndSelect(page, 2);
    await waitDeleted(page);
    const headers = writes[0]?.headers || {};
    const expectSign = crypto.createHash('md5')
      .update(`${headers['x-timestamp']}-${headers['x-nonce']}-8a1317a7468aa3ad86e997d08f3f31cb`).digest('hex');
    assert('智谱清言 删除请求体', writes.length === 1 && writes[0].body.conversation_id === GLM_IDS[1]
      && writes[0].body.assistant_id === 'assistant-1', JSON.stringify(writes[0]?.body));
    assert('智谱清言 x-sign 签名正确', headers['x-sign'] === expectSign, headers['x-sign']);
    const hidden = await page.evaluate((id) => {
      const row = document.querySelector('a[href="/main/chat?cid=' + id + '"]')?.parentElement;
      return row ? getComputedStyle(row).display === 'none' : false;
    }, GLM_IDS[1]);
    assert('智谱清言 删除后隐藏对应行', hidden === true);
    assert('智谱清言 无页面报错', page.__errors.length === 0, page.__errors.join(' | '));
    await page.close();
  }

  /* ---------------- 腾讯元宝 ---------------- */
  {
    const writes = [];
    const page = await newPage(browser, 'https://yuanbao.tencent.com',
      `<meta charset="utf-8"><aside class="sidebar">${
        YB_IDS.map((id, i) => `<div class="conv"><a href="/chat/naQivTmsDa/${id}"><span>元宝 chat ${i}</span></a></div>`).join('')
      }</aside>`,
      async (request, url) => {
        if (url.pathname === '/api/user/agent/conversation/list') {
          const body = JSON.parse(request.postData());
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
            code: 0,
            conversations: body.offset === 0
              ? YB_IDS.map((id, i) => ({ id, agentId: 'naQivTmsDa', title: '元宝 chat ' + i, lastRepliedAt: 1760000000 + i }))
              : [],
            pagination: { totalResults: YB_IDS.length },
          }) });
          return true;
        }
        if (url.pathname === '/api/user/agent/conversation/v1/clear') {
          writes.push({ path: url.pathname, body: JSON.parse(request.postData()) });
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0 }) });
          return true;
        }
        return false;
      });
    await page.goto('https://yuanbao.tencent.com/chat/naQivTmsDa/' + YB_IDS[0]);
    await load(page);
    await openAndSelect(page, 2);
    await waitDeleted(page);
    assert('腾讯元宝 删除请求体', writes.length === 1
      && writes[0].path === '/api/user/agent/conversation/v1/clear'
      && JSON.stringify(writes[0].body.conversationIds) === JSON.stringify([YB_IDS[1]]), JSON.stringify(writes[0]?.body));
    const hidden = await page.evaluate((id) => {
      const row = document.querySelector('a[href="/chat/naQivTmsDa/' + id + '"]')?.closest('.conv');
      return row ? getComputedStyle(row).display === 'none' : false;
    }, YB_IDS[1]);
    assert('腾讯元宝 删除后隐藏对应行', hidden === true);
    assert('腾讯元宝 无页面报错', page.__errors.length === 0, page.__errors.join(' | '));
    await page.close();
  }

  /* ---------------- 豆包 ---------------- */
  {
    const writes = [];
    const page = await newPage(browser, 'https://www.doubao.com',
      `<meta charset="utf-8"><div class="sidebar">${
        DB_IDS.map((id, i) => `<div class="thread"><a href="/chat/${id}"><span>豆包 chat ${i}</span></a></div>`).join('')
      }</div>`,
      async (request, url) => {
        if (url.pathname === '/im/chain/recent_conv') {
          const body = JSON.parse(request.postData());
          const first = body.uplink_body.pull_recent_conv_chain_uplink_body.conv_version === 0;
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
            status_code: 0,
            downlink_body: { pull_recent_conv_chain_downlink_body: {
              cells: first
                ? DB_IDS.map((id, i) => ({
                  id: 'thread-' + id,
                  conversation: { conversation_id: id, name: '豆包 chat ' + i, update_time: 1760000000 + i },
                }))
                : [],
              has_more: false,
              next_conv_version: 0,
            } },
          }) });
          return true;
        }
        if (url.pathname === '/im/conversation/batch_del_user_conv') {
          const body = JSON.parse(request.postData());
          const id = body.uplink_body.batch_delete_user_conversation_uplink_body.conversation_id[0];
          writes.push({ body });
          request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
            status_code: 0,
            downlink_body: { batch_delete_user_conversation_downlink_body: { result: { [id]: true } } },
          }) });
          return true;
        }
        return false;
      });
    await page.goto('https://www.doubao.com/chat/' + DB_IDS[0]);
    await load(page);
    await openAndSelect(page, 2);
    await waitDeleted(page);
    const body = writes[0]?.body || {};
    const uplink = body.uplink_body?.batch_delete_user_conversation_uplink_body || {};
    assert('豆包 删除请求体', writes.length === 1 && body.cmd === 4171
      && JSON.stringify(uplink.conversation_id) === JSON.stringify([DB_IDS[1]])
      && uplink.conversation_type === 3, JSON.stringify(body));
    const hidden = await page.evaluate((id) => {
      const row = document.querySelector('a[href="/chat/' + id + '"]')?.closest('.thread');
      return row ? getComputedStyle(row).display === 'none' : false;
    }, DB_IDS[1]);
    assert('豆包 删除后隐藏对应行', hidden === true);
    assert('豆包 无页面报错', page.__errors.length === 0, page.__errors.join(' | '));
    await page.close();
  }

  await browser.close();
  const fail = results.filter((r) => !r.pass);
  console.log('\n===== 多站点结果：' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
  if (fail.length) { console.log('失败项：', fail.map((f) => f.name).join('、')); process.exit(1); }
})().catch((error) => { console.error('FAILED:', error); process.exit(1); });
