const { chromium } = require('C:/Users/AIMS/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:5176';
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await context.addInitScript(() => {
      window.androidBridge = { postMessage(raw) {
        const payload = JSON.parse(raw);
        queueMicrotask(() => window.Capacitor.fromNative({ callbackId: payload.callbackId, success: true,
          data: payload.methodName === 'loadSession' ? { session: null } : {} }));
      } };
      window.Capacitor = { nativeCallback() { return 'preview-listener'; },
        nativePromise(plugin, method) { return Promise.resolve(method === 'loadSession' ? { session: null } : {}); }, PluginHeaders: [
        { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] },
        { name: 'CloudDevice', methods: [{ name: 'loadSession', rtype: 'promise' }] }
      ] };
      const now = new Date().toISOString();
      const member = (id, name, phone, balance, total_recharge, total_consume, notes) => ({ id, name, phone, balance, total_recharge, total_consume, notes, created_at: now, updated_at: now });
      localStorage.setItem('hairstudio_members_v2', JSON.stringify([
        member('M-LIN', '林女士', '13800120826', 2001, 2001, 0, '两侧别推太短，喜欢自然蓬松'),
        member('M-CHEN', '陈先生', '13900186639', 16200, 20000, 3800, '寸头，保留顶部长度'),
        member('M-ZHOU', '周女士', '13600251972', -2800, 1000, 3800, '发色偏好板栗色')
      ]));
      localStorage.setItem('hairstudio_ledgers_v2', JSON.stringify([
        { id: 'TX-ZHOU', memberId: 'M-ZHOU', memberName: '周女士', memberPhone: '13600251972', type: 'CONSUME', changeAmount: -3800, balanceBefore: 1000, balanceAfter: -2800, remark: '精致洗剪吹', created_at: now }
      ]));
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForSelector('.customer-row');
    assert.equal(await page.locator('.customer-row').count(), 3);
    const audit = async name => {
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
      const result = await page.evaluate(() => ({ documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        controls: [...document.querySelectorAll('button,input')].filter(element => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > innerWidth + 1);
        }).map(element => element.textContent.trim() || element.getAttribute('aria-label')) }));
      assert.equal(result.documentOverflow, false, name + ' document overflow');
      assert.deepEqual(result.controls, [], name + ' control overflow');
    };
    for (const width of [240, 280, 320, 360, 390, 480, 760]) {
      await page.setViewportSize({ width, height: 844 });
      await audit('customers-' + width);
      if (width === 320 || width === 390) await page.screenshot({ path: 'D:/UGit/member/output/.qa/customers-' + width + '.png', fullPage: true });
    }
    await page.setViewportSize({ width: 320, height: 720 });
    await page.locator('.customer-row').filter({ hasText: '林女士' }).locator('.customer-consume').click();
    await page.waitForSelector('.consume-amount-debt');
    assert.match(await page.locator('.debt-warning').textContent(), /17.99/);
    await audit('overdraft-drawer');
    await page.screenshot({ path: 'D:/UGit/member/output/.qa/debt-drawer-320.png', fullPage: true });
    await page.getByRole('button', { name: '核对欠款', exact: true }).click();
    await page.waitForSelector('.debt-confirm-dialog');
    await audit('debt-confirmation');
    const confirm = page.getByRole('button', { name: '确认并记欠款', exact: true });
    assert.equal(await confirm.isDisabled(), true);
    await page.locator('.debt-acknowledgement input').check();
    await confirm.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'D:/UGit/member/output/.qa/debt-confirmation-320.png', fullPage: false });
    await confirm.click();
    await page.waitForSelector('#feedback-title');
    assert.match(await page.locator('#feedback-title').textContent(), /已记录欠款/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('hairstudio_members_v2')).find(m => m.id === 'M-LIN').balance), -1799);
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    await page.locator('.customer-row').filter({ hasText: '林女士' }).locator('.customer-open').click();
    await page.waitForSelector('.member-balance-debt');
    await audit('debt-detail');
    await page.screenshot({ path: 'D:/UGit/member/output/.qa/debt-detail-320.png', fullPage: false });
    await page.getByRole('button', { name: '充值 / 还款', exact: true }).click();
    await page.waitForSelector('.recharge-plans');
    const numbers = page.locator('input[type=number]');
    await numbers.nth(0).fill('10'); await numbers.nth(1).fill('0');
    await page.getByRole('button', { name: '核对充值信息', exact: true }).click();
    await page.waitForSelector('.recharge-debt-preview');
    await audit('repayment-preview');
    assert.match(await page.locator('.recharge-debt-preview').textContent(), /7.99/);
    await page.screenshot({ path: 'D:/UGit/member/output/.qa/repayment-confirmation-320.png', fullPage: false });
    await page.getByRole('button', { name: '确认充值', exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('hairstudio_members_v2')).find(m => m.id === 'M-LIN').balance), -799);
    assert.deepEqual(errors, []);
    console.log('PASS: real app at 240/280/320/360/390/480/760px; overdraft warning, acknowledgement, debt posting, customer detail and partial repayment.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
