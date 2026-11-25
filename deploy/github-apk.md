# GitHub Actions 编译 APK：固定签名配置

固定发布签名用于 APK 完整性和覆盖升级校验，不代表手机厂商已验证开发者身份。安装时出现“开发者身份未验证”“签名来源不明”等提示，请按[安装身份认证说明](android-install-verification.md)核验实际 APK，并在对应平台完成身份与应用来源认证；重新生成密钥不能消除这些提示。

`Missing SIGNING_KEYSTORE_BASE64` 表示仓库未向构建任务提供 Android 发布签名文件。这会使 release 构建停止；更新 Actions 版本不能补上密钥。首次正式发布时配置一次，后续构建继续使用同一份签名。

当前工作流固定使用 Ubuntu 24.04、Node.js 22 和 Java 21，采用运行在 Node.js 24 上的 checkout v5、setup-node v5、setup-java v5、upload-artifact v6。Actions 自身的 Node.js 版本与用于编译项目的 Node.js 版本分别配置。

这些 Actions 固定到完整提交 SHA，Dependabot 每周检查更新。工作流令牌仅授予 `contents: read`，checkout 不保留 Git 访问凭据。SSH 私钥只注入部署步骤，签名密码只注入签名配置和 Gradle 编译步骤；临时签名文件和 SSH 凭据在对应步骤结束后清理，失败时也执行清理。

## 1. 确认是否已有签名文件

如果以前使用固定发布签名生成过此应用的 APK，请找到原来的 `.jks` 或 `.keystore`、别名和密码，直接从第 3 步继续。覆盖升级必须使用同一签名；生成新密钥不能恢复原签名。

仅在首次发布、没有固定发布签名时执行第 2 步。项目早期 CI 生成的是临时签名 debug APK；切换到固定 release 签名前，应在旧版导出 JSON 账本备份。

## 2. 首次创建签名文件

建议在可信电脑上生成并离线备份。需要 Java JDK 的 `keytool`；如果电脑没有 JDK，也可在当前 Ubuntu 24.04 服务器终端执行以下命令。密钥放在 `~/member-signing`，与项目目录分开：

```bash
sudo apt-get update
sudo apt-get install -y openjdk-21-jdk-headless
mkdir -p ~/member-signing
chmod 700 ~/member-signing
cd ~/member-signing
umask 077

if [ -e hairstudio-release.jks ]; then
  printf '签名文件已存在，请使用原文件，不要覆盖。\n'
else
  keytool -genkeypair -v -storetype PKCS12 \
    -keystore hairstudio-release.jks -alias hairstudio-release \
    -keyalg RSA -keysize 4096 -validity 10000
fi
```

交互输入并记住至少 12 位的强密码，按提示填写证书资料并确认。这里的 `.jks` 文件采用 PKCS12 格式，密钥密码和文件密码相同；下面两个密码 Secret 填同一份密码。生成成功后，将文件和密码分别安全保存，至少保留两份独立备份。

## 3. 获取 Base64 和证书指纹

在 Ubuntu 中，进入原签名文件所在目录后执行：

```bash
base64 -w 0 hairstudio-release.jks
printf '\n'
keytool -list -v -keystore hairstudio-release.jks -alias hairstudio-release
```

第一条命令输出完整的一行 Base64，复制到 `SIGNING_KEYSTORE_BASE64`。它仍包含签名私钥，不要发到聊天、日志或提交 Git。第二条命令要求输入文件密码；找到 `SHA256:` 后的指纹，复制到 `RELEASE_CERT_SHA256`。已有文件的路径和别名按实际值替换。

