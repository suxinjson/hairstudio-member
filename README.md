# ✂️ 梦飞空间会员管家（独立安卓原生 App）

专为**家庭理发店 / 个人发型工作室**量身定制的会员储值与剪发记账独立安卓 App。

现已加入可自部署的私有云：安全登录、店主/店员/只读权限、离线待办与联网同步、服务端原子记账和去重校验、使用记录、检查更新及校验后下载/安装 APK。原有单机模式和 JSON 备份继续可用。部署步骤、权限范围和断网冲突处理见 [云端部署说明](deploy/README.md)。

接口权限、并发登录限流、输入容量和数据库最小权限的修复与验证见 [安全审查记录](deploy/security-review.md)。已有服务器升级需新增独立应用数据库密码并迁移私有网络，步骤见 [升级说明](deploy/README.md#已有部署升级)；只有 IP 时使用 [IP HTTPS 部署](deploy/ip-https.md)。

> 💡 **解决的核心痛点**：
> 1. **彻底摆脱老旧电脑**：独立安卓原生软件，装进手机后电脑彻底拔电源关机，每天开店直接手机秒开秒记。
> 2. **免除应用商城高昂门槛**：免软著、免营业执照、免上架各大应用市场，生成的 `.apk` 安装包微信发到手机 10 秒直接安装。
> 3. **本地账本与外部备份**：账本保存在应用沙盒中；内置文件导出与系统分享，可发送到微信或文件管理器，并在换手机时导入恢复。

---

## 🌟 理发店专属功能

1. **秒级剪发扣款**：
   - 预设理发店高频品项：**精致洗剪吹 ¥38、寸头快剪 ¥25、单人洗吹 ¥20、儿童理发 ¥25、时尚冷烫 ¥128、植物染发 ¥158、深层护理 ¥88**，一键带入。
   - 内置大按键数字软键盘，单手盲操顺畅，余额不足时红字醒目阻断，防手滑误扣与超额扣款。
2. **充值赠送与微信通知**：
   - 快捷充值档位（充200送20、充300送40、充500送80、充1000送200等）。
   - 充值成功自动生成专业致谢通知文案（*“尊敬的顾客，本次充值已入账...当前卡内余额...”*），一键复制微信发给顾客。
3. **熟客发型偏好档案**：
   - 记录熟客发型喜好（如：*“短发寸头、染发偏好板栗色、不喜欢推子太贴皮”*），到店洗剪吹一目了然。
4. **双保险对账与微信备份**：
   - **一键备份发到微信**：打烊后点一下，备份文件直接发到微信“文件传输助手”长期留底。
   - **换新手机一键还原**：新手机安装 App 后，导入备份文件，1 秒全量恢复所有会员、余额和流水。
   - **导出 Excel 表格**：自动生成 `.csv` 对账明细，手机 WPS 随时打开核算。

### 账本恢复与导出规则

- 增量合并优先按固定会员 ID 匹配，修改手机号后仍识别为同一会员。只有一份流水完整延续另一份时才同步余额、累计金额与撤销状态；两边都有独立交易或余额不一致时停止自动合并，需核对后选用完整账本恢复。
- 固定 ID 会为整份备份预留，不会因旧手机号被新会员复用而误认档案。较新流水会同步会员资料和注销状态；相同流水按档案更新时间同步资料，时间相同通常保留当前资料，改号并复用旧号时按固定 ID 对应的号码归属处理。相同流水中的注销状态会保留，较旧备份不能重新启用已注销会员。
- 已撤销标记必须存在对应冲正流水，否则备份预览和恢复都会拒绝。旧版备注中的原单号仍可用于还原撤销关联。
- CSV 对账明细会将可能被 Excel/WPS 解释为公式的姓名、电话、备注和流水单号加上文本前缀，原始账本及 JSON 备份保持原文；金额列仍以数值导出。
- 注销零余额会员会保留历史档案与流水，导出的备份仍可恢复。今日充值和消费统计排除已撤销原单。
- 旧备份恢复的注销档案如果缺少手机号，撤销消费会在写入前拒绝重新启用；需先核对并恢复完整会员档案，避免产生无法读取的账本。
- 本地数据损坏时，应用仍提供备份恢复入口。全量恢复前保存当前原始文本，保存失败则不覆盖账本。
- 云端绑定设备损坏后，店主可离线全量恢复备份，原待办与原始文本仍会保留。恢复后先在云端设置中导出核对，再联网选择采用云端账本或确认上传恢复结果。账号降权和初始迁移冲突也提供同一核对入口。
- 安卓导出先通过 Filesystem 写入应用缓存，再通过 Share 调用系统分享面板，供微信或文件管理器接收。缓存不等于长期外部备份；请确认接收端文件可打开并另存。浏览器版通过下载记录核对保存结果。
- 手动快照写入失败会显示失败；外部导出不依赖快照成功。恢复已完成但后续快照失败时，会提示立即导出备份。

---

## 📱 工程结构说明

```text
member/
├── android/                   # 标准原生 Android Gradle 源码工程 (Capacitor 原生包装)
│   ├── app/
│   │   ├── build.gradle       # 安卓构建配置 (包名: com.hairstudio.memberapp)
│   │   └── src/main/assets/   # 100% 离线自包含的前端与样式资产
│   └── gradlew / gradlew.bat
├── src/
│   ├── components/            # 大按键数字键盘 (Keypad.vue)
│   ├── storage.js             # 纯本地不可变流水与财务级双向记账引擎
│   ├── App.vue                # 理发店专属收银台、会员卡片、微信通知、备份中心
│   └── style.css              # 100% 纯本地离线样式规范
├── .github/workflows/         # 自动云打包工作流 (免费生成 .apk 安装包)
│   └── build-apk.yml
├── capacitor.config.json      # 原生 App 属性配置
├── package.json
└── README.md
```

---

## 🚀 如何获取并安装 `.apk` 安装包？

### 方式 A：云端自动打包（最省电脑、推荐 ⭐⭐⭐⭐⭐）
首次发布前需要创建一份长期使用的 Android release keystore，并将其配置为 GitHub 仓库 Actions secrets。此后 GitHub Actions 使用同一密钥构建 release APK：

遇到 `Missing SIGNING_KEYSTORE_BASE64` 时，按 [GitHub APK 签名配置指南](deploy/github-apk.md)完成配置。工作流固定使用 Ubuntu 24.04、Node.js 22 和 Java 21，Actions 自身使用 Node.js 24，避免旧 Actions 的运行时弃用提示及 ubuntu-latest 迁移影响。

1. 将当前项目推送至您自己的 GitHub 仓库；
2. 在安全设备上只创建一次签名密钥，并至少离线保存两份 keystore 备份。密钥一旦丢失，后续 APK 将无法覆盖安装到当前版本；不要把 keystore 或密码提交到 Git；
3. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 设置 secrets：`SIGNING_KEYSTORE_BASE64`、`RELEASE_STORE_PASSWORD`、`RELEASE_KEY_ALIAS`、`RELEASE_KEY_PASSWORD`；再设置变量 `RELEASE_CERT_SHA256` 为该别名证书的 SHA-256 指纹；`SIGNING_KEYSTORE_BASE64` 是 keystore 文件的 Base64 内容；
4. 推送至 `main`/`master` 或手动运行 Actions。工作流会运行测试、使用同一签名构建 release APK，并验证签名；缺少密钥时会失败，不会提供 debug APK；
5. 下载 Actions 产物 `hairstudio-member-v*.apk` 安装。以后不要更换 keystore、别名或密码，也不要重命名 `.github/workflows/build-apk.yml`（版本序号按该工作流递增）。

生成 keystore 的示例命令（请替换别名，并自行安全保管输入的密码）：

```sh
keytool -genkeypair -v -keystore hairstudio-release.jks -alias hairstudio-release -keyalg RSA -keysize 4096 -validity 10000
```

PowerShell 可用以下命令生成要填入 `SIGNING_KEYSTORE_BASE64` 的单行值：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\hairstudio-release.jks"))
```

查看并记录证书指纹（不要在后续版本更换）：

```sh
keytool -list -v -keystore hairstudio-release.jks -alias hairstudio-release
```

将输出中的 `SHA256` 指纹填入 `RELEASE_CERT_SHA256`。CI 会逐次比对 APK 的实际签名证书与该指纹；密钥被误换时构建会失败。

### 持续升级与账本保护

- `capacitor.config.json` 的 `appId` 是 Android 包名的唯一来源。保持它不变、保持同一 release keystore，并安装更高 `versionCode` 的 APK，Android 才会按应用内升级处理并保留沙盒数据。
- 多键账本写入先落恢复日志；应用若在写入过程中被系统终止，下次启动会先恢复旧数据。若设备空间不足以保存恢复点，操作会在修改账本前失败。
- 更新前仍应通过应用内“备份全部账本”导出 JSON，尤其是跨手机迁移、卸载重装或切换首次固定签名版本时。卸载/清除应用数据不属于原位升级，应用无法保证本地账本仍存在。
- 旧版 Actions 产物是 runner 临时签名的 debug APK，无法与新固定签名版本直接覆盖安装。切换时先在旧版导出 JSON，再安装首次固定签名版本并导入备份；之后的版本才可直接升级。

### 方式 B：本地 Android Studio 导出（如有开发机）
1. 在电脑上运行 `npm run build`；
2. 使用 Android Studio 打开项目中的 `android` 目录；
3. 配置 `RELEASE_STORE_FILE`、`RELEASE_STORE_PASSWORD`、`RELEASE_KEY_ALIAS`、`RELEASE_KEY_PASSWORD` 和递增的 `VERSION_CODE` 环境变量；
4. 运行 `gradlew assembleRelease`。没有有效签名配置时，release 构建会失败。

### 依赖维护

`package.json` 仅对 Capacitor CLI → rimraf → glob 设置 `^14.0.3` 覆盖，修复 glob/minimatch 的已知资源耗尽漏洞，保持 Capacitor 7 和 Node.js 22 构建兼容。测试用 `csv-parse` 已升级到修复原型替换漏洞的 7.0.3。更新依赖时运行 `npm ci`、`npm test`、`npm run build` 和 `npm audit --registry=https://registry.npmjs.org`；上游采用安全版本后可以移除此覆盖。
