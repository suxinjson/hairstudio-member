# 在 124.70.184.136 上部署会员云服务

以下按 Ubuntu 服务器首次部署编写。项目会运行 PostgreSQL、会员 API 和 Caddy 三个容器，Caddy 提供网页和 HTTPS API；服务器不需要安装 Node.js、Java 或 Android SDK。

只有公网 IP、没有域名时，上传和 Docker 安装步骤仍可使用；HTTPS 的配置、启动和续期请使用 [IP HTTPS 部署方案](ip-https.md)，不要按下面的域名证书流程直接启动。

## 1. 准备域名与端口

将自己的域名（例如 `member.your-domain.com`）的 A 记录指向 `124.70.184.136`。示例域名须换成自己的实际域名。如果设置了 AAAA 记录，也必须指向该服务器的有效 IPv6 地址。

在云服务器安全组和系统防火墙中允许 TCP 80、443；SSH 使用服务器实际配置的端口。此部署不需要公网开放 3000、5432。

本步骤使用域名 HTTPS，由 Caddy 自动申请并续期证书。若直接使用 `https://124.70.184.136`，必须另行配置覆盖此 IP 的有效、受设备信任的 HTTPS 证书。App 的账号登录和更新下载均要求 HTTPS。

## 2. 上传当前代码

部署包包含本次修复和服务器地址配置。先在本机 PowerShell 上传（`ubuntu` 换成自己的 SSH 用户名；默认 SSH 端口为 22）：

```powershell
scp D:\UGit\member\releases\server\member-deploy.tar.gz ubuntu@124.70.184.136:~/member-deploy.tar.gz
ssh ubuntu@124.70.184.136
```

使用自定义 SSH 端口时，`scp` 加 `-P 端口`，`ssh` 加 `-p 端口`；使用密钥时都可加 `-i 本机密钥路径`。

后续命令在服务器的 SSH 会话中执行：

```bash
mkdir -p ~/member
tar -xzf ~/member-deploy.tar.gz -C ~/member
cd ~/member
```

## 3. 安装 Docker Compose

先检查：

```bash
docker --version
docker compose version
```

如果还没有 Docker，Ubuntu 24.04 可以直接使用系统软件源安装 Docker 和 Compose v2。已有可用的华为云 Ubuntu 镜像源时，此方式不需要访问 get.docker.com：

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo docker --version
sudo docker compose version
```

如果提示找不到 docker.io 或 docker-compose-v2，先启用 Ubuntu universe 仓库，再重试：

```bash
sudo apt-get install -y software-properties-common
sudo add-apt-repository -y universe
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo docker compose version
```

也可按 [Docker 官方安装说明](https://docs.docker.com/engine/install/ubuntu/)安装 Docker 官方仓库的软件包。在首次部署的服务器上，官方便捷安装脚本是另一种选择；若出现连接重置或网络超时，使用上面的 Ubuntu 软件源方式即可：

```bash
sudo apt-get update
sudo apt-get install -y curl openssl
curl -fsSL https://get.docker.com -o /tmp/member-install-docker.sh
sudo sh /tmp/member-install-docker.sh
sudo systemctl enable --now docker
sudo docker compose version
```

已有 Docker 的服务器跳过安装脚本。

如果 Docker 已安装，但拉取镜像出现 registry-1.docker.io 超时，按 [Docker 网络排查](docker-network.md)处理。安装软件源与 Docker Hub 是不同下载入口，软件安装成功不代表镜像一定能拉取。

## 4. 创建配置并启动

以下命令生成随机数据库密码和权限为仅当前用户可读写的 `.env`，已有配置会保留。输入自己的实际域名，不带 `https://`、路径或端口：

```bash
cd ~/member
if [ ! -e .env ]; then
  read -r -p '已解析到 124.70.184.136 的域名：' PUBLIC_DOMAIN
  umask 077
  {
    printf 'PUBLIC_DOMAIN=%s\n' "$PUBLIC_DOMAIN"
    printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'APP_DATABASE_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'VITE_CLOUD_SERVER_URL=https://%s\n' "$PUBLIC_DOMAIN"
    printf 'RELEASE_CERT_SHA256=\n'
  } > .env
else
  printf '保留现有 .env，请核对域名和默认服务器地址。\n'
fi
if ! grep -q '^APP_DATABASE_PASSWORD=' .env; then
  umask 077
  printf 'APP_DATABASE_PASSWORD=%s\n' "$(openssl rand -hex 32)" >> .env
fi
chmod 600 .env
sudo docker compose up -d --build
```

`RELEASE_CERT_SHA256` 可以暂时留空，不影响账号和记账；需要发布 APK 更新时再填写长期使用的签名证书指纹。已有数据库时不要随意修改 `POSTGRES_PASSWORD`。

`POSTGRES_PASSWORD` 仅用于一次性迁移和服务器管理员命令；API 使用 `APP_DATABASE_PASSWORD` 对应的受限 `member_app` 角色。迁移任务自动创建/更新角色与权限，不重建数据卷。旧版升级的停机备份与网络迁移步骤见 [部署维护说明](README.md#已有部署升级)。

检查容器和日志：

```bash
sudo docker compose ps
sudo docker compose logs --tail=100 api web
```

如果提示 80/443 被占用，先确认现有网站和反向代理配置，再决定如何接入；不要直接停止不明服务。

## 5. 创建初始店主

首次创建一个店主账号即可。密码至少 12 位，输入时不会显示，也不写入命令历史：

```bash
read -r -p '店主账号（英文或数字，至少 3 位）：' ADMIN_USERNAME
read -r -s -p '店主密码（至少 12 位）：' ADMIN_PASSWORD
printf '\n'
export ADMIN_USERNAME ADMIN_PASSWORD
sudo --preserve-env=ADMIN_USERNAME,ADMIN_PASSWORD docker compose run --rm --no-deps \
  -e ADMIN_USERNAME -e ADMIN_PASSWORD migrate node server/create-owner.js
unset ADMIN_USERNAME ADMIN_PASSWORD
```

创建成功会显示门店 ID。重复使用同一账号会报冲突，不需要为每次启动重新创建店主。

## 6. 验证并绑定 App

把下面的域名换成自己实际配置的域名：

```bash
curl -fsS https://member.your-domain.com/api/health
```

预期返回 `{"status":"ok"}`。随后浏览器打开同一 HTTPS 地址，确认网页可访问。

在 App 的“设置 → 云端账号与同步”中，将默认 IP 地址改成自己的 HTTPS 域名，输入刚创建的店主账号和密码。云端为空时选择“上传本机初始账本”；登录和迁移成功后设备才会绑定。迁移前先导出一份本机 JSON 备份。

## 7. 备份与更新

日常备份数据库：

```bash
mkdir -p backups
chmod 700 backups
umask 077
sudo docker compose exec -T db pg_dump -U member -d member -Fc \
  > "backups/member-$(date +%Y%m%d-%H%M%S).dump"
```

将数据库备份、`.env` 和长期使用的 APK 签名密钥另外保存。只把备份留在同一台服务器上不能防止服务器损坏。

更新代码前先备份，再在项目目录执行 `sudo docker compose up -d --build`。Docker 命名卷保留数据库；不要使用 `docker compose down -v` 删除数据卷。旧版首次升级需按部署维护说明重建私有网络。

APK 更新发布和更多故障核对方法见 [云端部署说明](README.md)。
