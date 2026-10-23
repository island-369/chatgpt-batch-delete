/**
 * Gemini 适配器（gemini.google.com）
 *
 * 列表：网站没有可用的列表接口，读取侧边栏 DOM（当前已渲染的最近对话）。
 * 删除：网站原生的 DeleteConversation batchexecute RPC（逐条）。
 */
(function () {
  'use strict';

  const shared = CGptBatchDelete;
  const RPC = 'GzXR5e';
  const REQ_GAP = 300;

  // 从页面内嵌配置读取 batchexecute 所需的令牌；不落盘、不外发。
  function session() {
    const source = [...document.querySelectorAll('script')].map((node) => node.textContent).join('\n');
    const read = (key) => {
      const match = source.match(new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")'));
      return match ? JSON.parse(match[1]) : null;
    };
    const token = read('SNlM0e');
    const account = document.querySelector('meta[name="og-profile-acct"]')?.content;
    if (!token || !account) throw new Error('登录已失效');
    const user = location.pathname.match(/^\/u\/(\d+)\//)?.[1]
      || new URL(location.href).searchParams.get('authuser') || '0';
    if (!/^\d+$/.test(user)) throw new Error('登录已失效');
    return { token, account, user, build: read('cfb2h'), sid: read('FdrFJe') };
  }

  // 成功响应是一个 wrb.fr 帧，内容是只含 null 的数组。
  function acknowledge(text) {
    let found = false;
    function visit(value) {
      if (!Array.isArray(value)) return;
      if (value[0] === 'wrb.fr' && value[1] === RPC) {
        if (typeof value[2] !== 'string') throw new Error('接口返回格式异常');
        const result = JSON.parse(value[2]);
        if (!Array.isArray(result) || result.some((item) => item !== null)) throw new Error('接口返回格式异常');
        found = true;
      } else {
        for (const item of value) visit(item);
      }
    }
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('[')) continue;
      visit(JSON.parse(line));
    }
    return found;
  }

  async function removeOne(id, current) {
    try {
      const query = new URLSearchParams({
        rpcids: RPC, 'source-path': location.pathname, authuser: current.user, rt: 'c',
      });
      if (current.build) query.set('bl', current.build);
      if (current.sid) query.set('f.sid', current.sid);
      const body = new URLSearchParams({
        'f.req': JSON.stringify([[[RPC, JSON.stringify(['c_' + id]), null, 'generic']]]),
        at: current.token,
      });
      const response = await fetch('/_/BardChatUi/data/batchexecute?' + query, {
        method: 'POST',
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) return false;
      return acknowledge(await response.text());
    } catch (error) {
      return false;
    }
  }

  async function remove(ids, { onProgress, aborted }) {
    const ok = [];
    const failed = [];
    const current = session();   // 拿不到令牌会直接抛错，由界面提示刷新或重新登录
    for (let i = 0; i < ids.length; i++) {
      if (aborted && aborted()) break;
      const good = await removeOne(ids[i], current);
      (good ? ok : failed).push(ids[i]);
      if (onProgress) onProgress(ids[i], good);
      if (i < ids.length - 1) await shared.sleep(REQ_GAP);
    }
    return { ok, failed, soft: true };
  }

  function idFromHref(href) {
    try {
      const url = new URL(href || '', location.origin);
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(/^\/(?:u\/\d+\/)?app\/([0-9a-f]{1,16})\/?$/i);
      return match ? match[1].toLowerCase() : null;
    } catch (error) {
      return null;
    }
  }

  function domList() {
    return shared.domList({
      roots: 'side-navigation-content',
      selector: 'a[href]',
      idFromHref,
    });
  }

  function currentId() {
    const match = location.pathname.match(/^\/(?:u\/\d+\/)?app\/([0-9a-f]{1,16})\/?$/i);
    return match ? match[1].toLowerCase() : null;
  }

  shared.sites.gemini = {
    id: 'gemini',
    name: 'Gemini',
    listNote: '仅包含侧边栏当前已加载的会话',
    origins: ['https://gemini.google.com'],
    list: async () => domList(),
    domList,
    remove,
    currentId,
    idFromHref,
  };
})();
