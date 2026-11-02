# 云端部署

适用于可运行 Docker Compose 的 Linux 服务器。数据库和 API 仅在 Docker 私有网络中提供服务，公网仅开放 Caddy 的 80/443。首次登录需要联网；已登录的 Android 设备可断网记账，恢复联网后按服务端当前权限同步。

针对 `124.70.184.136` 的 Ubuntu 部署步骤见 [Ubuntu 服务器部署](ubuntu-server.md)。

没有域名时，可使用 [公网 IP HTTPS 部署方案](ip-https.md)，通过 Certbot 申请公开信任的 IP 证书并自动续期。接口权限与防护的检查结果见 [接口安全审查](security-review.md)。

## 首次启动

1. 将域名 A/AAAA 记录指向服务器，开放 TCP 80/443；80 用于 HTTPS 证书申请和跳转。
2. 复制 `.env.example` 为 `.env`，填写 `PUBLIC_DOMAIN`（仅域名，不带协议），分别生成 `POSTGRES_PASSWORD` 和 `APP_DATABASE_PASSWORD` 两份独立随机密码，建议各使用 `openssl rand -hex 32`。真实 `.env` 不要提交 Git。
3. 在项目根目录执行 `docker compose up -d --build`。
4. 创建初始店主账号。密码通过交互输入传入容器，不进入 shell 命令历史：

```sh
read -r -p '店主账号：' ADMIN_USERNAME
read -r -s -p '店主密码（至少 12 位）：' ADMIN_PASSWORD
printf '\n'
export ADMIN_USERNAME ADMIN_PASSWORD
docker compose run --rm --no-deps -e ADMIN_USERNAME -e ADMIN_PASSWORD migrate node server/create-owner.js
unset ADMIN_USERNAME ADMIN_PASSWORD
```

5. 在 App 设置中填写 `https://你的域名`，使用店主账号登录。本机有会员、流水或自定义服务定价、充值档位时，新云端为空则选择“上传本机初始账本”；云端已有账本时，先导出本机备份，再决定是否采用云端账本。只有本机没有会员和流水且使用默认设置时，才会自动采用云端账本。
6. 店主可在设置中建立店员或只读账号。每个账号属于一个门店；服务器通过登录会话确定门店，忽略客户端自称的角色和门店。

App 的默认云服务器地址已设为 `https://124.70.184.136`。使用 IP 直连需要该 IP 的有效、受设备信任的 HTTPS 证书。若服务器使用域名证书，将域名解析到 `124.70.184.136`，在 App 登录页面填写该 HTTPS 域名，并将部署的 `PUBLIC_DOMAIN` 设为该域名。首次登录成功并完成账本选择后才会绑定设备。

本地构建可在 `.env` 中设置 `VITE_CLOUD_SERVER_URL` 后运行 `npm run build`，更改新设备的默认地址；已有设备保留原地址。Docker 前端构建同样读取 `VITE_CLOUD_SERVER_URL`，未设置时使用 `https://124.70.184.136`。

## 权限与离线边界

| 操作 | 店主 | 店员 | 只读 |
|---|---|---|---|
| 查看会员、账本、检查和下载更新 | ✓ | ✓ | ✓ |
| 建档、修改会员、充值、消费 | ✓ | ✓ | — |
| 撤销、注销、定价、恢复账本 | ✓ | — | — |
| 管理账号、查看使用记录、初始迁移 | ✓ | — | — |

账号停用或权限变化时，服务器撤销原会话。断网设备无法即时获知远端撤权，已有登录缓存可继续本机操作；联网后所有上传按最新权限校验，拒绝的记录留在本机，不进入云端。退出登录后本机云端账本锁定，重新登录原账号才能上传其待办记录。

原账号重新登录后，如待办超出当前权限，设置页会显示核对入口。先导出本机账本与待同步记录，交由店主核对，再选择采用云端账本；恢复原账号权限并重新登录也可继续同步原待办。两台设备竞争初始化时，失败设备同样进入核对流程，初始账本和待办不会被自动删除。普通断网或确认响应丢失仍保留同一同步单号进行重试。

