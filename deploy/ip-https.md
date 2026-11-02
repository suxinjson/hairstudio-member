# 无域名部署：124.70.184.136 的公开 HTTPS

公网 IP 可以使用 HTTPS。证书的 Subject Alternative Name 必须包含 `IP Address:124.70.184.136`，并由手机信任的证书机构签发。普通域名证书不能覆盖 IP 地址；Caddy 默认的本地 CA 证书也不会自动被手机 App 信任。

Let’s Encrypt 已于 2026 年开放 IP 证书，证书有效期为 160 小时，约 6 天。Certbot 5.4 及以上支持通过现有网页服务器的 webroot 验证 IP，适合本项目。官方说明：

- [IP 证书正式开放](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
- [Certbot 申请与续期 IP 证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

下面的命令在 Ubuntu 服务器执行，假定代码已解压到 `~/member`，Docker Engine 和 Compose 已安装。此方案不关闭证书校验，不需要在手机手工安装根证书。

**本文使用 Docker Compose + Caddy + Certbot（Let’s Encrypt），不是 Nginx 或 ZeroSSL。** 按本文部署时，续期后重新加载 Caddy；不要同时设置 Nginx 续期钩子。尚未上传代码或安装 Docker 时，先完成 [Ubuntu 部署说明](ubuntu-server.md)的第 2、3 步，再从本文第 1 步继续。Ubuntu 文档中的域名配置和默认启动命令不用于本 IP 方案。

## 1. 准备配置

安全组允许 TCP 80、443，SSH 使用实际端口。先确认服务器的 80/443 没有被其他服务占用：

```bash
sudo ss -lntp
```

如果已有网站占用这些端口，应在现有反向代理中接入证书验证和会员服务，不要直接停止不明服务。下面的独立部署方案需要占用 80/443。

创建或编辑 `~/member/.env`，配置：

```dotenv
PUBLIC_DOMAIN=124.70.184.136
VITE_CLOUD_SERVER_URL=https://124.70.184.136
POSTGRES_PASSWORD=替换为随机长密码
APP_DATABASE_PASSWORD=替换为另一份独立随机长密码
RELEASE_CERT_SHA256=
```

首次部署分别用两次 `openssl rand -hex 32` 生成两个数据库密码。已有数据库时保留原 `POSTGRES_PASSWORD`，仅新增独立的 `APP_DATABASE_PASSWORD`；`.env` 的文件权限应为 600。旧版首次升级需先备份并按 [维护说明](README.md#已有部署升级)重建私网，保留数据卷。

## 2. 安装支持 IP 证书的 Certbot

Ubuntu 24.04 使用独立 Python 虚拟环境安装 Certbot，避免 Snap 商店连接失败，以及 Ubuntu 软件仓库中的旧版本缺少 IP 参数。华为云 PyPI HTTPS 镜像已提供 Certbot 5.4 及以上版本：

```bash
sudo apt-get update
sudo apt-get install -y python3-venv ca-certificates
sudo python3 -m venv /opt/member-certbot
sudo /opt/member-certbot/bin/python -m pip install --upgrade pip \
  --index-url https://mirrors.huaweicloud.com/repository/pypi/simple/
sudo /opt/member-certbot/bin/python -m pip install --upgrade 'certbot>=5.4,<6' \
  --index-url https://mirrors.huaweicloud.com/repository/pypi/simple/
/opt/member-certbot/bin/certbot --version
```

版本须为 5.4 或以上。上面的安装只修改 /opt/member-certbot 中的虚拟环境，不修改 Ubuntu 系统 Python，也不需要 --break-system-packages。如果镜像连接失败，可将 --index-url 替换为 https://pypi.org/simple 后重试安装命令；不要关闭 HTTPS 验证。

后续申请、续期与更新都使用 /opt/member-certbot/bin/certbot。此安装方式不自带续期定时任务，必须完成第 6 步的 systemd 定时器配置。更新 Certbot 时重新执行上面的 pip 安装命令即可。

## 3. 启动仅用于证书验证的 HTTP 入口

若下面的启动命令在拉取 postgres、node 或 caddy 镜像时提示 registry-1.docker.io 超时，先按 [Docker 网络排查](docker-network.md)配置华为云控制台提供的官方镜像加速地址，验证三个基础镜像均能拉取，再继续。

初次申请时尚无证书，因此先使用临时配置。HTTP 入口只提供 ACME 验证文件，其他请求返回 503，不提供账号登录和记账：

```bash
cd ~/member
sudo mkdir -p /etc/letsencrypt /var/lib/member-acme
sudo docker compose -f compose.yaml -f deploy/compose.ip.yaml \
  -f deploy/compose.ip-bootstrap.yaml up -d --build
sudo docker compose -f compose.yaml -f deploy/compose.ip.yaml \
  -f deploy/compose.ip-bootstrap.yaml ps
```

证书机构需要从公网访问 `http://124.70.184.136/.well-known/acme-challenge/...`。如果这里无法连通，应先核对安全组、系统防火墙和端口占用。

## 4. 申请正式 IP 证书

```bash
read -r -p '证书联系邮箱：' ACME_EMAIL
sudo /opt/member-certbot/bin/certbot certonly --non-interactive --agree-tos \
  --email "$ACME_EMAIL" --cert-name member-ip \
  --preferred-profile shortlived --webroot \
  --webroot-path /var/lib/member-acme --ip-address 124.70.184.136
```

这里申请的是正式、公开信任的证书。测试环境的 `--staging` 证书不能用于 App 正式登录。私钥保留在服务器，不要发给手机或提交 Git。

### 申请时出现 ReadTimeout

如果已显示 Account registered，但访问 acme-v02.api.letsencrypt.org 时出现 read timeout=45，表示某次客户端到证书机构的 HTTPS 请求等待超时；这不是邮箱格式错误，也不能据此认定公网 80 验证失败。保留已注册账号，先在服务器检查出站访问：

```bash
curl -4 --http1.1 -fsS --connect-timeout 10 --max-time 30 \
  https://acme-v02.api.letsencrypt.org/directory
```

预期返回含 newOrder、newNonce 等字段的 JSON。此命令也超时时，先解决服务器出站网络、DNS 或可信代理连接，不要继续切换到正式 HTTPS 配置。Docker 镜像加速器不会加速 Certbot 到证书机构的请求。

如果命令成功，可使用同一个已注册账号重试一次并开启详细输出，不需要删除账号或增加强制续期参数：

```bash
sudo /opt/member-certbot/bin/certbot certonly --non-interactive --agree-tos \
  --cert-name member-ip --preferred-profile shortlived --webroot \
  --webroot-path /var/lib/member-acme --ip-address 124.70.184.136 -v
```

directory 请求成功只证明该次访问可用，不能保证后续订单/验证请求都稳定。若仍超时，结合 /var/log/letsencrypt/letsencrypt.log 定位失败的 API 请求，再处理出站连接。Certbot 的 issuance-timeout 控制签发轮询等待，不能解决上面的单次 HTTP 读取超时；不要修改客户端库、关闭 TLS 验证或写死证书机构 IP 来绕过。

如果随后出现 HTTP-01 验证文件无法访问的错误，再检查 webroot 挂载和公网 80。可以在服务器创建一个不含秘密的测试文件：

```bash
sudo mkdir -p /var/lib/member-acme/.well-known/acme-challenge
printf 'member-acme-ok\n' | sudo tee \
  /var/lib/member-acme/.well-known/acme-challenge/member-connectivity-check.txt >/dev/null
curl -fsS -H 'Host: 124.70.184.136' \
  http://127.0.0.1/.well-known/acme-challenge/member-connectivity-check.txt
```

本机应返回 member-acme-ok，再从另一台设备访问相同路径的公网 IP 地址核对。证书成功安装并完成第 6 步后，还应确认续期演练通过；首次申请偶尔成功不能代替持续稳定的自动续期。

## 5. 切换到 HTTPS 并验证

```bash
sudo docker compose -f compose.yaml -f deploy/compose.ip.yaml up -d
sudo docker compose -f compose.yaml -f deploy/compose.ip.yaml logs --tail=100 web
curl -fsS https://124.70.184.136/api/health
```

预期返回 `{"status":"ok"}`。这里不要加 `curl -k`：默认验证通过才能说明手机可以信任该证书。

首次部署还需创建店主账号。以下命令使用本 IP 方案的两份 Compose 配置；已有店主账号时跳过，不要重复创建：

```bash
cd ~/member
read -r -p '店主账号（英文或数字，至少 3 位）：' ADMIN_USERNAME
read -r -s -p '店主密码（至少 12 位）：' ADMIN_PASSWORD
printf '\n'
export ADMIN_USERNAME ADMIN_PASSWORD
sudo --preserve-env=ADMIN_USERNAME,ADMIN_PASSWORD docker compose \
  -f compose.yaml -f deploy/compose.ip.yaml run --rm --no-deps \
  -e ADMIN_USERNAME -e ADMIN_PASSWORD migrate node server/create-owner.js
unset ADMIN_USERNAME ADMIN_PASSWORD
```

App 设置中的服务器地址使用 `https://124.70.184.136`，再登录店主账号并完成初始账本迁移。迁移前先导出本机 JSON 备份。

## 6. 配置自动续期和重新加载

先保存续期后的 Caddy 重新加载命令，否则容器可能继续使用内存中的旧证书，并验证续期和重新加载：

```bash
cd ~/member
APP_DIR="$(pwd -P)"
RELOAD_HOOK="docker compose --project-directory \"$APP_DIR\" -f \"$APP_DIR/compose.yaml\" -f \"$APP_DIR/deploy/compose.ip.yaml\" exec -T web caddy reload --config /etc/caddy/Caddyfile"
sudo /opt/member-certbot/bin/certbot reconfigure --cert-name member-ip --deploy-hook "$RELOAD_HOOK"
sudo /opt/member-certbot/bin/certbot renew --cert-name member-ip --dry-run --run-deploy-hooks
```

再创建每天检查两次的 systemd 任务。续期是否必要由 Certbot 判断，定时检查不会每次都重新申请证书：

```bash
sudo tee /etc/systemd/system/member-certbot-renew.service >/dev/null <<'EOF'
[Unit]
Description=Renew member IP HTTPS certificate
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/opt/member-certbot/bin/certbot renew --quiet --cert-name member-ip
TimeoutStartSec=15min
EOF

sudo tee /etc/systemd/system/member-certbot-renew.timer >/dev/null <<'EOF'
[Unit]
Description=Check member IP certificate renewal twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now member-certbot-renew.timer
sudo systemctl start member-certbot-renew.service
sudo systemctl list-timers --all member-certbot-renew.timer
sudo journalctl -u member-certbot-renew.service -n 50 --no-pager
```

需确认定时器启用、续期演练与重新加载成功，以及日志没有续期错误。IP 证书有效期很短，应在到期前至少留出 48 小时告警；公网 80 端口和 ACME 验证路径需持续可用。虚拟环境安装方式无需 snap.certbot.renew.timer。如果先前已用其他安装方式配置同一证书的定时续期，应保留一套有效任务，避免重复。

后续启动、更新、查看日志时都要带上 `-f compose.yaml -f deploy/compose.ip.yaml`。证书申请完成后不要再使用 bootstrap 配置。也不要改为 `tls internal` 或关闭 App 的证书校验。

HTTPS 保护网络传输和服务器身份，账号权限、限流、输入校验及服务器防护仍须分别完成。当前安全审查结果见 [接口安全审查](security-review.md)。
