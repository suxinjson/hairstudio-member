# GitHub 与服务器安全配置

仓库已限制 Actions 令牌为只读、关闭 checkout 凭据保留、固定 Actions 提交 SHA，并缩小签名密码及 SSH 私钥的注入范围。SSH/SCP 始终核验由 `SERVER_KNOWN_HOSTS` Secret 提供的固定服务器公钥，不读取仓库中的主机公钥文件。这些设置提交并推送后才会用于新的工作流；线上服务器设置仍需登录后核实。

## GitHub 设置

在 GitHub 账号 **Settings → Password and authentication** 启用双因素认证，保管恢复码。

在仓库 **Settings → Actions → General → Workflow permissions** 选择只读权限，关闭允许 Actions 创建或批准 Pull Request。仓库工作流已明确使用 `contents: read`。

发布签名及 SSH 密钥配置见 [GitHub APK 与部署说明](github-apk.md)。保留现有 APK 签名身份；不要为安全配置重新生成发布签名。`SERVER_KNOWN_HOSTS` 存储服务器公钥，`SERVER_SSH_KEY` 存储用于登录的客户端私钥，两者用途不同。

默认 `124.70.184.136:22` 的公钥指纹是 `SHA256:xYhtiUEX0Pa4qAt3qCBO7dJpGXXGrQf0gy4pMlG3UYg`，来源为本机已有 SSH 信任记录。更换服务器或主机密钥时，通过云控制台核对新公钥后更新配置。

如需保护 `main` 分支，在 **Settings → Rules → Rulesets** 创建分支规则，禁止强制推送与删除分支。若还要求 PR 和审查，先安排独立 CI：当前工作流只处理 push 与手动触发，并会签名及部署，不适合直接作为 PR 合并前的必需检查。

## 服务器：先核对现状

通过已有 SSH 密钥或云控制台登录后执行下列只读检查。按实际安装路径调整项目目录。不要输出 `.env` 或私钥内容。

```bash
id
sudo ss -lntup
sudo sshd -T | grep -E '^(port|permitrootlogin|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication) '
sudo ufw status verbose
sudo systemctl is-active ssh docker
cd ~/member
stat -c '%a %U %n' .env
sudo docker compose ps
```

`ss` 用于确认 3000、5432 或其他公网监听属于哪个进程。不要停止尚未确认归属的服务。Compose 不发布本项目的 API 与数据库端口，但 Docker 发布端口可能绕过 UFW，应同时检查 Compose 和云安全组。

## SSH 与云安全组

先用授权公钥建立第二个 SSH 会话，再关闭密码登录和 root 直接登录。通过 `/etc/ssh/sshd_config.d/` 的配置文件设置如下目标值，用 `sudo sshd -t` 和 `sudo sshd -T` 验证实际生效结果后 reload SSH。保留原会话直到新会话成功；不要同时改变 SSH 端口。

```text
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
```

Ubuntu 的配置包含顺序可能使已有文件覆盖后加入的值，因此必须检查 `sshd -T`，不能只检查文件内容。以后使用 `Match` 规则时，还需通过 `sshd -T -C` 检查对应用户和来源。

云安全组及主机防火墙允许 TCP 80/443；若使用 HTTP/3，还允许 UDP 443。SSH 仅允许实际管理来源和部署来源，本项目无需公网开放后端高位端口 48927 或数据库 5432。

当前 GitHub 托管 runner 的出口地址不固定。将 SSH 限制到个人 IP 会使自动部署失败；需先提供具有固定出口的部署 runner、VPN 或跳板机，再收紧部署来源。安装在生产服务器上的自托管 runner 拥有较高权限，应使用独立的受控部署环境。

## 配置文件、数据库与维护

将 `.env` 设为 `600`，SSH 目录设为 `700`、私钥及 `authorized_keys` 设为 `600`。部署用户应拥有项目目录；Docker 管理权限相当于主机管理员权限，部署密钥应独立使用并限制转发和交互用途。

已有数据库保留 `POSTGRES_PASSWORD`。按 [已有部署升级](README.md#已有部署升级)增加独立随机 `APP_DATABASE_PASSWORD`，让 API 使用受限角色 `member_app`。不要删除数据库卷，先备份再升级。HTTPS IP 证书自动续期及演练使用 [IP HTTPS 说明](ip-https.md)。

配置系统安全更新和数据库定时备份；备份需加密并存放于另一台机器或受控对象存储，安排恢复演练。完成后验证新 SSH 会话、HTTPS 健康接口、App 登录与同步，以及一次自动部署。

## 接口与会话边界

角色及门店来自有效会话，写请求的账号和设备必须匹配会话。店员可建档、编辑会员、充值和消费；注销、撤销、恢复、定价、赠送规则及账号管理由店主执行，只读账号不能记账。停用或降权撤销旧会话，写事务重新核对权限，最后一位在用店主不能被停用或降权。

金额按整数分保存，服务端重新计算余额和流水。账本、版本、审计及不可变操作单号在同一事务提交；改变同一单号内容会被拒绝。审计和操作去重记录不能随意清理，否则会破坏追溯和离线重试保护。

API 使用受限 `member_app` 数据库角色和只读根文件系统，APK 卷只读；管理员密码仅用于一次性迁移、创建门店及发布容器。数据库无公网端口，语音合成通过独立出站网络；上游来源、DNS 地址、重定向、时限、返回容量和并行数均受检查。接口有请求大小、连接数及限流预算；多个 API 副本的普通请求预算独立，需要在统一入口另做容量控制。

收银网页和 PC 后台在 localStorage 保存会话并提供 15 分钟空闲锁屏，锁屏不会撤销服务端令牌。Android 会话长期保留，使用两份独立 Keystore AES-GCM 副本保存刷新凭据，并排除系统备份；刷新重试不再撤销会话。设备授权与登录分别管理，离线授权由本机加密保存并按截止时间检查，回拨手机时间要求联网核验。后台禁用或授权到期同时在鉴权和记账事务中检查；完全断网时以最后下发的离线期限为准。修改 PC 为 HttpOnly Cookie 需要同时设计 CSRF 和跨页面会话协调。

离线设备无法立即得知远端撤权，联网上传仍须按最新权限校验。SHA-256 用于检测数据损坏，不阻止数据库管理员改账；系统不核验现金或微信实际到账。语音供应商凭据撤销、数据库迁移及可信签名网关配置见 [语音接入说明](voice-integration.md)。
