# 语音服务与天猫精灵接入

2026-11-06 升级需要同时更新 API、PC 管理端和移动端。先备份数据库，再运行迁移任务；新增 `voice_dialogs`、`voice_requests` 两张表及受限运行角色授权。Docker 部署的 API 新增 `voice_egress` 出站网络，数据库继续只接入内部私网。

## 合成服务

前端不再提供内置 API Key，任何角色的配置响应都不返回密钥。历史公开的两枚密钥已由服务器按 SHA-256 指纹拒绝使用；部署负责人仍须到对应供应商后台撤销旧密钥、检查用量并生成新密钥，再由店主在语音设置页保存。删除源代码不能撤销供应商的凭据，旧 Git 历史或缓存中的凭据应视为已泄漏。

默认允许 `https://api.fish.audio`、`https://api.heygen.com`、`https://resource2.heygen.ai`。自定义接口或供应商新增音频域名必须由部署管理员设置 `VOICE_ALLOWED_ORIGINS`，填写逗号分隔的完整 HTTPS 来源，例如 `https://voice.example.com`。不填写路径、查询参数、IP 地址或通配符。API 和 HeyGen 音频下载共用此规则，解析到内网/保留地址、混合内外网 DNS 或重定向均被拒绝，实际连接固定到已验证地址并继续验证原域名证书。

合成不持有数据库事务；每个 API 进程最多 4 个并行请求，满载返回 429。音频上限 8 MiB，HeyGen JSON 上限 64 KiB，上游错误正文上限 8 KiB。Fish Audio 超时 20 秒，HeyGen 合成及下载共用 25 秒期限。只有店主的 `test: true` 可以试听未启用的草稿配置。

## 天猫精灵签名网关

旧的缺省门店选择、URL token 和未签名请求已停用，历史配置默认关闭。店主在 PC 的语音设置页选择在用店主/收银员作为记账账号，填写设备白名单，生成并保存新的随机签名密钥。不要复用历史 webhook token。签名密钥只存放于 API 和受控网关；不得嵌入网页或设备端，也不得部署无鉴权的公网转签名代理。

网关先按平台官方接入规则验证请求身份，再从已验证的平台请求中取得用户、设备、请求和会话标识。若当前平台无法提供可验证身份，应保持语音记账关闭。不要直接相信未经鉴权的来访者提交的这些字段。

网关调用 `POST /api/v1/voice/aligenie`，使用 HTTPS，并提供：

| 字段 | 要求 |
| --- | --- |
| `x-store-id` | 明确绑定的门店 UUID |
| `x-aligenie-timestamp` | 当前 Unix 毫秒时间，13 位；允许前后 5 分钟 |
| `x-aligenie-signature` | 下述 HMAC-SHA256，64 位小写十六进制 |
| 请求体 `requestId` / `request.requestId` | 每次平台请求的稳定唯一标识；重试保留原值与原正文 |
| `sessionId` / `session.sessionId` | 稳定会话标识 |
| `context.System.device.deviceOpenId` | 已验证且在白名单中的设备 |
| `context.System.user.userOpenId` | 已验证的平台用户 |
| `confirmationRequestId` | 确认时回传预览响应的同名字段，绑定所确认的原请求 |

签名原文为 `timestamp + "\n" + storeId + "\n" + canonicalJSON(body)`，不包含末尾换行。`canonicalJSON` 按键排序对象、保持数组顺序，使用仓库 `src/sync-protocol.js` 导出的实现。Node.js 网关可调用 `server/aligenie.js` 导出的 `signAliGenieRequest(secret, timestamp, storeId, body)`；其他语言必须采用一致序列化方式。

```js
const timestamp = String(Date.now());
const headers = {
  'Content-Type': 'application/json',
  'x-store-id': storeId,
  'x-aligenie-timestamp': timestamp,
  'x-aligenie-signature': signAliGenieRequest(secret, timestamp, storeId, body)
};
// 使用 HTTPS 发送 JSON.stringify(body)。网络重试保留 body，可更新时间和签名。
```

鉴权失败返回 HTTP 401/403；请求格式无效返回 400；同一请求单号换正文返回 409。查询也要求签名。确认前的待办有效期为 5 分钟，绑定门店、记账账号、设备、平台用户、会话及配置；确认必须引用原预览。取消后的晚到确认不能执行新待办。

预览保存固定业务单号、时间及会员/规则条件。余额、会员资料、归档状态、服务价格或充值规则变化时，确认被拒绝，需重新发起并确认。财务写入、待办消除及响应回执在同一数据库事务提交；失败保留原待办，重启后可继续，成功请求重试返回原响应，不重复入账。响应回执保留一天，每店最多 10,000 条；每店最多 256 个有效待办。过期请求时间戳不能重放。

## PC 版本冲突恢复

已见版本按服务器来源和门店持久保存，重载、退出登录及多窗口均不清除。检测到回退、同版本校验值变化或损坏后禁止财务同步。PC 上传前检查云端版本，并在 `/sync` 中携带 `observedHead`，API 在账本锁内再次检查。

店主解锁后点击“导出版本冲突并核对账本”，确认导出文件已保存并核对本机记录、原待办和云端账本，然后明确选择云端版本作为新基准。服务端核对预期版本并记录审计事件；原待办及导入进度保留，继续核对或取消未入账操作。云端自身校验失败时必须先修复服务器数据，不能通过该流程绕过校验。
