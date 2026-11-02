# Docker Hub 拉取超时：华为云部署

Docker 安装成功后，拉取 postgres:17-alpine 等镜像仍可能因公网网络或 DNS 失败而超时。这与 Certbot 是否安装无关。反复执行 Compose 不会解决同一网络故障。

华为云控制台的镜像加速器说明限定个人开发场景，不允许再次封装或商业用途。因此，下面的加速器配置用于符合该限制的个人开发测试；正式店铺部署本会员系统时，应按控制台建议将所需镜像同步到自己的 SWR 私有仓库，或在能访问 Docker Hub 的机器拉取后使用 docker save / docker load 离线导入。不要把个人开发加速器作为正式生产的下载依赖。

## 1. 个人开发测试：获取自己账户的官方加速地址

登录华为云控制台，进入容器镜像服务 SWR，查找“镜像加速器”（通常位于“镜像资源”下），复制页面提供的 HTTPS 地址。地址可能是自己的专属子域名，以控制台实际显示为准，不要照抄示例占位符。

如果当前账户/区域没有入口，或加速器不支持本项目的镜像，需使用能够访问 Docker Hub 的构建机器，将镜像同步到自己的 SWR 仓库或导出后上传服务器。不要随意加入未知公共镜像站，也不要设置 insecure-registries 或关闭 TLS 校验。

## 2. 保留原配置并添加加速地址

先检查服务器上的现有容器；更新配置需要重启 Docker，其他业务容器可能受影响：

```bash
docker ps
```

在最新代码的项目目录执行配置助手，按提示粘贴控制台的 HTTPS 地址：

```bash
cd ~/member
sudo python3 deploy/configure-docker-mirror.py
```

助手只更新 registry-mirrors，保留 daemon.json 的其他配置；先调用 dockerd --validate 校验，再备份原文件并原子替换。不会自动重启 Docker。配置是符号链接、格式错误或校验失败时会停止，原配置不覆盖。

没有其他运行中的业务容器，或已安排维护时，再执行：

```bash
sudo systemctl restart docker
sudo docker info --format '{{json .RegistryConfig.Mirrors}}'
sudo docker pull postgres:17-alpine
sudo docker pull node:22-alpine
sudo docker pull caddy:2-alpine
```

本项目数据库和构建需要这三个基础镜像，均拉取成功后再继续 Compose。不要只检查 postgres。

## 3. 继续 IP HTTPS 初始化

```bash
cd ~/member
sudo docker compose -f compose.yaml -f deploy/compose.ip.yaml \
  -f deploy/compose.ip-bootstrap.yaml up -d --build
```

构建还会访问 npm registry；若之后报错发生在 npm ci，应单独核对 npm 网络，Docker 镜像加速不会改变 npm 的下载地址。后续证书申请与续期继续按 [IP HTTPS 部署](ip-https.md)执行。

如果仍显示访问 registry-1.docker.io 超时，可能是加速器失败后 Docker 回退到 Docker Hub。核对实际加速地址、加速器的网络访问条件及镜像支持范围，再看 Docker 日志。不要直接在 hosts 中写死 Docker Hub IP，也不要为此盲目修改整个服务器/VPC 的 DNS。
