/**
 * 全流程截图 + 断言验证：在无头 Chrome 中打开 harness.html，
 * 通过 shadowRoot 拿到真实元素做点击/输入，每个阶段截图存到 shots/。
 * 用法：node shot.js
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HARNESS = 'file://' + path.resolve(__dirname, 'harness.html').replace(/ /g, '%20');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail != null ? ' | ' + detail : ''));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--window-size=1280,860'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 });
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('[pageerror]', e.message); });

  await page.goto(HARNESS, { waitUntil: 'load' });
  await sleep(600);

  async function sEl(sel) {
    const h = await page.evaluateHandle((s) => {
      const host = document.querySelector('[data-cgpt-batch-delete]');
      return host && host.shadowRoot ? host.shadowRoot.querySelector(s) : null;
    }, sel);
    return h.asElement();
  }
  async function sElAt(sel, i) {
    const h = await page.evaluateHandle((s, idx) => {
      const host = document.querySelector('[data-cgpt-batch-delete]');
      const els = host && host.shadowRoot ? host.shadowRoot.querySelectorAll(s) : [];
      return els[idx] || null;
    }, sel, i);
    return h.asElement();
  }
  const sState = () => page.evaluate(() => {
    const h = document.querySelector('[data-cgpt-batch-delete]');
    const sr = h.shadowRoot;
    return {
      rows: sr.querySelectorAll('.row').length,
      overlayHidden: sr.querySelector('.overlay').classList.contains('hidden'),
      count: sr.querySelector('.count').textContent,
      delDisabled: sr.querySelector('.btn-del').disabled,
      delText: sr.querySelector('.btn-del').textContent,
      delPending: sr.querySelector('.btn-del').classList.contains('btn-pending'),
      status: sr.querySelector('.status-text').textContent,
      sub: sr.querySelector('.sub').textContent,
      themeLight: h.classList.contains('theme-light'),
      flagVisible: sr.querySelector('.flag').classList.contains('show'),
      flagText: sr.querySelector('.flag').textContent,
    };
  });
  const sidebarCount = () => page.evaluate(() => document.querySelectorAll('#history li').length);
  const patchCount = () => page.evaluate(() =>
    (document.getElementById('mock-log').textContent.match(/PATCH/g) || []).length);

  async function shot(name) {
    await sleep(150);
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('shot:', name);
  }

  // ---- 1. 初始页面 + 悬浮按钮 ----
  assert('悬浮按钮已渲染', await page.evaluate(() => !!document.querySelector('[data-cgpt-batch-delete]')));
  await shot('01-初始页面与悬浮按钮.png');

  // ---- 2. 打开弹窗 ----
  (await sEl('.fab')).click();
  await sleep(350);
  await shot('02-加载中.png');
  await sleep(1700);
  await shot('03-列表加载完成.png');
  let st = await sState();
  assert('列表加载 143 条（分页 100+43）', st.rows === 143, 'rows=' + st.rows + ' sub=' + st.sub);
  assert('计数初始为 0/143', st.count === '已选 0 / 143', st.count);
  assert('删除按钮初始禁用', st.delDisabled === true);

  // ---- 3. 搜索筛选 ----
  const search = await sEl('.search');
  await search.click({ clickCount: 3 });
  await search.type('周报');
  await sleep(300);
  await shot('04-搜索筛选.png');
  st = await sState();
  assert('搜索“周报”后剩 10 条', st.rows === 10, 'rows=' + st.rows);
  assert('搜索后仍禁用删除（0 勾选）', st.delDisabled === true);

  // ---- 4. 清空搜索，勾选两行 ----
  await search.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await sleep(300);
  const cb0 = await sElAt('.row input[type=checkbox]', 0);
  const cb1 = await sElAt('.row input[type=checkbox]', 1);
  await cb0.click(); await sleep(120);
  await cb1.click(); await sleep(200);
  await shot('05-勾选两行.png');
  st = await sState();
  assert('勾选后计数 2/143', st.count === '已选 2 / 143', st.count);
  assert('删除按钮文案', st.delText === '删除所选 (2)', st.delText);
  assert('删除按钮可用', st.delDisabled === false);

  // ---- 5. 一次点击 → 进入 5 秒撤销窗口 ----
  (await sEl('.btn-del')).click();
  await sleep(400);
  await shot('06-撤销窗口.png');
  st = await sState();
  assert('点一次即进入倒计时（按钮显示剩余秒数）', /^撤销删除 \((4|5)\)$/.test(st.delText), st.delText);
  assert('状态栏说明倒计时', st.status.indexOf('秒后删除 2 个会话') >= 0, st.status);

  // ---- 6. 倒计时内再点一次 = 撤销，不会误删 ----
  (await sEl('.btn-del')).click();
  await sleep(300);
  st = await sState();
  assert('再点一次是撤销，按钮复原', st.delText === '删除所选 (2)' && st.delDisabled === false, st.delText);
  assert('撤销后未删除任何会话（侧边栏仍 30）', (await sidebarCount()) === 30);
  assert('撤销后没有发出删除请求', (await patchCount()) === 0, 'PATCH x' + (await patchCount()));

  // ---- 7. 再点删除：倒计时走完自动执行 ----
  (await sEl('.btn-del')).click();
  await sleep(1300);
  await shot('07-倒计时中.png');
  st = await sState();
  assert('倒计时递减', /^撤销删除 \(4\)$/.test(st.delText), st.delText);
  await sleep(4200);   // 累计约 5.5s
  await shot('08-自动开始删除.png');
  st = await sState();
  assert('倒计时结束自动开始删除', st.delText === '中止删除', st.delText);

  // ---- 8. 删除中关掉弹窗：转后台继续 ----
  await page.keyboard.press('Escape');
  await sleep(250);
  st = await sState();
  assert('删除中 Esc 直接收起（不再弹确认框）', st.overlayHidden === true);
  await shot('09-后台删除中.png');

  // 轮询气泡文案：删除比预期快时也能稳定断言（先出现进度，最后变成已完成）
  const seen = [];
  let doneFlag = false;
  for (let i = 0; i < 30; i++) {
    st = await sState();
    if (st.flagText && seen[seen.length - 1] !== st.flagText) seen.push(st.flagText);
    if (/已删除 2 个/.test(st.flagText)) { doneFlag = true; break; }
    await sleep(250);
  }
  await shot('10-后台删除完成.png');
  assert('后台气泡显示过进度/完成提示', seen.length > 0, seen.slice(-3).join(' → '));
  assert('后台删除完成（气泡提示）', doneFlag === true, st.flagText || '(已隐藏)');
  assert('侧边栏同步移除 2 条（30→28）', (await sidebarCount()) === 28, 'sidebar=' + (await sidebarCount()));
  assert('回退到 PATCH 隐藏接口且复用方法', (await patchCount()) >= 2, 'PATCH x' + (await patchCount()));

  // ---- 9. 重新打开：列表已刷新为最新 ----
  (await sEl('.fab')).click();
  await sleep(1800);
  await shot('11-重新打开.png');
  st = await sState();
  assert('重新打开后列表为 141 条', st.rows === 141, 'rows=' + st.rows);
  assert('重新打开计数 0/141', st.count === '已选 0 / 141', st.count);
  await page.keyboard.press('Escape');
  await sleep(250);

  // ---- 10. 键盘操作悬浮按钮 ----
  await page.evaluate(() => document.querySelector('[data-cgpt-batch-delete]').shadowRoot.querySelector('.fab').focus());
  await page.keyboard.press('Enter');
  await sleep(1600);
  st = await sState();
  assert('键盘 Enter 可打开弹窗', st.overlayHidden === false);

  // ---- 11. 浅色主题 ----
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
  });
  await page.keyboard.press('Escape');
  await sleep(250);
  (await sEl('.fab')).click();
  await sleep(1800);
  await shot('12-浅色主题.png');
  st = await sState();
  assert('检测到浅色主题', st.themeLight === true && st.overlayHidden === false);
  assert('浅色下列表仍正常加载', st.rows === 141, 'rows=' + st.rows);

  // ---- 12. 布局体检（弹窗打开状态下）----
  const audit = await page.evaluate(() => {
    const sr = document.querySelector('[data-cgpt-batch-delete]').shadowRoot;
    const list = sr.querySelector('.list');
    const rows = [...sr.querySelectorAll('.row')];
    const badRows = rows.filter((r) => r.scrollWidth > r.clientWidth + 1);
    const titles = [...sr.querySelectorAll('.row-title')];
    const clipped = titles.filter((t) => t.scrollWidth > t.clientWidth + 1);
    const dg = sr.querySelector('.dialog').getBoundingClientRect();
    return {
      rows: rows.length,
      listOverflowX: list.scrollWidth > list.clientWidth + 1,
      badRows: badRows.length,
      clippedTitles: clipped.length,
      dialogW: Math.round(dg.width), dialogH: Math.round(dg.height),
      fitsViewport: dg.height <= window.innerHeight && dg.width <= window.innerWidth,
    };
  });
  assert('所有行无横向溢出', audit.badRows === 0, 'badRows=' + audit.badRows);
  assert('长标题正确省略号截断', audit.clippedTitles > 0, 'clipped=' + audit.clippedTitles);
  assert('列表无横向滚动', audit.listOverflowX === false);
  assert('弹窗在视口内', audit.fitsViewport === true, audit.dialogW + 'x' + audit.dialogH);
  assert('全程无页面 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();

  const fail = results.filter((r) => !r.pass);
  console.log('\n===== 结果：' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
  if (fail.length) { console.log('失败项：', fail.map((f) => f.name).join('、')); process.exit(1); }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
