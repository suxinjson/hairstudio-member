# 会员管家

单店会员、储值和收银。网页收银和商家后台走在线 PostgreSQL；Android 可绑定云端账本，或凭独立离线许可在手机 SQLite 中营业。**v2 候选已接通，当前尚未放行发布或切换真实业务。**

- [文档总入口](docs/README.md)
- [重构评估与正式切换](docs/relational-refactor-assessment.md) · [专项测试与发布门槛](docs/refactor-test-plan.md) · [实施台账](docs/refactor-implementation.md)
- [云端部署](deploy/README.md) · [平台授权](docs/platform-operations.md) · [语音接入](deploy/voice-integration.md) · [APK 签名](deploy/github-apk.md)

| 入口 | 用途 |
| --- | --- |
| `/` | 在线收银：查会员、充值、消费、冲正、流水和报表，按商家角色及许可开放 |
| `/admin/` | 商家：会员和资料批次、服务/充值设置、报表、期初、备份恢复、表格导出及账号设备管理 |
| `/admin/platform.html` | 平台：门店及商业授权、平台账号、诊断审计；使用单独会话 |
| Android | 门店在线登录及 SQLite 副本；或离线授权并设置本地密码。本机账本、同步待办及应用更新提示在 App 内查看。 |

## 开发与验证

使用 Node.js 22 安装锁定依赖。Android 构建另需 Java 21、项目指定 SDK 和 Gradle wrapper。

~~~sh
npm ci
npm test
npm run refactor:test
npm run refactor:audit
npm run build:web
npm run admin:build
npm run build              # 构建收银并同步入 Android
~~~

本地 Web 使用 `npm run dev` 与 `npm run admin:dev`，两者把 `/api` 代理至本机 API。连接独立的空开发 PostgreSQL 后，使用迁移身份运行 `npm run server:migrate`，再换应用身份运行 `npm run server`。默认测试用 PGlite 和文件 SQLite；真实 PostgreSQL 多连接测试须用 [专用可丢弃数据库](docs/refactor-implementation.md#验证命令与当前证据)。对旧库执行 v2 数据库迁移会被拒绝。

源码目录：`src/` 是收银、共享领域与 SQLite；`admin/` 是两个在线后台；`server/` 是 API、SQL schema 与授权服务；`android/` 是原生数据库、安全存储、文档和安装器；`tools/` 为数据转换与验收命令。`output/` 下的本机证据不随源码发布，保留验收件后再执行 `npm run clean`。

## 账本、备份与升级

- 金额按整数分保存。充值实收、赠送、消费与全额冲正分开；期初只结转已核定的剩余余额，不计收入或新客。冲正改变账面资金，不自动退现金或微信付款。
- 云端绑定时 PostgreSQL 是已确认账本；SQLite 离线改动留原号待同步，冲突不得自动重做。独立离线账本以手机 SQL 为权威，不自动上传。网页只保留会话和必要未明请求信息。
- PG 或独立离线 SQLite 日常备份分别导出自己的流式文件；恢复只允许同店空目标，核对源和内容后产生新代际。手机云端副本过期时需联网由店主重建，原账号先核对并保存旧待办。业务备份不含账号密码或签发密钥。
- 从旧版切换时只迁移真实 91 人关键档案和剩余余额。停写后先确认最后一笔旧账，在应用外验证两份独立备份，再按方案开新账。不得使用日常 v2 恢复入口导入旧快照。
- 日常应用内更新须保持包名和正式签名、递增 `versionCode`。卸载会删除本机数据；先独立读回外部备份。Debug APK 只用于测试，不可替代发布包。
- 推送或普通 Actions 运行仅验证。正式发布需人工 dispatch 勾选 `release` 且 `RELATIONAL_RELEASE_APPROVED=true`；候选达到门槛前保持关闭。密钥和真实数据不得提交仓库。
