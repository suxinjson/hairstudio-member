from pathlib import Path

path = Path('tests/app.test.js')
source = path.read_text(encoding='utf-8')
source = source.replace('.member-card > div', '.customer-open').replace('.member-card', '.customer-row')
source = source.replace("button('剪发扣款')", "button('扣款')")
source = source.replace("document.querySelectorAll('nav button')[2]", "document.querySelectorAll('nav button')[1]")
source = source.replace("  button('会员充值').click();", "  document.querySelector('.customer-open').click(); await nextTick();\n  button('额度充值').click();")
source = source.replace("  assert.ok(button('会员充值'));", "  assert.equal(document.querySelectorAll('nav button').length, 3);\n  assert.ok(document.querySelector('.customer-open'));")
source = source.replace("  assert.equal(button('会员充值').disabled, true);", "  document.querySelector('.customer-open').click(); await nextTick();\n  assert.equal(button('额度充值').disabled, true);\n  window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })); await nextTick();")
source = source.replace("  document.querySelector('[aria-label=\"复制会员手机号\"]').click();", "  document.querySelector('.customer-open').click(); await nextTick();\n  document.querySelector('[aria-label=\"复制会员手机号\"]').click();")
# 原有返回层级测试仍展开键盘后再测试，标准项目选择保持键盘收起。
start = source.index("test('haircut consume keypad")
end = source.index("test('haircut consume modal back", start)
part = source[start:end]
part = part.replace("keypad stays docked, pops up on clicking amount or preset", "keypad stays docked, opens for editing and stays collapsed for presets")
part = part.replace("  // 键盘默认展开显示\n  assert.ok(button('收起键盘'));", "  // 标准服务无需键盘；需要改价时再展开。\n  assert.ok(button('展开键盘'));\n  button('展开键盘').click(); await nextTick();\n  assert.ok(button('收起键盘'));")
part = part.replace("  assert.ok(button('收起键盘'));\n  assert.ok(amountCard.textContent.includes('38'));", "  assert.ok(button('展开键盘'));\n  assert.ok(amountCard.textContent.includes('38'));\n  button('展开键盘').click(); await nextTick();")
source = source[:start] + part + source[end:]
start = source.index("test('haircut consume modal back")
part = source[start:]
part = part.replace("  button('扣款').click();\n  await nextTick();", "  button('扣款').click();\n  await nextTick();\n  button('展开键盘').click(); await nextTick();")
part = part.replace("  button('精致洗剪吹 (').click();\n  await nextTick();", "  button('精致洗剪吹 (').click();\n  await nextTick();\n  button('展开键盘').click(); await nextTick();")
source = source[:start] + part
path.write_text(source, encoding='utf-8', newline='\n')
