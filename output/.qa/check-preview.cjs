const { chromium } = require('C:/Users/AIMS/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 736, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('file:///D:/UGit/member/output/.qa/preview.html');
  const frame = page.frames().find(frame => frame !== page.mainFrame());
  await frame.waitForSelector('[data-design=unified] .mf-row');
  const select = async design => frame.evaluate(design => {
    document.querySelectorAll('[data-variant]').forEach(section => { section.hidden = section.querySelector('[data-design]').dataset.design !== design; });
  }, design);
  const layout = async design => frame.evaluate(design => {
    const phone = document.querySelector('[data-design=' + design + ']');
    const boundary = phone.getBoundingClientRect();
    const bad = [...phone.querySelectorAll('button,input,.mf-phone-number,.mf-brand,.mf-balance')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < boundary.left - 1 || rect.right > boundary.right + 1 || rect.bottom > boundary.bottom + 1 || rect.top < boundary.top - 1);
    });
    const sheet = phone.querySelector('.mf-sheet');
    return { bad: bad.map(element => element.textContent || element.getAttribute('aria-label')), sheetFits: !sheet || sheet.getBoundingClientRect().top >= boundary.top - 1, width: boundary.width, height: boundary.height };
  }, design);
  for (const width of [736, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const design of ['unified', 'split', 'service']) {
      await select(design);
      const result = await layout(design);
      assert.deepEqual(result.bad, [], design + ' overflow at ' + width);
      await page.screenshot({ path: 'D:/UGit/member/output/.qa/' + design + '-' + width + '.png', fullPage: true });
    }
  }
  await select('unified');
  const unified = frame.locator('[data-design=unified]');
  await unified.locator('[data-filter=low]').click();
  assert.equal(await unified.locator('.mf-row').count(), 1);
  await unified.locator('[data-filter=all]').click();
  await unified.locator('[data-search]').fill('0826');
  assert.equal(await unified.locator('.mf-row').count(), 1);
  await unified.locator('[data-action=consume]').click();
  assert.equal((await layout('unified')).sheetFits, true, 'Consume sheet fits at 320');
  await unified.locator('[data-amount]').fill('999');
  assert.equal(await unified.locator('[data-action=finish]').isDisabled(), true);
  await unified.locator('[data-amount]').fill('38');
  assert.equal(await unified.locator('[data-action=finish]').isEnabled(), true);
  await page.screenshot({ path: 'D:/UGit/member/output/.qa/checkout-320.png', fullPage: true });
  await unified.locator('[data-action=finish]').click();
  assert.match(await unified.locator('[role=dialog]').textContent(), /未写入账本/);
  await unified.locator('[data-action=close]').first().click();
  await unified.locator('[data-action=detail]').click();
  assert.equal((await layout('unified')).sheetFits, true, 'Detail sheet fits');
  await unified.locator('[data-action=recharge]').click();
  await unified.locator('[data-recharge-amount="500"]').click();
  assert.equal(await unified.locator('[data-amount]').inputValue(), '500');
  await select('split');
  const split = frame.locator('[data-design=split]');
  await split.locator('[data-action=choose][data-person=chen]').click();
  assert.match(await split.locator('.mf-selected').textContent(), /陈先生/);
  await split.locator('[data-page=customers]').click();
  assert.equal(await split.locator('.mf-row').count(), 3);
  await select('service');
  const service = frame.locator('[data-design=service]');
  await service.locator('[data-preset="3"]').click();
  await service.locator('[data-action=review]').click();
  await service.locator('[data-action=choose][data-person=zhou]').click();
  await service.locator('[data-action=review]').click();
  assert.equal(await service.locator('[data-action=finish]').isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: Chromium screenshots at 736/320px; 3 variants; search, filter, detail, recharge, service selection and overdraft guard.');
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