客户端的账本变更与待同步操作通过同一恢复日志原子保存。服务端在 PostgreSQL 事务内锁定门店账本，并一起写入余额、流水、去重记录和使用记录。同一同步单号重试不会重复入账，单号内容变化则拒绝。服务端使用同一记账引擎重新计算余额，不接收客户端直接指定的余额结果。

不同会员的独立操作可以合并。同一会员被两台离线设备修改时，后一批上传会提示冲突，不能自动累加可能重复的消费或充值。本机待办记录保留；必须先导出、人工核对，再选择采用云端账本。采用云端前还会保留本机账本、原始存储文本和待办记录在 `hairstudio_cloud_pre_replace_v1`。设置页“导出本机账本与待同步记录”生成的 JSON 包含 `cloud.outbox`，可供核对；数据损坏时仍可导出原始文本。

云端绑定设备的本机账本损坏时，店主可以断网导入有效 JSON 备份进行全量恢复。恢复前的原始文本与原待办保存在 `hairstudio_pre_restore_safety_snapshot`；恢复后暂停自动上传和记账，保留绑定与原待办。联网后先导出核对，再选择采用云端账本，或由店主点击“确认上传恢复后的本机账本”。确认上传会归档原待办，以一个可重试的完整恢复操作替代它们，并按最新云端账本校验并发冲突；其他设备在此期间修改账本会导致恢复被拒绝，不会覆盖它们的交易。上传响应丢失时使用“立即同步”重试同一恢复操作。恢复点保存失败会阻止覆盖。

登录使用带随机盐的 scrypt 密码摘要、限速和短期随机访问令牌；刷新令牌轮换，重放会使相应会话失效。Android 刷新令牌通过 Keystore AES-GCM 加密保存且排除系统备份；浏览器会话令牌仅驻留内存，刷新页面后会显示登录入口并锁定云端账本，重新登录原账号才能继续同步。账本、绑定、待办及冲突信息仍会保留。无网络错误不会清除待办记录。

SHA-256 校验用于发现传输和存储损坏；服务器数据库管理员仍属于受信任管理员。业务操作的客户端时间用于参考，审计以服务器接收时间为准。系统不会验证微信或现金实际到账，店员仍须确认收款后记账。

## 发布 APK 更新

1. GitHub Actions 构建固定签名的 release APK，同时生成 `update-manifest.json`。下载同一产物中的 APK 和清单。新 `versionCode` 必须高于旧版本。
2. 在 `.env` 中填写同一固定签名证书的 `RELEASE_CERT_SHA256`。
3. 使用一次性管理员容器读取当前目录的 APK 和清单并发布：

```sh
docker compose run --rm --no-deps \
  --volume "$PWD/update-manifest.json:/tmp/update-manifest.json:ro" \
  --volume "$PWD/hairstudio-member-v1.0.123.apk:/tmp/update.apk:ro" \
  migrate node server/publish-release.js /tmp/update-manifest.json /tmp/update.apk
```

清单由已验证签名的 CI 产物生成；服务器比对 SHA-256、文件大小、包名、固定证书和递增版本号，发布权限只提供给服务器管理员，不开放给普通 App 账号。下载需要登录，不重定向到其他域名。

API 对发布表只有读取权限，对 APK 卷只读。创建门店、执行迁移及发布更新均使用短期管理员容器；管理员密码不会传入 API 容器。

Android 下载完成后、打开安装器前都会重新检查哈希、实际包名、实际版本号和与当前安装版本相同的签名证书。用户需在系统中允许应用安装更新并确认安装，App 不会静默安装。下载中断的临时文件不会进入安装流程，可重新下载。

本机开发环境没有 Java/Android SDK 时，`npm run build` 仅验证前端构建及 Capacitor 资源同步；发布前仍须通过 CI 的 Gradle 构建，并用真实签名 APK 在 Android 设备上验证首次登录、断网同步、撤权、下载安装和覆盖升级保留账本。

