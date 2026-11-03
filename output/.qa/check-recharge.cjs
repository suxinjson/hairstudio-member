// Run after starting Vite on port 5177, with --playwright <installed module>.
const assert = require('node:assert/strict');
const path = require('node:path');
const index = process.argv.indexOf('--playwright');
const { chromium } = require(index < 0 ? 'playwright' : process.argv[index + 1]);
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => {
      window.androidBridge = { postMessage(raw) {
        const request = JSON.parse(raw);
        queueMicrotask(() => window.Capacitor.fromNative({ callbackId: request.callbackId, success: true,
          data: request.methodName === 'loadSession' ? { session: null } : {} }));
      } };
      window.Capacitor = { nativeCallback() { return 'qa-listener'; },
        nativePromise(plugin, method) { return Promise.resolve(method === 'loadSession' ? { session: null } : {}); },
        PluginHeaders: [
          { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] },
          { name: 'CloudDevice', methods: [{ name: 'loadSession', rtype: 'promise' }] }
        ] };
      const now = new Date().toISOString();
      localStorage.setItem('hairstudio_members_v2', JSON.stringify([{ id: 'M-QA', name: '林女士（长姓名客户）', phone: '13800120826',
        balance: -3800, total_recharge: 0, total_consume: 3800, notes: '', created_at: now, updated_at: now }]));
      localStorage.setItem('hairstudio_ledgers_v2', '[]');
      localStorage.setItem('hairstudio_recharge_settings_v1', JSON.stringify({ giftEnabled: true, giftRate: 12.5 }));
    });
    const page = await context.newPage(), errors = [], results = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(process.env.MEMBER_QA_URL || 'http://127.0.0.1:5177');
    async function settled() {
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
    }
    async function open() {
      await page.locator('.customer-open').click();
      await page.locator('.member-detail-actions button').first().click();
      await settled();
    }
    await open();
    async function inspect(name) {
      await settled();
      const m = await page.evaluate(() => {
        const box = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
        const content = document.querySelector('.recharge-content'), sheet = document.querySelector('.recharge-sheet');
        const channelBoxes = [...document.querySelectorAll('.recharge-channels button')].map(el => el.getBoundingClientRect());
        return { footer: box('.recharge-footer'), sheet: box('.recharge-sheet'), content: box('.recharge-content'),
          button: box('.recharge-review-button'), height: innerHeight,
          padding: parseFloat(getComputedStyle(document.querySelector('.recharge-footer')).paddingBottom),
          sheetScroll: getComputedStyle(sheet).overflowY, contentScroll: getComputedStyle(content).overflowY,
          channelTops: channelBoxes.map(b => b.top), channelHeights: channelBoxes.map(b => b.height),
          overflow: [...sheet.querySelectorAll('input, button')].filter(el => {
            const b = el.getBoundingClientRect(); return b.width && (b.left < -1 || b.right > innerWidth + 1);
          }).map(el => el.id || el.textContent.trim()) };
      });
      assert.deepEqual(m.overflow, [], name + ' overflow');
      assert.equal(m.sheetScroll, 'hidden'); assert.equal(m.contentScroll, 'auto');
      assert.ok(m.content.height >= 44, name + ' content space ' + m.content.height);
      assert.ok(Math.abs(m.sheet.bottom - m.height) <= 1, name + ' sheet dock');
      assert.ok(m.button.bottom <= m.height - m.padding + 1, name + ' navigation overlap');
      assert.ok(m.button.height >= 52, name + ' button touch height');
      assert.ok(m.channelHeights.every(h => h >= 44), name + ' channel touch height');
      assert.ok(Math.max(...m.channelTops) - Math.min(...m.channelTops) < 1, name + ' channels must be single row');
      await page.evaluate(() => { const el = document.querySelector('.recharge-content'); el.scrollTop = el.scrollHeight; });
      const after = await page.locator('.recharge-footer').boundingBox();
      assert.ok(Math.abs(m.footer.top - after.y) <= 1, name + ' footer moved on scroll');
      await page.evaluate(() => { document.querySelector('.recharge-content').scrollTop = 0; });
      results.push({ name, contentHeight: Math.round(m.content.height), bottomPadding: m.padding });
    }
    for (const [w, h] of [[280,640],[320,480],[320,568],[360,640],[390,844],[480,480],[760,844],[736,360],[844,390],[390,320]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => { document.body.style.fontSize = '32px'; });
      await inspect(`${w}x${h}-gift-on`);
      if (w === 390 && h === 844) await page.screenshot({ path: path.join(__dirname, 'recharge-390.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#recharge-pay').fill('19.99');
    assert.equal(await page.locator('#recharge-gift').inputValue(), '2.5');
    await page.locator('#recharge-gift').fill('0.07');
    const channel = page.locator('.recharge-channels button').first();
    await channel.click(); assert.equal(await channel.getAttribute('aria-pressed'), 'true');
    await channel.click(); assert.equal(await channel.getAttribute('aria-pressed'), 'false');
    for (const safe of [24,48,80]) {
      await page.evaluate(n => document.documentElement.style.setProperty('--safe-bottom', n + 'px'), safe);
      await inspect('navigation-inset-' + safe);
    }
    await page.locator('.recharge-review-button').click();
    assert.equal(await page.locator('.recharge-confirm-dialog').getByText('收款方式', { exact: false }).count(), 0);
    await page.getByRole('button', { name: '返回修改', exact: true }).click();
    await page.getByRole('button', { name: '关闭会员充值' }).click();
    await page.locator('.member-detail-sheet .modal-header button').last().click();
    await page.locator('nav button').filter({ hasText: '设置' }).click();
    await page.getByRole('button', { name: '服务与价格', exact: false }).click();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await settled();
    await page.screenshot({ path: path.join(__dirname, 'recharge-settings.png') });
    await page.locator('[role="switch"]').uncheck();
    await page.getByRole('button', { name: '保存赠送设置' }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('hairstudio_recharge_settings_v1')).giftEnabled), false);
    await page.locator('.app-toast').waitFor({ state: 'hidden' });
    await page.locator('nav button').filter({ hasText: '客户' }).click(); await open();
    assert.equal(await page.locator('#recharge-gift').count(), 0);
    assert.equal((await page.locator('.recharge-plans').textContent()).includes('送'), false);
    for (const [w,h] of [[320,568],[390,844],[736,360]]) {
      await page.setViewportSize({ width: w, height: h }); await inspect(`${w}x${h}-gift-off`);
      if (w === 390) await page.screenshot({ path: path.join(__dirname, 'recharge-gift-off.png') });
    }
    await page.locator('.recharge-plans button').first().click();
    await page.locator('.recharge-review-button').click();
    assert.equal((await page.locator('.recharge-confirm-dialog').textContent()).includes('赠送'), false);
    await page.getByRole('button', { name: '确认充值', exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('hairstudio_members_v2'))[0].balance), 16200);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: results.length, results }, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
