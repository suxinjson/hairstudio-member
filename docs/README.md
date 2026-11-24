# 会员管家 v2：架构、重构与验收

截至 2026-11-20，网页收银、商家后台、Android 与天猫精灵已接入 v2。云端账本在独立 PostgreSQL，手机账本在 SQLite。**候选可进入隔离验收，正式发布和营业切换仍阻断。** 当前候选通过本机合成 91 人只读 HTTPS 开账恢复、重复上传修复回归、干净 Linux 环境部署回归 17/17，以及 Chromium 登录、会员搜索、档案查看和 2 元充值 UI/API 冒烟；该浏览器冒烟使用工作站 loopback 服务，不代替目标 HTTPS 验收。PostgreSQL 10,000 人/100 万笔归档恢复、逐户对账与 20 店隔离报告来自上一版未变的归档和数据库实现。以[实施台账](refactor-implementation.md)锁定源码包、证据来源和复用范围；目标服务、目标 HTTPS 浏览器和正式签名 APK 真机分别签收后，再停写并核对真实 91 人期初。

| 要办的事 | 从这里开始 |
| --- | --- |
| 定范围、停写、导入、回退 | [全量重构评估与切换方案](relational-refactor-assessment.md) |
| 核对功能、不变量、性能、安全和发布条件 | [专项测试计划与发布门槛](refactor-test-plan.md) |
| 查看当前候选版、运行命令和剩余阻断 | [重构实施台账](refactor-implementation.md) |
| 对接隔离环境、配置 HTTPS 施压、签收正式真机结果 | [目标环境验收执行单](refactor-target-acceptance.md) |
| 记录目标验收和正式开账签收 | [受控验收记录模板](refactor-acceptance-record-template.md) |
| 接口、账本代际、原号重试、异步表格与备份恢复 | [v2 接口合同](relational-api.md) |
| 角色、隔离和数据流 | [平台与账本架构](platform-architecture.md) · [平台 API](platform-api.md) |
| 初始化、授权与运维 | [部署手册](../deploy/README.md) · [平台操作](platform-operations.md) · [平台验证](platform-validation.md) |
| 验收 Android 签名、文件读回与安装器 | [Android 真机验收](../deploy/android-install-verification.md) |

在线收银：`/`；商家后台：`/admin/`；平台后台：`/admin/platform.html`。平台、商家和手机独立离线账号不互通。正式切换只迁移本店 91 人的关键档案和剩余余额；最后一笔旧账与两份应用外备份须先核验。
