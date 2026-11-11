const fs = require('node:fs');
const path = require('node:path');
const files = ['capacitor.config.json','index.html','admin/index.html','package.json','README.md','android/app/src/main/res/values/strings.xml'];
function list(dir) { for (const entry of fs.readdirSync(dir,{withFileTypes:true})) { const f=path.join(dir,entry.name); if(entry.isDirectory()) list(f); else if(/\.(vue|js|md|sh|yml|html)$/.test(f)) files.push(f); } }
list('src'); list('admin/src'); list('deploy');
const replacements = [
 ['梦飞空间会员管家','会员管家'],['梦飞会员管家','会员管家'],['梦飞会员','会员管家'],
 ['梦飞空间会员账本备份','会员账本备份'],['梦飞空间账本原始数据','账本原始数据'],['梦飞空间对账明细','对账明细'],
 ['梦飞空间会员批量导入模板','会员批量导入模板'],['梦飞空间全量会员档案','会员全量档案'],['梦飞空间全量财务流水','会员财务流水'],
 ['梦飞空间系统安全审计日志','会员管家安全审计日志'],['梦飞空间安全审计日志','会员管家安全审计日志'],
 ['梦飞空间财务对账流水明细','会员财务对账流水明细'],['梦飞空间会员明细表','会员明细表'],
 ['收银 / 发型师','收银 / 店员'],['如：李发型师、王收银','如：李店员、王收银'],['如：喜好修剪发梢，偏好某位发型师','如：服务偏好、客户需求、注意事项'],
 ['如：洗剪吹 / 精油护理','如：商品购买 / 服务项目'],['理发店安心记账小贴士','门店安心记账小贴士'],
 ['💈 服务项目与定价设置','🛍️ 服务项目与定价设置'],['💈','💳']
];
for(const f of files) { let s=fs.readFileSync(f,'utf8'), next=s; for(const [a,b] of replacements) next=next.split(a).join(b); if(s!==next) fs.writeFileSync(f,next); }
