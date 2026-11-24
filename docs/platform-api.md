# 平台接口与权限约定

本文描述平台 API。商家 v2 账本另见 [关系化合同](relational-api.md)；平台与商家身份隔离，平台不能越过商家资金、代际及审计规则。

平台前缀为 /api/platform/v1，除登录外都需要 Authorization: Bearer <平台令牌>。平台与商家令牌完全隔离；所有 JSON 写入须使用 Content-Type: application/json，默认体积上限 16 KiB。平台数据不进入商家增量及业务归档。

## 路由

| 方法与路径 | 权限 | 行为 |
| --- | --- | --- |
| POST /auth/login | 公开、限流 | username/password 换取平台令牌、到期时间和权限 |
| GET /auth/me | 平台登录 | 重新读取当前账号、角色与权限 |
| POST /auth/logout | 平台登录 | 撤销本次平台会话 |
| POST /auth/password | 平台登录 | currentPassword/password；撤销该平台用户所有会话 |
| GET /stores | stores.read | 名称前缀 search、uuid 游标 before、limit 1–100 |
| POST /stores | stores.write | storeName/displayName/username/password；新店默认无许可证 |
| PATCH /stores/:id | stores.write | status=active/suspended、expectedVersion |
| GET /stores/:id/users | users.read | 查看门店账号，不返回密码摘要 |
| PATCH /users/:id | users.write | storeId/role/disabled/expectedVersion；可选 password 重置 |
| GET /stores/:id/license | licenses.read | 当前在线许可及最多 100 条最近离线签发记录 |
| POST /stores/:id/license | licenses.write | 在线许可签发、续期或功能策略修改 |
| POST /stores/:id/offline-licenses | licenses.write | 签发设备绑定离线码 |
| GET /operators | operators.read | 平台账号列表 |
| POST /operators | operators.write | username/displayName/password/role/active |
| PATCH /operators/:id | operators.write | displayName/role/active/expectedVersion；可选 password |
| GET /logs | logs.read | kind=platform/merchant/diagnostic，before/limit，可选 storeId |
| GET /system | system.read | 当前实例诊断指标、签发公钥和部署边界 |

列表默认最多 50 条，日志按 id 倒序；将最后一条 id 作为 before 获取下一页。门店目录使用 uuid 倒序稳定游标，UUID 顺序不是创建时间顺序。不要把页面返回条数当作总数。

在线许可请求：active 为布尔值，features 为允许列表，offlineHours 为 0–8760 整数，expectedVersion 在初次创建时为 -1。action=renew 时，permanent=true 且 days=null 代表永久，或 permanent=false 且 days 为 1–36500 整数；action=policy 时保留原期限。写入与平台审计同事务提交。

离线签发请求：deviceId、本地 username/displayName、features、permanent/days。返回 code 和 payload；payload 包含 v、mode、id、storeId、storeName、deviceId、issuedAt、notBefore、expiresAt、features 和只限本店的本地 owner 身份。格式为 ML1.keyId.base64url(payload).base64url(signature)，签名覆盖前三段 UTF-8 原文，ECDSA P-256 / SHA-256，IEEE P1363 的 64 字节签名。验签密钥只来自构建时的受信公钥表。

## 身份与权限表

merchant_roles / merchant_permissions / merchant_role_permissions 是商家角色目录，users 带 store_id；owner/clerk/viewer 保持原资金权限分工。平台使用 platform_users、platform_roles、platform_permissions、platform_role_permissions、platform_sessions。平台角色是固定目录，不提供任意 SQL 或运行时改权限表的接口。

| 角色 | 范围 |
| --- | --- |
| superadmin | 全部平台权限、平台账号管理 |
| operator | 门店/商家用户/商业许可读写、日志查询 |
| developer | 门店目录只读、日志、运行状态和公钥 |
| auditor | 门店及授权只读、日志查询 |

平台用户停用使用 users.platform_disabled，商家只能修改 users.active。二者任一禁止时均不能在线使用。在线商家身份来自 users/sessions，而非请求中的 role/storeId。平台没有把某店 owner 当作超级管理员的隐式规则。

基础访问要求 core；业务写入按 members/cashier/backup/settings 功能检查；员工、设备和云端语音接口分别要求 staff/devices/voice。语音 webhook 同样核验门店及 actor 状态，并要求相应商业能力。reports 和数据导出界面按功能展示，但不能作为已授权读取数据的保密边界。

## 错误与一致性

响应错误形如 error/code，HTTP 401 表示身份失效，403 表示状态或权限不允许，409 表示版本或唯一键冲突，413 表示预算上限，429 表示限流，503 表示依赖或容量暂不可用。X-Request-Id 用于诊断关联，500 不返回数据库错误详情。

常见商业错误：LICENSE_REQUIRED、LICENSE_EXPIRED、STORE_DISABLED、USER_DISABLED、FEATURE_DISABLED。原生 App 收到已认证请求的上述拒绝或 AUTH_REQUIRED 后持久化锁定，避免断网继续使用已知失效的旧租期；成功在线核验可恢复。独立离线模式不发起在线授权请求。

版本冲突 VERSION_CONFLICT 必须刷新并由操作者核对，不做自动重试覆盖。最后一位平台超级管理员受数据库事务锁保护。商家资金写入由 v2 服务核对账本代际、目标账户版本和原命令回执，使用账户行锁与 SQL 事务；平台没有直接修改余额接口。

平台控制面当前与商家 API 共用受限运行数据库账号和连接池，以应用认证隔离权限。生产若要求更强的数据库级控制面隔离，应把平台 API 拆为独立进程与 DB 角色，仅授予平台所需表和列；不要直接开放数据库超级用户。
