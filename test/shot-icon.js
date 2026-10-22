/**
 * 用无头 Chrome 把 icon.html 渲染成 128/48/16 三个尺寸的 PNG 图标
 * 48/128 走完整版（渐变+高光+投影），16 走简化版（实心，保证小尺寸清晰）
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ICON_HTML = 'file://' + path.resolve(__dirname, 'icon.html').replace(/ /g, '%20');
const OUT_DIR = path.resolve(__dirname, '..', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  for (const size of [128, 48, 16]) {
    const page = await browser.newPage();
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.goto(ICON_HTML + '?size=' + size, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 120));
    await page.screenshot({
      path: path.join(OUT_DIR, 'icon' + size + '.png'),
      clip: { x: 0, y: 0, width: size, height: size },
      omitBackground: true,
    });
    await page.close();
    console.log('icon' + size + '.png done');
  }
  await browser.close();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
