const fs = require('node:fs');
function edit(file, replacements) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [before, after] of replacements) {
    if (!text.includes(before)) continue;
    text = text.replaceAll(before, after);
  }
  fs.writeFileSync(file, text);
}
edit('src/App.vue', [['理发店省心锦囊','经营提示'], ['剪发扣款抽屉','消费扣款抽屉']]);
edit('src/components/MemberDetailDrawer.vue', [['发型偏好说明（理发店重点业务信息，大字醒目暖金色卡片）','会员备注与服务偏好']]);
edit('admin/src/utils/importer.js', [['偏好总监剪发，发质偏干','喜欢提前预约，周末到店'], ['男士理发','普通会员'], ['两边剪短，无需打薄','偏好电话联系'], ['染烫年卡','年度会员'], ['对双氧奶气味较敏感','服务前请确认具体需求']]);
for (const file of ['MembersView','AuditLogView','ImportExportView','LedgersView']) {
  const path = `admin/src/views/${file}.vue`;
  edit(path, [["import { ref", "import { storeFilePrefix } from '../../../src/store-profile.js';\nimport { ref"]]);
}
edit('admin/src/views/MembersView.vue', [["'会员明细表'", "storeFilePrefix(adminApi.storeProfile.value) + '_会员明细表'"], ['备注偏好 (选填)', "{{ adminApi.storeProfile.value.memberNotesLabel }} (选填)"]]);
edit('admin/src/views/AuditLogView.vue', [["'会员管家安全审计日志'", "storeFilePrefix(adminApi.storeProfile.value) + '_安全审计日志'"]]);
edit('admin/src/views/ImportExportView.vue', [["'会员全量档案'", "storeFilePrefix(adminApi.storeProfile.value) + '_会员全量档案'"], ["'会员财务流水'", "storeFilePrefix(adminApi.storeProfile.value) + '_会员财务流水'"], ["'会员管家安全审计日志'", "storeFilePrefix(adminApi.storeProfile.value) + '_安全审计日志'"]]);
edit('admin/src/views/LedgersView.vue', [["'会员财务对账流水明细'", "storeFilePrefix(adminApi.storeProfile.value) + '_财务对账流水明细'"]]);
for (const file of ['.github/workflows/build-apk.yml','deploy/deploy-update.sh','deploy/README.md','deploy/github-apk.md','README.md']) {
  edit(file, [['hairstudio-member-v','member-manager-v']]);
}
edit('.github/workflows/build-apk.yml', [['name: hairstudio-member-', 'name: member-manager-']]);
edit('deploy/github-apk.md', [['`hairstudio-member-版本号`', '`member-manager-版本号`']]);
edit('src/cloud-device.js', [["'hairstudio-member-'", "'member-manager-'"]]);
edit('deploy/font-scaling-check.md', [['剪发扣款','消费扣款']]);
edit('deploy/voice-integration.md', [['欢迎回复已缩短为“梦飞空间欢迎您，请说”','欢迎回复默认使用“{store}欢迎您，请说”，门店名称与欢迎词在门店设置中修改']]);
edit('README.md', [['# ✂️','# 💳'], ['专为**家庭理发店 / 个人发型工作室**量身定制的会员储值与剪发记账独立安卓 App。','适用于各类门店的会员储值、充值与消费记账软件，支持安卓 App、网页收银和管理后台。软件名称统一为 **会员管家**；门店名称、电话、地址、会员备注标题、语音欢迎词与充值通知致谢可在“设置 → 门店设置”中配置，联网后多端共用。已有门店名称与账本继续保留。'], ['理发店专属功能','门店会员管理'], ['秒级剪发扣款','快捷消费扣款'], ['预设理发店高频品项：**精致洗剪吹 ¥38、寸头快剪 ¥25、单人洗吹 ¥20、儿童理发 ¥25、时尚冷烫 ¥128、植物染发 ¥158、深层护理 ¥88**，一键带入。','新门店不预置行业专用服务，店主自行配置服务项目与价格；消费也支持手动输入金额。已保存的服务项目和价格保持原样。'], ['熟客发型偏好档案','会员偏好与备注'], ['记录熟客发型喜好（如：*“短发寸头、染发偏好板栗色、不喜欢推子太贴皮”*），到店洗剪吹一目了然。','记录服务偏好、客户需求与注意事项；备注标题可按业务设置。'], ['针对沙龙店主、店长与财务电脑大屏设计','针对门店店主、店长与财务电脑大屏设计'], ['店内剪发、洗吹、染烫项目标价维护','自定义服务项目标价维护'], ['理发店专属收银台','门店收银台']]);
edit('tests/app.test.js', [["const { localDb } = await import('../src/storage.js');", "const { localDb, STORAGE_KEYS } = await import('../src/storage.js');\nconst { LEGACY_SERVICES } = await import('./fixtures/legacy-services.js');"], ['  localDb.init();\n', '  localDb.init();\n  localStorage.setItem(STORAGE_KEYS.SERVICES, JSON.stringify(LEGACY_SERVICES));\n']]);
edit('tests/storage.test.js', [["snapshots[0].fileName.includes('梦飞空间会员账本备份')", "snapshots[0].fileName.includes('会员账本备份')"]]);
edit('server/tests/aligenie.test.js', [["assert.equal(result.returnValue.reply, '梦飞空间欢迎您，请说');", "assert.equal(result.returnValue.reply, '我的门店欢迎您，请说');"], ["assert.equal(welcomeData.response.outputSpeechs[0].text, '梦飞空间欢迎您，请说');", "assert.equal(welcomeData.response.outputSpeechs[0].text, '梦飞造型沙龙欢迎您，请说');"], ['本次洗剪吹理发消费', '本次消费消费']]);
