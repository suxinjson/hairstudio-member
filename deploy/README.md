# 云端部署

适用于可运行 Docker Compose 的 Linux 服务器。数据库和 API 仅在 Docker 私有网络中提供服务，公网仅开放 Caddy 的 80/443。首次登录需要联网；已登录的 Android 设备可断网记账，恢复联网后按服务端当前权限同步。

## 首次启动

1. 将域名 A/AAAA 记录指向服务器，开放 TCP 80/443；80 用于 HTTPS 证书申请和跳转。
2. 复制 `.env.example` 为 `.env`，填写 `PUBLIC_DOMAIN`（仅域名，不带协议）和随机数据库密码。真实 `.env` 不要提交 Git。
3. 在项目根目录执行 `docker compose up -d --build`。
4. 创建初始店主账号。密码通过交互输入传入容器，不进入 shell 命令历史：

```sh
read -r -p '店主账号：' ADMIN_USERNAME
read -r -s -p '店主密码（至少 12 位）：' ADMIN_PASSWORD
printf '\n'
export ADMIN_USERNAME ADMIN_PASSWORD
docker compose exec -e ADMIN_USERNAME -e ADMIN_PASSWORD api node server/create-owner.js
unset ADMIN_USERNAME ADMIN_PASSWORD
```

5. 在 App 设置中填写 `https://你的域名`，使用店主账号登录。新云端为空时，选择“上传本机初始账本”；云端已有账本时，先导出本机备份，再决定是否采用云端账本。
6. 店主可在设置中建立店员或只读账号。每个账号属于一个门店；服务器通过登录会话确定门店，忽略客户端自称的角色和门店。

## 权限与离线边界

| 操作 | 店主 | 店员 | 只读 |
|---|---|---|---|
| 查看会员、账本、检查和下载更新 | ✓ | ✓ | ✓ |
| 建档、修改会员、充值、消费 | ✓ | ✓ | — |
| 撤销、注销、定价、恢复账本 | ✓ | — | — |
| 管理账号、查看使用记录、初始迁移 | ✓ | — | — |

账号停用或权限变化时，服务器撤销原会话。断网设备无法即时获知远端撤权，已有登录缓存可继续本机操作；联网后所有上传按最新权限校验，拒绝的记录留在本机，不进入云端。退出登录后本机云端账本锁定，重新登录原账号才能上传其待办记录。

客户端的账本变更与待同步操作通过同一恢复日志原子保存。服务端在 PostgreSQL 事务内锁定门店账本，并一起写入余额、流水、去重记录和使用记录。同一同步单号重试不会重复入账，单号内容变化则拒绝。服务端使用同一记账引擎重新计算余额，不接收客户端直接指定的余额结果。

不同会员的独立操作可以合并。同一会员被两台离线设备修改时，后一批上传会提示冲突，不能自动累加可能重复的消费或充值。本机待办记录保留；必须先导出、人工核对，再选择采用云端账本。采用云端前还会保留本机账本和待办记录在 `hairstudio_cloud_pre_replace_v1`。导出的 JSON 包含 `cloud.outbox`，可供核对。

登录使用带随机盐的 scrypt 密码摘要、限速和短期随机访问令牌；刷新令牌轮换，重放会使相应会话失效。Android 刷新令牌通过 Keystore AES-GCM 加密保存且排除系统备份；浏览器会话令牌仅驻留内存，刷新页面后需要重新登录才能继续同步。无网络错误不会清除待办记录。

SHA-256 校验用于发现传输和存储损坏；服务器数据库管理员仍属于受信任管理员。业务操作的客户端时间用于参考，审计以服务器接收时间为准。系统不会验证微信或现金实际到账，店员仍须确认收款后记账。

## 发布 APK 更新

1. GitHub Actions 构建固定签名的 release APK，同时生成 `update-manifest.json`。下载同一产物中的 APK 和清单。新 `versionCode` 必须高于旧版本。
2. 在 `.env` 中填写同一固定签名证书的 `RELEASE_CERT_SHA256`，重建 API 配置：`docker compose up -d api`。
3. 把 APK 和清单复制进容器，再发布：

```sh
docker compose cp update-manifest.json api:/tmp/update-manifest.json
docker compose cp hairstudio-member-v1.0.123.apk api:/tmp/update.apk
docker compose exec api node server/publish-release.js /tmp/update-manifest.json /tmp/update.apk
```

清单由已验证签名的 CI 产物生成；服务器比对 SHA-256、文件大小、包名、固定证书和递增版本号，发布权限只提供给服务器管理员，不开放给普通 App 账号。下载需要登录，不重定向到其他域名。

Android 下载完成后、打开安装器前都会重新检查哈希、实际包名、实际版本号和与当前安装版本相同的签名证书。用户需在系统中允许应用安装更新并确认安装，App 不会静默安装。下载中断的临时文件不会进入安装流程，可重新下载。

本机开发环境没有 Java/Android SDK 时，`npm run build` 仅验证前端构建及 Capacitor 资源同步；发布前仍须通过 CI 的 Gradle 构建，并用真实签名 APK 在 Android 设备上验证首次登录、断网同步、撤权、下载安装和覆盖升级保留账本。

## 备份、维护与本地测试

数据库卷和 APK 卷都需独立备份，不能只依赖 App 快照：

```sh
mkdir -p backups
docker compose exec -T db pg_dump -U member -d member -Fc > backups/member.dump
```

将数据库备份、发布 APK、清单、固定签名 keystore 和服务器配置分别安全另存。更新服务器前先备份。恢复数据库时停止 API，避免业务写入；恢复后检查备份时间及待同步记录，不可将较旧云端版本自动覆盖到客户端。

本地安装 Node.js 20 以上，运行 `npm ci`、`npm test`、`npm run build` 和 `npm audit --registry=https://registry.npmjs.org`。云端集成测试使用 PGlite 内嵌 PostgreSQL，不要求本机安装数据库或 Docker；生产使用 PostgreSQL 17。它验证 SQL 事务、权限、重试、断网和冲突；真实 PostgreSQL 多连接锁竞争及 Caddy 证书申请还需在部署环境检查。
