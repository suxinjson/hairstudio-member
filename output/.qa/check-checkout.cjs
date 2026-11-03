// Start Vite on port 5177, then run with --playwright <installed Playwright module>.
const assert = require('node:assert/strict');
const path = require('node:path');
const moduleArgument = process.argv.indexOf('--playwright');
const { chromium } = require(moduleArgument < 0 ? 'playwright' : process.argv[moduleArgument + 1]);
const base = process.env.MEMBER_QA_URL || 'http://127.0.0.1:5177';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const errors = [], results = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      window.androidBridge = { postMessage(raw) {
        const payload = JSON.parse(raw);
        queueMicrotask(() => window.Capacitor.fromNative({ callbackId: payload.callbackId, success: true,
          data: payload.methodName === 'loadSession' ? { session: null } : {} }));
      } };
      window.Capacitor = { nativeCallback() { return 'qa-listener'; },
        nativePromise(plugin, method) { return Promise.resolve(method === 'loadSession' ? { session: null } : {}); }, PluginHeaders: [
          { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] },
          { name: 'CloudDevice', methods: [{ name: 'loadSession', rtype: 'promise' }] }
        ] };
      const now = new Date().toISOString();
      localStorage.setItem('hairstudio_members_v2', JSON.stringify([{ id: 'M-QA', name: '林女士（长姓名客户）', phone: '13800120826',
        balance: 20000, total_recharge: 20000, total_consume: 0, notes: '两侧别推太短，保留顶部长度，喜欢自然蓬松的发型。', created_at: now, updated_at: now }]));
      localStorage.setItem('hairstudio_ledgers_v2', '[]');
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('.customer-consume').click();
    await page.waitForSelector('.consume-sheet');
    await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));

    async function inspect(name) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
      const metrics = await page.evaluate(() => {
        const box = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
        const sheet = document.querySelector('.consume-sheet'), footer = document.querySelector('.consume-footer');
        const padding = parseFloat(getComputedStyle(footer).paddingBottom);
        const controls = [...footer.querySelectorAll('button')].filter(el => el.getBoundingClientRect().height && el.getBoundingClientRect().width);
        return { sheet: box('.consume-sheet'), content: box('.consume-content'), footer: box('.consume-footer'), padding,
          keyboard: box('.consume-keypad'), lastControl: Math.max(...controls.map(el => el.getBoundingClientRect().bottom)),
          sheetScroll: getComputedStyle(sheet).overflowY, contentScroll: getComputedStyle(document.querySelector('.consume-content')).overflowY,
          presetColumns: getComputedStyle(document.querySelector('.consume-presets')).gridTemplateColumns.split(' ').length,
          overflow: [...document.querySelectorAll('.consume-sheet button, .consume-sheet input')].filter(el => {
            const b = el.getBoundingClientRect(); return b.width && b.height && (b.left < -1 || b.right > innerWidth + 1);
          }).map(el => el.getAttribute('aria-label') || el.textContent.trim()),
          height: innerHeight, rootFont: getComputedStyle(document.documentElement).fontSize };
      });
      assert.deepEqual(metrics.overflow, [], name + ' horizontal overflow');
      assert.equal(metrics.sheetScroll, 'hidden', name + ' sheet must not scroll');
      assert.equal(metrics.contentScroll, 'auto', name + ' projects must scroll');
      assert.equal(metrics.rootFont, '16px');
      assert.ok(metrics.content.height >= 44, name + ' project space: ' + JSON.stringify(metrics));
      assert.ok(metrics.sheet.bottom <= metrics.height + 1, name + ' sheet below viewport');
      assert.ok(Math.abs(metrics.sheet.bottom - metrics.height) <= 1, name + ' footer not docked');
      assert.ok(metrics.lastControl <= metrics.height - metrics.padding + 1, name + ' controls in navigation safe area');
      const before = metrics.footer;
      await page.evaluate(() => { const content = document.querySelector('.consume-content'); content.scrollTop = content.scrollHeight; });
      const after = await page.locator('.consume-footer').boundingBox();
      assert.ok(Math.abs(before.top - after.y) <= 1, name + ' footer moved while scrolling: ' + JSON.stringify({ before, after }));
      await page.evaluate(() => { document.querySelector('.consume-content').scrollTop = 0; });
      results.push({ name, projectHeight: Math.round(metrics.content.height), columns: metrics.presetColumns, bottomPadding: metrics.padding });
    }
    for (const [width, height] of [[240,844],[280,640],[320,568],[360,640],[390,844],[480,480],[760,844],[736,360],[844,390]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; document.body.style.fontSize = '32px'; });
      await inspect(width + 'x' + height + '-collapsed');
      await page.getByRole('button', { name: '展开键盘' }).click();
      await inspect(width + 'x' + height + '-keyboard');
      if (width === 390 || width === 736) await page.screenshot({ path: path.join(__dirname, 'checkout-fixed-' + width + '.png') });
      await page.getByRole('button', { name: '收起键盘' }).click();
    }
    await page.setViewportSize({ width: 320, height: 568 });
    await page.locator('.consume-content input').fill('精致洗剪吹 + 护理');
    await page.getByRole('button', { name: '展开键盘' }).click();
    await page.getByRole('button', { name: '清空扣款金额', exact: true }).last().click();
    for (const digit of ['3', '0', '0']) await page.locator('.keypad-key').getByText(digit, { exact: true }).click();
    await inspect('320x568-debt-keyboard');
    for (const safe of [24,48,80]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(value => document.documentElement.style.setProperty('--safe-bottom', value + 'px'), safe);
      await inspect('navigation-inset-' + safe);
    }
    await page.screenshot({ path: path.join(__dirname, 'checkout-fixed-debt.png') });
    await page.getByRole('button', { name: '核对欠款', exact: false }).first().click();
    const confirm = page.getByRole('button', { name: '确认并记欠款', exact: true });
    assert.equal(await confirm.isDisabled(), true);
    await page.locator('.debt-acknowledgement input').check();
    await confirm.click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('hairstudio_members_v2'))[0].balance), -10000);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: results.length, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
