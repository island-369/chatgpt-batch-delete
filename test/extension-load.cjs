/**
 * 扩展真实加载测试：用 Chrome 加载整个扩展目录，
 * 验证 manifest 合法、内容脚本注入成功。
 * 用法：node extension-load.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '..');
const results = [];

function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail == null ? '' : ' | ' + String(detail)));
}

async function mockPage(browser, origin, html, pathName) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'chrome-extension:' || url.protocol === 'data:') return request.continue();
    if (request.resourceType() === 'document' && url.origin === origin) {
      return request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    return request.respond({ status: 404, body: '' });
  });
  await page.goto(origin + pathName, { waitUntil: 'domcontentloaded' });
  return page;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cgpt-bd-ext-'));
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: process.env.HEADLESS !== '0',
      userDataDir: profile,
      args: [
        // Chrome 137+ 的品牌版关闭了 --load-extension，改用 CDP 加载。
        '--enable-unsafe-extension-debugging',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    const client = await browser.target().createCDPSession();
    const loaded = await client.send('Extensions.loadUnpacked', { path: ROOT });
    check('Chrome 接受扩展清单', typeof loaded.id === 'string' && loaded.id.length > 10, loaded.id);

    /* 工具栏弹窗页面 */
    const manifestVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
    const popup = await browser.newPage();
    let popupVersion = '';
    try {
      await popup.goto('chrome-extension://' + loaded.id + '/popup.html',
        { waitUntil: 'domcontentloaded', timeout: 8000 });
      await popup.waitForSelector('#open-panel', { timeout: 5000 });
      popupVersion = await popup.$eval('#version', (el) => el.textContent);
    } catch (error) {
      popupVersion = '打开失败：' + error.message;
    }
    check('工具栏弹窗可正常打开', popupVersion === 'v' + manifestVersion, popupVersion);
    await popup.close();

    /* 智谱清言：普通内容脚本 + 侧边栏 DOM */
    const glm = await mockPage(browser, 'https://chatglm.cn',
      `<meta charset="utf-8"><div id="sidebar">
        <a href="/main/alltoolsdetail?cid=glm00000000000001">测试会话 1</a>
        <a href="/main/alltoolsdetail?cid=glm00000000000002">测试会话 2</a>
      </div>`,
      '/main/alltoolsdetail?cid=glm00000000000001');
    const glmHost = await glm.waitForFunction(
      () => !!document.querySelector('[data-cgpt-batch-delete]'),
      { timeout: 8000 }
    ).then(() => true).catch(() => false);
    const glmFab = glmHost && await glm.evaluate(() => {
      const shadow = document.querySelector('[data-cgpt-batch-delete]')?.shadowRoot;
      return !!shadow?.querySelector('.fab');
    });
    check('Chrome 成功加载扩展（智谱清言注入）', glmHost === true);
    check('智谱清言 悬浮按钮已渲染', glmFab === true);
    await glm.close();

    /* 豆包：普通内容脚本 */
    const doubao = await mockPage(browser, 'https://www.doubao.com',
      `<meta charset="utf-8"><div id="sidebar">
        <a href="/chat/3823097283697154">测试会话 1</a>
        <a href="/chat/3823097283697155">测试会话 2</a>
      </div>`,
      '/chat/3823097283697154');
    const doubaoHost = await doubao.waitForFunction(
      () => !!document.querySelector('[data-cgpt-batch-delete]'),
      { timeout: 8000 }
    ).then(() => true).catch(() => false);
    check('豆包 悬浮按钮已渲染', doubaoHost === true);
    await doubao.close();

    /* 元宝：普通内容脚本 */
    const yuanbao = await mockPage(browser, 'https://yuanbao.tencent.com',
      `<meta charset="utf-8"><aside>
        <a href="/chat/naQivTmsDa/735123456789012345">测试会话 1</a>
        <a href="/chat/naQivTmsDa/735123456789012346">测试会话 2</a>
      </aside>`,
      '/chat/naQivTmsDa/735123456789012345');
    const ybHost = await yuanbao.waitForFunction(
      () => !!document.querySelector('[data-cgpt-batch-delete]'),
      { timeout: 8000 }
    ).then(() => true).catch(() => false);
    check('腾讯元宝 悬浮按钮已渲染', ybHost === true);
    await yuanbao.close();
  } finally {
    if (browser) await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  const failed = results.filter((item) => !item.pass);
  console.log('\n===== 扩展加载测试：' + (results.length - failed.length) + '/' + results.length + ' 通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((item) => item.name).join('、'));
    process.exit(1);
  }
})().catch((error) => {
  console.error('FAILED:', error);
  process.exit(1);
});