Windows PowerShell 可用以下命令把 Base64 复制到剪贴板，文件路径按实际值填写：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\你的密钥目录\hairstudio-release.jks")) | Set-Clipboard
```

## 4. 在 GitHub 仓库配置

打开仓库 **Settings → Secrets and variables → Actions**。先在 **Secrets** 页签中点击 **New repository secret**，逐项创建：

| Secret 名称 | 填入的内容 |
| --- | --- |
| `SIGNING_KEYSTORE_BASE64` | 完整的单行 keystore Base64 |
| `RELEASE_STORE_PASSWORD` | 创建 keystore 时输入的文件密码 |
| `RELEASE_KEY_ALIAS` | 新建示例使用 `hairstudio-release`；已有签名填原别名 |
| `RELEASE_KEY_PASSWORD` | 对应别名的密钥密码；本指南新建 PKCS12 时与文件密码相同 |

然后切换到 **Variables** 页签，点击 **New repository variable**：

| Variable 名称 | 填入的内容 |
| --- | --- |
| `RELEASE_CERT_SHA256` | `keytool` 输出的 `SHA256:` 指纹，只复制指纹值，允许带冒号 |
| `RELATIONAL_RELEASE_APPROVED` | 达到 [发布门槛](../docs/refactor-test-plan.md#10-发布清单与完成状态) 后由负责人设为 `true`；未签收时不设置或保持关闭 |

名称必须完全一致。当前工作流读取 repository Secrets 与 Variable；它没有配置 GitHub Environment，因此只放在某个 Environment 下的 Secrets 不会自动注入。`RELEASE_CERT_SHA256` 须设置在 Variables，其他四项须设置在 Secrets。

这里配置的是 APK 的 Android 发布签名，与 HTTPS 的 Let’s Encrypt IP 证书分别使用。不要将 `/etc/letsencrypt/live/member-ip/privkey.pem` 或 HTTPS 证书指纹用于 APK 签名。

## 5. 重新构建与下载

先提交并推送到 `main`，再在 Actions 选择“编译安装包与服务器部署”，点击新的 **Run workflow**。推送默认只运行测试、编译和上传 Debug 包，不会自动更新服务器，也不会向手机发布更新。

手动运行的 `operation` 默认 `build_apk`，安装包类型默认 `release`。按本次变更选择操作：

| operation | 操作与用户感知 |
| --- | --- |
| `build_apk`（默认） | 仅编译下载安装包。选 `release` 得到固定签名正式包，选 `debug` 得到测试包；不部署、不向手机发布更新。 |
| `deploy_server` | 仅部署服务器 Web、后台和 API。忽略安装包类型，不编译或发布 APK，保留手机更新清单与版本记录；无需用户安装新版 App。 |
| `deploy_server_and_app` | 部署服务器并发布手机新版，强制编译固定签名正式包。成功后手机可在“检查更新”下载并确认系统安装。 |

两种部署操作仅允许 `main/master`，需要现有 `SERVER_SSH_KEY`、`SERVER_KNOWN_HOSTS`，并由负责人核验后将仓库 Variable `RELATIONAL_RELEASE_APPROVED` 设为 `true`。未批准或缺少 SSH 配置会在准备步骤明确失败，避免误以为部署已完成。只编译下载不要求部署批准。

正式签名编译还需要前述四项签名 Secrets 和 `RELEASE_CERT_SHA256`，沿用原来的签名文件和指纹。正式产物名为 `member-manager-版本号`，包含 APK 和 `update-manifest.json`；Debug 产物名为 `member-manager-debug-版本号`，不能覆盖原正式签名 App。仅服务器产物名为 `member-server-版本号`，只有服务器更新包。

服务器/后台/在线网页的改动通常选择 `deploy_server`；只改测试、说明或 CI 流程提交推送即可。Android 使用 APK 内的 `dist` 资源，修改手机本地页面、共享组件、离线记账或原生桥后，要在已安装手机上生效必须发布并安装一次新 APK；服务器部署不能替换这些本地文件。普通 Android 安装更新需要用户确认，不支持本项目直接无感安装 APK。

“Re-run jobs” 保留原源码、触发方式和输入。切换操作或使用新工作流时，应提交推送后发起新的 **Run workflow**。正式包覆盖升级保持原包名、签名，并使用更高的 `versionCode`；正常更新无需卸载 App。

仅使用网页版不需要 APK 签名；配置缺失不会影响已部署网站的账号登录和记账。需要向云服务器发布 APK 更新时，再按 [部署维护说明](README.md#发布-apk-更新)填写服务器 `.env` 中同一个 Android 签名指纹并发布安装包。

## 6. 自动 SSH 部署的服务器主机密钥

启用自动部署需要两个 repository Secrets：`SERVER_SSH_KEY` 和 `SERVER_KNOWN_HOSTS`。两者均从 GitHub Actions 读取，服务器公钥不再从仓库文件加载。两个密钥都应由运维按目标主机核验；持有 SSH 机密本身不会触发部署，还必须满足正式发布闸门。已有签名与证书按原包维护。

在 [仓库 Actions Secrets 设置](https://github.com/suxinjson/hairstudio-member/settings/secrets/actions) 点击 **New repository secret**。自动构建并部署需保存以下六项 Secrets（已存在的保留原值）：

| Secret 名称 | 填入的值 |
| --- | --- |
| `SIGNING_KEYSTORE_BASE64` | 原 APK 发布 keystore 文件的单行 Base64，沿用现有值 |
| `RELEASE_STORE_PASSWORD` | 原 keystore 文件密码，沿用现有值 |
| `RELEASE_KEY_ALIAS` | 原发布密钥别名，沿用现有值；仅按本文示例创建的密钥使用 `hairstudio-release` |
| `RELEASE_KEY_PASSWORD` | 原发布密钥密码，沿用现有值 |
| `SERVER_SSH_KEY` | 服务器部署用户已授权的客户端私钥全文，包含首尾标记和换行；沿用现有可用值 |
| `SERVER_KNOWN_HOSTS` | 下方完整的一行服务器主机公钥 |

对于默认服务器 `124.70.184.136:22`，`SERVER_KNOWN_HOSTS` 的值是：

```text
124.70.184.136 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINOiEfqESq838P+gsV4bkFIdfXr/PjFV236dgVtdWI7X
```

这行是公钥，来源为本机已有 SSH 信任记录；主机公钥在本次 SSH 连接中匹配，但本机默认客户端私钥未获服务器登录授权，不应据此覆盖现有 `SERVER_SSH_KEY`。主机公钥指纹为 `SHA256:xYhtiUEX0Pa4qAt3qCBO7dJpGXXGrQf0gy4pMlG3UYg`；Secret 填完整公钥行，不能只填指纹。

以下四项也是 repository Secrets，但可不创建；未设置时使用表中默认值。已有覆盖配置按实际值保留，尤其是 SSH 用户名和项目路径：

| Secret 名称 | 当前默认值 |
| --- | --- |
| `SERVER_HOST` | `124.70.184.136` |
| `SERVER_USER` | `ubuntu` |
| `SERVER_PORT` | `22` |
| `SERVER_DEPLOY_PATH` | `~/member` |

在 [仓库 Actions Variables 设置](https://github.com/suxinjson/hairstudio-member/settings/variables/actions) 保留 `RELEASE_CERT_SHA256`。本机保存的 `1.0.27` 发布清单记录为 `da28115caa57eedb2e6adf802a8348209e5190d91b5b6767bb6a3119ad6a0041`；优先沿用当前已成功构建的 Variable 值。该值是 APK 签名证书指纹，与 SSH 主机指纹不同。

`GITHUB_TOKEN` 由 GitHub 自动生成，不用手动创建 Secret。数据库密码仍保存在服务器 `.env` 中，当前工作流不读取它们。配置保存后提交并推送本次代码，再发起新的工作流；Secrets 无法反向读取明文，未知私钥和密码应从原始安全备份取回，不能从名称推算。

主机没有对应的固定公钥或实际密钥不匹配时，工作流会停止部署。SSH/SCP 始终使用 `StrictHostKeyChecking=yes`。自定义服务器或端口时，按以下方式核对并设置公钥。

通过云服务商控制台终端或已核验身份的 SSH 连接，在服务器执行：

```bash
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

只复制公钥，按实际访问地址组成一行并填入 `SERVER_KNOWN_HOSTS`：

```text
124.70.184.136 ssh-ed25519 AAAA...服务器公钥的完整 Base64...
```

若 `SERVER_PORT` 为非默认端口，例如 2222，主机字段使用 `[124.70.184.136]:2222`；域名部署则使用实际 `SERVER_HOST`。可保存多行公钥。不要仅凭未经核验的 `ssh-keyscan` 结果建立信任，不要复制服务器私钥。更换服务器主机密钥后，需要核对新指纹并更新此 Secret。

工作流按仓库串行部署，每次运行和重试使用独立的远程临时文件。服务器的 `deploy/install-update.sh` 在同一把锁内检查版本、安装代码、更新容器并执行所选发布范围；旧版本任务会在覆盖代码前跳过。仅服务器包不能携带 `releases`，部署后不调用 APK 发布器。部署失败可重试相同版本，同版且同内容的 APK 发布也可重试。