## 备份、维护与本地测试

### 已有部署升级

升级前备份数据库、`.env` 与 APK 卷。保留旧 `POSTGRES_PASSWORD`，在 `.env` 新增独立的 `APP_DATABASE_PASSWORD`。此次配置给 Caddy 固定私网地址，因此旧网络须停机重建；以下命令不删除数据卷：

```sh
docker compose exec -T db pg_dump -U member -d member -Fc > backups/member-before-hardening.dump
docker compose down
docker compose up -d --build
docker compose logs --tail=100 migrate api web
docker compose exec -T db psql -U member -d member -c \
  "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='member_app';"
```

先创建权限为 700 的 `backups` 目录并设 `umask 077`。使用 IP HTTPS 时，上面的每条 `docker compose` 都应加 `-f compose.yaml -f deploy/compose.ip.yaml`。不要使用 `down -v`。管理员角色仍叫 `member`，兼容现有 PostgreSQL 卷；运行时角色叫 `member_app`，上述特权列须全部为 `f`。API 在生产启动时检查角色并拒绝特权连接。

默认私网为 `172.30.184.0/24`，Caddy 为 `172.30.184.10`。如果与现有 Docker/VPN 网络冲突，同时设置 `.env` 的 `MEMBER_PRIVATE_SUBNET` 和位于其中的 `MEMBER_PROXY_IP`，重建网络。API 只信任该明确地址，不信任整个私网，也不公开 3000/5432。

迁移失败时 API 不启动；先查看迁移日志，核对原管理员密码和新增应用密码，不要删除数据库卷重试。手工 Node.js 部署先用管理员连接执行 `npm run server:migrate`（设置 `APP_DATABASE_PASSWORD`），再用 `PGUSER=member_app` 和应用密码运行 `npm run server`。生产设置 `NODE_ENV=production` 与准确的 `TRUSTED_PROXY_IPS`，反向代理必须覆盖 HTTPS 转发头并追加实际客户端地址。

数据库卷和 APK 卷都需独立备份，不能只依赖 App 快照：

```sh
mkdir -p backups
docker compose exec -T db pg_dump -U member -d member -Fc > backups/member.dump
```

将数据库备份、发布 APK、清单、固定签名 keystore 和服务器配置分别安全另存。更新服务器前先备份。恢复数据库时停止 API，避免业务写入；恢复后检查备份时间及待同步记录，不可将较旧云端版本自动覆盖到客户端。

本地安装 Node.js 20 以上，运行 `npm ci`、`npm test`、`npm run build` 和 `npm audit --registry=https://registry.npmjs.org`。云端集成测试默认使用 PGlite 内嵌 PostgreSQL，不要求本机安装数据库或 Docker；生产使用 PostgreSQL 17。它验证 SQL 事务、权限、重试、断网和冲突；真实 PostgreSQL 多连接锁竞争可按下面的方式验证，Caddy 证书申请仍需在部署环境检查。

可连接到专用 PostgreSQL 17 测试实例，设置 `MEMBER_TEST_DATABASE_URL` 后运行 `npm test`，切换云端集成测试至真实多连接 PostgreSQL，并启用同会员并发消费、不同会员并发消费、恢复与消费竞争三项验证。并发登录额度测试也在同一模式运行。测试在随机生成的独立 schema 中创建表，完成后删除该 schema；连接账号需有创建 schema 权限。未设置此变量时三项账本锁竞争检查跳过，其他测试继续使用 PGlite。

如需真实数据库角色验证，同时设置 `MEMBER_TEST_ADMIN_DATABASE_URL` 指向专用、可丢弃的临时 PostgreSQL 集群；账号需要创建数据库/角色权限，集群不能存在 `member_app`。该测试创建独立数据库并配置固定名称的运行角色，完成后清理。不要连接生产或共享集群。默认角色测试使用独立 PGlite 实例。
