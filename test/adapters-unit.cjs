/**
 * 智谱清言 / 腾讯元宝 / 豆包适配器逐项测试（Node + vm，不启动浏览器）。
 * 覆盖：manifest 完整性、URL 解析、列表分页、删除请求体、错误处理。
 * 用法：node adapters-unit.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SALT = '8a1317a7468aa3ad86e997d08f3f31cb';
const results = [];

function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail == null ? '' : ' | ' + String(detail)));
}

class FakeEvent {
  constructor(type) { this.type = type; }
}

function reply(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    text: async () => (body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function makeHarness(origin, options = {}) {
  const listeners = new Map();
  const dataset = {};
  const storage = new Map(Object.entries(options.storage || {}));
  const requests = [];
  const pathname = options.pathname || '/';
  const search = options.search || '';

  const document = {
    cookie: options.cookie || '',
    documentElement: { dataset },
    head: { appendChild() {} },
    body: null,
    createElement: () => ({ remove() {} }),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent(event) {
      for (const fn of (listeners.get(event.type) || []).slice()) fn(event);
      return true;
    },
    querySelectorAll: () => [],
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    Event: FakeEvent,
    AbortSignal: { timeout: () => ({}) },
    crypto: {
      randomUUID: () => nodeCrypto.randomUUID(),
      getRandomValues: (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      },
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    performance: {
      getEntriesByType: (type) => (type === 'resource' ? (options.resources || []).map((name) => ({ name })) : []),
    },
    navigator: { language: 'zh-CN' },
    location: {
      origin,
      href: origin + pathname + search,
      pathname,
      search,
    },
    document,
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const result = await options.handler(String(url), init);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, requests, dataset };
}

function loadAdapter(harness, name) {
  for (const file of ['sites/shared.js', 'sites/' + name + '.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), harness.sandbox, { filename: file });
  }
  return harness.sandbox.CGptBatchDelete.sites[name];
}

(async () => {
  /* ==================== manifest ==================== */
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js);
  check('manifest 版本格式有效', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
  check('manifest 名称使用 Clear Chats', manifest.name.startsWith('Clear Chats'), manifest.name);
  check('manifest 脚本文件均存在', scripts.every((file) => fs.existsSync(path.join(ROOT, file))),
    scripts.filter((file) => !fs.existsSync(path.join(ROOT, file))).join(',') || '全部存在');
  check('manifest 配置工具栏弹窗', manifest.action
    && manifest.action.default_popup === 'popup.html'
    && fs.existsSync(path.join(ROOT, manifest.action.default_popup)), manifest.action?.default_popup);
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  check('工具栏弹窗包含 GitHub 仓库链接',
    popupHtml.includes('https://github.com/island-369/clear-chats')
    && popupHtml.includes('rel="noopener noreferrer"'));
  const iconSizes = ['16', '32', '48', '128'];
  check('扩展图标齐全', iconSizes.every((size) => manifest.icons[size]
    && manifest.action.default_icon[size]
    && fs.existsSync(path.join(ROOT, manifest.icons[size]))), iconSizes.join('/'));
  check('豆包不再注入页面世界签名脚本', !manifest.content_scripts.some((entry) =>
    (entry.js || []).includes('sites/doubao-page.js')) && !manifest.web_accessible_resources);
  check('三个新站点域名齐全', ['chatglm.cn', 'yuanbao.tencent.com', 'www.doubao.com'].every((host) =>
    manifest.content_scripts[0].matches.some((match) => match.includes(host))));

  /* ==================== 智谱清言 ==================== */
  {
    const page1 = {
      status: 0,
      result: {
        conversation_list: [{ conversation_id: 'glm00000000000001', assistant_id: 'asst-1', title: '第一条', update_time: 1 }],
        has_more: true,
      },
    };
    const page2 = {
      status: 0,
      result: {
        conversation_list: [{ conversation_id: 'glm00000000000002', assistant_id: 'asst-2', title: '第二条', update_time: 2 }],
        has_more: false,
      },
    };
    const harness = makeHarness('https://chatglm.cn', {
      cookie: 'chatglm_token=fixture-token',
      pathname: '/main/alltoolsdetail',
      search: '?cid=glm00000000000001',
      handler: async (url, init) => {
        const page = JSON.parse(init.body).page;
        return reply(page === 1 ? page1 : page2);
      },
    });
    const site = loadAdapter(harness, 'chatglm');

    const items = await site.list();
    check('智谱清言 分页拉全量', items.length === 2 && items[1].id === 'glm00000000000002' && items[1].title === '第二条',
      JSON.stringify(items));
    check('智谱清言 列表请求 2 次', harness.requests.length === 2, harness.requests.length);

    const headers = harness.requests[0].init.headers;
    const expectedSign = nodeCrypto.createHash('md5')
      .update(`${headers['x-timestamp']}-${headers['x-nonce']}-${SALT}`).digest('hex');
    check('智谱清言 x-sign 与 MD5 公式一致', headers['x-sign'] === expectedSign, headers['x-sign']);
    check('智谱清言 携带登录令牌', headers.authorization === 'Bearer fixture-token', headers.authorization);

    check('智谱清言 idFromHref 解析 cid', site.idFromHref('/main/alltoolsdetail?cid=glm00000000000001') === 'glm00000000000001');
    check('智谱清言 idFromHref 拒绝站外链接', site.idFromHref('https://example.com/?cid=glm00000000000001') === null);
    check('智谱清言 currentId 读取地址栏', site.currentId() === 'glm00000000000001', site.currentId());
  }

  {
    const first = Array.from({ length: 20 }, (_, i) => ({
      conversation_id: 'glm10000000' + String(i).padStart(4, '0'),
      assistant_id: 'asst-' + i,
      title: '第 ' + i + ' 条',
    }));
    const second = [{ conversation_id: 'glm20000000000001', assistant_id: 'asst-last', title: '末页' }];
    const pages = [first, second, []];
    const harness = makeHarness('https://chatglm.cn', {
      cookie: 'chatglm_token=fixture-token',
      handler: async (url, init) => {
        const page = JSON.parse(init.body).page;
        return reply({ status: 0, result: { conversation_list: pages[page - 1] || [] } });
      },
    });
    const site = loadAdapter(harness, 'chatglm');
    const items = await site.list();
    check('智谱清言 缺 has_more 时继续翻页', items.length === 21 && harness.requests.length === 3,
      items.length + ' 条 / ' + harness.requests.length + ' 次请求');
  }

  {
    const harness = makeHarness('https://chatglm.cn', {
      cookie: 'chatglm_token=fixture-token',
      handler: async (url) => {
        if (url.includes('/conversation/recent_list')) return reply('', 500);
        return reply({
          status: 0,
          result: [{ conversation_id: 'glm00000000000003', assistant_id: 'asst-3', title: '旧接口' }],
        });
      },
    });
    const site = loadAdapter(harness, 'chatglm');
    const items = await site.list();
    check('智谱清言 新版列表失败回退旧接口', items.length === 1 && items[0].title === '旧接口'
      && JSON.parse(harness.requests[1].init.body).num === 100, JSON.stringify(items));
  }

  {
    const id = 'glm00000000000002';
    const harness = makeHarness('https://chatglm.cn', {
      cookie: 'chatglm_token=fixture-token',
      handler: async (url, init) => {
        if (url.includes('/conversation/recent_list')) {
          return reply({ status: 0, result: { conversation_list: [{ conversation_id: id, assistant_id: 'asst-2', title: 'x' }], has_more: false } });
        }
        if (url.includes('/conversation/delete')) {
          // 带签名的请求返回 403，验证会回退到不带签名的旧调用。
          return init.headers['x-sign'] ? reply({ message: 'bad sign' }, 403) : reply({ status: 0 });
        }
        return reply('', 404);
      },
    });
    const site = loadAdapter(harness, 'chatglm');
    const result = await site.remove([id], {});
    const deletes = harness.requests.filter((request) => request.url.includes('/conversation/delete'));
    check('智谱清言 签名失败回退旧调用', result.ok.length === 1 && deletes.length === 2
      && !!deletes[0].init.headers['x-sign'] && !deletes[1].init.headers['x-sign'],
      JSON.stringify(result));
    check('智谱清言 删除请求体含 assistant_id', JSON.parse(deletes[0].init.body).assistant_id === 'asst-2',
      deletes[0].init.body);
  }

  {
    const id = 'glm00000000000004';
    const harness = makeHarness('https://chatglm.cn', {
      cookie: 'chatglm_token=fixture-token',
      handler: async (url) => {
        if (url.includes('/conversation/recent_list')) {
          return reply({ status: 0, result: { conversation_list: [{ conversation_id: id, title: '缺助手 id' }], has_more: false } });
        }
        if (url.includes('/assistant/recently_conversation')) {
          return reply({ status: 0, result: [{ conversation_id: id, assistant_id: 'asst-legacy', title: '旧接口' }] });
        }
        if (url.includes('/conversation/delete')) return reply({ status: 0 });
        return reply('', 404);
      },
    });
    const site = loadAdapter(harness, 'chatglm');
    const result = await site.remove([id], {});
    const request = harness.requests.find((item) => item.url.includes('/conversation/delete'));
    check('智谱清言 缺 assistant_id 时回退旧接口补齐',
      result.ok.length === 1 && JSON.parse(request.init.body).assistant_id === 'asst-legacy',
      JSON.stringify(result));
  }

  {
    const harness = makeHarness('https://chatglm.cn', {
      cookie: 'chatglm_token=fixture-token',
      handler: async () => reply('', 500),
    });
    const site = loadAdapter(harness, 'chatglm');
    let message = '';
    let result = null;
    try { result = await site.remove(['glm00000000000005'], {}); } catch (error) { message = error.message; }
    check('智谱清言 查不到会话信息时只标记失败', !message && result && result.failed.length === 1,
      message || JSON.stringify(result));
  }

  {
    const harness = makeHarness('https://chatglm.cn', {
      handler: async () => reply('', 500),
    });
    const site = loadAdapter(harness, 'chatglm');
    let message = '';
    try { await site.list(); } catch (error) { message = error.message; }
    check('智谱清言 未登录时给出提示', message === '登录已失效', message);
  }

  /* ==================== 腾讯元宝 ==================== */
  {
    const all = [
      { id: '735123456789012345', agentId: 'naQivTmsDa', title: '第一条', lastRepliedAt: 1 },
      { id: '735123456789012346', agentId: 'naQivTmsDa', title: '第二条', lastRepliedAt: 2 },
      { id: '735123456789012347', agentId: 'naQivTmsDa', title: '第三条', lastRepliedAt: 3 },
    ];
    const offsets = [];
    const harness = makeHarness('https://yuanbao.tencent.com', {
      pathname: '/chat/naQivTmsDa/735123456789012345',
      handler: async (url, init) => {
        const body = JSON.parse(init.body);
        offsets.push(body.offset);
        return reply({
          code: 0,
          conversations: all.slice(body.offset, body.offset + 2),
          pagination: { totalResults: all.length },
        });
      },
    });
    const site = loadAdapter(harness, 'yuanbao');

    const items = await site.list();
    check('腾讯元宝 offset 分页拉全量', items.length === 3 && JSON.stringify(offsets) === JSON.stringify([0, 2]),
      JSON.stringify(offsets));
    check('腾讯元宝 列表带 agentId', JSON.parse(harness.requests[0].init.body).agentId === 'naQivTmsDa',
      harness.requests[0].init.body);
    check('腾讯元宝 idFromHref 解析会话 ID', site.idFromHref('/chat/naQivTmsDa/735123456789012346') === '735123456789012346');
    check('腾讯元宝 idFromHref 忽略首页', site.idFromHref('/chat/naQivTmsDa') === null);
    check('腾讯元宝 currentId 读取地址栏', site.currentId() === '735123456789012345', site.currentId());
  }

  {
    const all = [
      { id: '735123456789012345', agentId: 'naQivTmsDa', title: '第一条' },
      { id: '735123456789012346', agentId: 'naQivTmsDa', title: '第二条' },
      { id: '735123456789012347', agentId: 'naQivTmsDa', title: '第三条' },
    ];
    const offsets = [];
    const harness = makeHarness('https://yuanbao.tencent.com', {
      pathname: '/chat/naQivTmsDa/735123456789012345',
      handler: async (url, init) => {
        const body = JSON.parse(init.body);
        offsets.push(body.offset);
        return reply({ code: 0, conversations: all.slice(body.offset, body.offset + 2) });
      },
    });
    const site = loadAdapter(harness, 'yuanbao');
    const items = await site.list();
    check('腾讯元宝 缺 totalResults 时继续翻页', items.length === 3
      && JSON.stringify(offsets) === JSON.stringify([0, 2, 3]), JSON.stringify(offsets));
  }

  {
    const id = '735123456789012346';
    const harness = makeHarness('https://yuanbao.tencent.com', {
      pathname: '/chat/naQivTmsDa/' + id,
      handler: async (url, init) => {
        if (url.includes('/conversation/v1/clear')) return reply({ code: 0 });
        return reply('', 404);
      },
    });
    const site = loadAdapter(harness, 'yuanbao');
    const result = await site.remove([id], {});
    const body = JSON.parse(harness.requests[0].init.body);
    check('腾讯元宝 删除请求体', result.ok.length === 1
      && JSON.stringify(body.conversationIds) === JSON.stringify([id])
      && body.uiOptions.noToast === true, JSON.stringify(body));
  }

  {
    const id = '735123456789012346';
    const paths = [];
    const harness = makeHarness('https://yuanbao.tencent.com', {
      pathname: '/chat/naQivTmsDa/' + id,
      handler: async (url, init) => {
        paths.push(url);
        if (url.includes('/conversation/v1/clear')) return reply('', 404);
        if (url.includes('/conversation/v1/delete')) return reply({ code: 0 });
        return reply('', 404);
      },
    });
    const site = loadAdapter(harness, 'yuanbao');
    const result = await site.remove([id], {});
    const fallback = JSON.parse(harness.requests[1].init.body);
    check('腾讯元宝 删除失败回退 v1/delete', result.ok.length === 1
      && paths[1].includes('/conversation/v1/delete')
      && fallback.conversationId === id && fallback.agentId === 'naQivTmsDa', JSON.stringify(fallback));
  }

  {
    const harness = makeHarness('https://yuanbao.tencent.com', {
      handler: async () => reply({ code: 1001, msg: '会话不存在' }),
    });
    const site = loadAdapter(harness, 'yuanbao');
    let message = '';
    try { await site.list(); } catch (error) { message = error.message; }
    check('腾讯元宝 错误码转成提示', message === '会话不存在', message);
  }

  /* ==================== 豆包 ==================== */
  {
    const versions = [];
    const harness = makeHarness('https://www.doubao.com', {
      pathname: '/chat/3823097283697154',
      handler: async (url, init) => {
        const body = JSON.parse(init.body);
        const uplink = body.uplink_body.pull_recent_conv_chain_uplink_body;
        versions.push({ version: uplink.conv_version, direction: uplink.direction });
        if (uplink.conv_version === 0) {
          return reply({
            status_code: 0,
            downlink_body: { pull_recent_conv_chain_downlink_body: {
              cells: [
                { conversation: { conversation_id: '3823097283697154', name: '第一条', update_time: 1 } },
                { conversation: { conversation_id: '3823097283697155', name: '第二条', update_time: 2 } },
              ],
              has_more: true,
              next_conv_version: 777,
            } },
          });
        }
        return reply({
          status_code: 0,
          downlink_body: { pull_recent_conv_chain_downlink_body: {
            cells: [{ conversation: { conversation_id: '3823097283697156', name: '第三条', update_time: 3 } }],
            has_more: false,
          } },
        });
      },
    });
    const site = loadAdapter(harness, 'doubao');
    const items = await site.list();
    check('豆包 游标分页拉全量', items.length === 3 && items[2].id === '3823097283697156', JSON.stringify(items));
    check('豆包 首屏与翻页方向正确', JSON.stringify(versions) === JSON.stringify([
      { version: 0, direction: 3 }, { version: 777, direction: 1 },
    ]), JSON.stringify(versions));
    check('豆包 idFromHref 解析会话 ID', site.idFromHref('/chat/3823097283697155') === '3823097283697155');
    check('豆包 idFromHref 忽略首页', site.idFromHref('/chat/') === null);
    check('豆包 currentId 读取地址栏', site.currentId() === '3823097283697154', site.currentId());
  }

  {
    const harness = makeHarness('https://www.doubao.com', {
      pathname: '/chat/3823097283697154',
      handler: async () => reply({ status_code: 712010702, status_desc: '系统内部异常' }),
    });
    const site = loadAdapter(harness, 'doubao');
    let message = '';
    try { await site.list(); } catch (error) { message = error.message; }
    check('豆包 列表错误转成提示', message === '系统内部异常', message);
  }

  {
    const harness = makeHarness('https://www.doubao.com', {
      pathname: '/chat/3823097283697154',
      storage: {
        client_device_info: JSON.stringify({ deviceId: 'device-from-storage' }),
        samantha_web_web_id: JSON.stringify({ web_id: 'web-from-storage' }),
      },
      handler: async () => reply({
        status_code: 0,
        downlink_body: { pull_recent_conv_chain_downlink_body: { cells: [], has_more: false } },
      }),
    });
    const site = loadAdapter(harness, 'doubao');
    await site.list();
    const query = new URL(harness.requests[0].url, 'https://www.doubao.com').searchParams;
    check('豆包 兜底参数读取本地设备标识',
      query.get('device_id') === 'device-from-storage'
      && query.get('web_id') === 'web-from-storage'
      && query.get('tea_uuid') === 'web-from-storage',
      query.get('device_id') + ' / ' + query.get('web_id'));
  }

  {
    const id = '3823097283697155';
    const harness = makeHarness('https://www.doubao.com', {
      pathname: '/chat/3823097283697154',
      handler: async (url) => reply({
        status_code: 0,
        downlink_body: { batch_delete_user_conversation_downlink_body: { result: { [id]: true } } },
      }),
    });
    const site = loadAdapter(harness, 'doubao');
    const result = await site.remove([id], {});
    const request = harness.requests[0];
    const body = JSON.parse(request.init.body);
    const uplink = body.uplink_body.batch_delete_user_conversation_uplink_body;
    check('豆包 删除走 IM batch_del_user_conv', result.ok.length === 1
      && request.url === '/im/conversation/batch_del_user_conv', request.url);
    check('豆包 删除请求体为 cmd 4171', body.cmd === 4171
      && JSON.stringify(uplink.conversation_id) === JSON.stringify([id])
      && uplink.delete_all === false && uplink.conversation_type === 3, JSON.stringify(body));
    check('豆包 删除 Content-Type 带 encoding',
      request.init.headers['content-type'] === 'application/json; encoding=utf-8',
      request.init.headers['content-type']);
  }

  {
    const id = '3823097283697155';
    const harness = makeHarness('https://www.doubao.com', {
      pathname: '/chat/3823097283697154',
      handler: async () => reply({
        status_code: 0,
        downlink_body: { batch_delete_user_conversation_downlink_body: { result: { [id]: false } } },
      }),
    });
    const site = loadAdapter(harness, 'doubao');
    const result = await site.remove([id], {});
    check('豆包 服务端未确认删除时标记失败', result.ok.length === 0 && result.failed.length === 1
      && (result.error || '').includes('未确认'), result.error);
  }

  {
    const harness = makeHarness('https://www.doubao.com', {
      pathname: '/chat/3823097283697154',
      handler: async () => reply({ status_code: 712012002, status_desc: '不支持编码类型' }),
    });
    const site = loadAdapter(harness, 'doubao');
    const result = await site.remove(['3823097283697155'], {});
    check('豆包 删除错误码回传原因', result.ok.length === 0 && result.error === '不支持编码类型', result.error);
  }

  const failed = results.filter((item) => !item.pass);
  console.log('\n===== 适配器逐项测试：' + (results.length - failed.length) + '/' + results.length + ' 通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((item) => item.name).join('、'));
    process.exit(1);
  }
})().catch((error) => {
  console.error('FAILED:', error);
  process.exit(1);
});
