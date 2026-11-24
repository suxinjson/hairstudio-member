# 在 124.70.184.136 上部署会员云服务

以下按 Ubuntu 服务器首次部署编写。项目会运行 PostgreSQL、会员 API 和 Caddy 三个容器，Caddy 提供网页和 HTTPS API；服务器不需要安装 Node.js、Java 或 Android SDK。

只有公网 IP、没有域名时，上传和 Docker 安装步骤仍可使用；HTTPS 的配置、启动和续期请使用 [IP HTTPS 部署方案](ip-https.md)，不要按下面的域名证书流程直接启动。

## 1. 准备域名与端口

将自己的域名（例如 `member.your-domain.com`）的 A 记录指向 `124.70.184.136`。示例域名须换成自己的实际域名。如果设置了 AAAA 记录，也必须指向该服务器的有效 IPv6 地址。

在云服务器安全组和系统防火墙中允许 TCP 80、443；SSH 使用服务器实际配置的端口。此部署不需要公网开放后端高位端口 48927、数据库 5432。

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

使用权限为 600 的 `.env`，按 [首次启动](README.md#首次启动) 填写域名、`MIGRATION_DATABASE_URL`、`DATABASE_URL` 和 `APP_DATABASE_PASSWORD`。两条连接指向同一外部新库，旧库留作核验。只有 IP 时使用对应证书与 Compose 覆盖。当前候选用于隔离验证；正式切换按 [停写与开账](../docs/relational-refactor-assessment.md#8-一次性切换流程)。

~~~sh
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail=100 migrate api web
~~~

只有一次性迁移任务验证成功才启动 API；角色或权限失败时修正配置，避免对原旧业务库操作。80/443 被占用时先确认现有反向代理归属。

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

先配置 [在线商业授权](../docs/platform-operations.md#在线商业授权)，然后在 App 登录页输入正确 HTTPS 地址及门店账号；首次完整同步后核对人数、余额、水位及离线权限。云端为空时由店主在管理后台开期初，不从手机整店覆盖。

## 7. 备份与更新

请按 [备份与恢复](README.md#备份与恢复) 使用外部 PostgreSQL 自身的备份和商家后台业务归档；App 服务器没有数据库卷。升级前做一次与候选对应的隔离恢复验证，发布后核对新交易和原回执。保留旧环境与备份，发生问题停止对应写入后处置。

APK 更新发布和更多故障核对方法见 [云端部署说明](README.md)。
