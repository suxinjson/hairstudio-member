# 全量重构实施台账

2026-11-20。**v2 候选已接通，可交付隔离验收；正式发布和营业切换仍阻断。** 以下测试只用合成数据和专用库。生产、真实会员资料和营业手机均未操作。切换按 [停写与开账方案](relational-refactor-assessment.md#8-一次性切换流程) 单独执行。

## 候选版与范围

| 工作 | 现状与证据 |
| --- | --- |
| 资金与存储 | [领域计算](../src/ledger-domain.js)、[PG 资金事务](../server/relational-ledger.js)、[SQLite 事务](../src/relational-sqlite.js)。期初、账户、流水、成交/付款、冲正、审计和待办分表；确切整数分传输。普通 API 账号不具备更改代际、删除账或变更 schema 的权限。 |
| 应用接入 | [网页收银](../src/OnlineCashier.vue)、[商家后台](../admin/src/App.vue)、[Android](../src/NativeCashier.vue)、[天猫精灵](../server/aligenie.js) 均走 v2 账本。平台与商家、在线与独立离线的身份仍隔离。 |
| 批次、报表与导出 | [批次](../src/components/RelationalBatches.vue) 保留原号、版本与暂停/继续控制，[经营报表](../src/components/RelationalReports.vue) 分列毛额、冲正、净额和欠款。[商家后台](../admin/src/views/RelationalExportView.vue) 的在用会员表格仍限 5,000 行，并核对导出前后的水位。财务流水交由 [异步任务](../server/relational-export-worker.js) 在一致快照中读取、独立线程编码；离开页面后可回来下载。单任务最多 366 天、25,000 行、8 MiB、生成 90 秒；每店一个槽、全库八个槽，自提交起保留 15 分钟。表格不落 API 本地文件，不进业务归档。 |
| 期初 | [店主期初界面](../src/components/RelationalOpenings.vue) 要求 91 人、来源与内容两份摘要以及逐人确认。后台和独立离线 Android 均已接入；未知时按原批次恢复。期初不计作营业收入、赠送、消费或新客。 |
| 备份与恢复 | [外部文件选择器](../android/app/src/main/java/com/hairstudio/memberapp/ArchiveDocumentsPlugin.java) 和 [PG 流式接口](../server/relational-archive-http.js) 已接入现有页面。两端读回字节/摘要；恢复须同店空目标、预览后确认、原任务号；正式提交建立新代际。PG 使用独立恢复角色，不恢复凭据/商业许可。 |
| 重建手机副本 | [同步界面](../src/components/RelationalNativeSync.vue) 与 [客户端控制](../src/relational-native-workspace.js) 支持安全重建；同一 PG 快照中按页返回配置、档案和确认流水。SQLite 单事务接收，复查余额、冲正及目标代际水位后才提交。覆盖截断、取消、提交失败、下载后再次换代和旧待办保留。 |
| 退役与部署 | [默认 Compose](../compose.yaml) 仅迁移任务、API 与代理，连接外部 PostgreSQL。迁移遇旧账表直接停止。v1 只保留非账本接口；旧快照/回放、旧 JSON 账本和兼容写路径已移除。 |

## 原单与恢复处置

1. **同代际冲突：** 停止在受影响设备上继续收银，记录原账号/设备、原号、会员版本、余额和最后确认水位。先用原账号在“本机同步”查询原号；服务器原回执字段完全匹配才确认。找不到回执或回执矛盾时，保存并从应用外读回原单；通知店主/运维和服务器流水对账，核对是否仍有请求在途。不要删除 outbox、换号重发、改版本重放或清除手机数据。当前无凭 404 直接解锁的路径；无法核清则保留原机停写，待权威一致后制定人工处理。需要新的资金操作时由店主审批，在权威账本按实况独立记账并记录与原单的关联；不把它视为重试。
2. **同代际水位异常：** `CURSOR_HISTORY_INCOMPLETE` 表示历史有缺口；原待办全部确认后，店主可通过完整云端快照重建。`CURSOR_AHEAD` 表示同代际本机水位更高；禁止直接重建。运维先查数据库目标、备份/故障转移记录及缺失交易。若确需恢复，请按已验收的空目标恢复流程创建新代际；不可手工改水位/代际解锁。
3. **确认换代：** 原账号在原设备逐笔对照云端/备份，选“金额已核对”或“已登记由店主人工作后续处理”，在应用外写出并读回包含原命令、原回执、原/目标代际和结论的原单。网页、手机在线未明命令/任务也须以原号保存原请求并读回后结束待办。重建前待办仍在 SQLite；换成目标代际时才原子替换，保留核对元数据。目标又换代需重新核对；取消、文件失败、身份变化或提交失败保留原副本。只有店主能重建，绝不把旧单发送到新代际。
4. **连接故障与真实恢复：** 保留原库和新库首次营业后的所有交易、收据及设备待办。独立 PG 恢复只收同一门店 ID、空业务目标；需运维预先验证同店 ID、登录/授权及历史操作人的处置，普通新建门店会生成新 ID，不能替代。不要直接把旧物理快照挂回在线入口，也不能把业务归档当成凭据/许可备份。按 [部署恢复](../deploy/README.md#备份与恢复) 验收外部库、账号重建和手机换代结果。

## 验证命令与当前证据

当前候选源码 SHA-256 为 `648f6c579c2a02ffb39bdbd03b3bb5598217d30793c4c893ac2ec610f81e449e`，涵盖 329 个文件。[逐文件清单](../output/refactor-v2/20261120T053958603Z-local/source-manifest.json) 含源码、测试工具和运行配置；工作区有未提交改动，Git HEAD 只作基准。文档、独立验收驱动和构建产物不计入源码摘要。相对前一候选仅变更平台架构说明、归档 HTTP 上传收尾及其回归测试。[当前候选证据清单](../output/refactor-v2/validation-20261120/candidate-evidence.json) 按每份报告的真实源码摘要区分当前实测、未变代码范围证据和历史结果；[前一候选证据](../output/refactor-v2/validation-20261120/candidate-evidence-f74a8f2.json) 保留为历史记录。

[候选源码包](../output/refactor-v2/validation-20261120/handoff/member-v2-648f6c5-reviewed-final-acceptance-source-20261120-r2.zip)包含工作区源码、验收工具和记录模板。隔离构建方应按[包摘要与清单](../output/refactor-v2/validation-20261120/handoff/member-v2-648f6c5-reviewed-final-acceptance-source-20261120-r2.json)校验，解压后再复算源码摘要。包内文档为打包时快照；同摘要的后续补充验证以本节报告及当前证据清单为准，无需为新增报告重新构建代码候选。

| 检查 | 结果 |
| --- | --- |
| 全量回归与覆盖 | [Temurin JDK 21 下 Windows 466 项复跑](../output/refactor-v2/validation-20261120/regression-jdk21-resume-20261120.json)：465 通过、0 失败、1 项平台不支持的 `flock` 跳过；对应 [WSL 锁并发单项](../output/refactor-v2/validation-20261120/flock-resume-20261120.tap)为 1/1。此前共享 Windows `node_modules` 下的 Linux Rollup 缺包问题，已在锁定交付包的干净 Ubuntu 24.04/WSL2 环境安装 Linux 依赖后复跑 deployment 套件 17/17、零失败和跳过；[报告](../output/refactor-v2/validation-20261120/deployment-clean-wsl-648f6c5.json)与[原始日志](../output/refactor-v2/validation-20261120/deployment-clean-wsl-648f6c5.tap)保留源码摘要和日志哈希，旧失败记录仍作为环境问题历史留存。[领域覆盖](../output/refactor-v2/validation-20261120/domain-coverage-569c64c-linux.tap)行、分支均为 100%；领域源码未变，超过 95% 分支门槛。 |
| `npm run refactor:test` | [当前本地核心 198/198](../output/refactor-v2/20261120T091005356Z-local/summary.json)，零失败、取消或跳过；使用真实文件 SQLite。PGlite 仅用于串行逻辑验证。早期回归发现恢复上传已完成后 HTTP 连接可能先于重复请求体关闭；根因已修复，并新增延迟 chunk、超时、取消与 8 GiB 累计上限检查。[保留的失败记录](../output/refactor-v2/validation-20261120/npm-test-ui-copy-candidate.tap)不计为通过。 |
| 干净 Linux 全量回归 | 从锁定的 r2 交付包在 Ubuntu 24.04/WSL2 独立目录安装完整 npm workspace 依赖，执行真实测试入口后为 466 项、465 通过、0 失败/取消、1 项因缺 JDK 跳过的原生保险库测试；复算源码摘要仍为同一 329 文件候选。[报告](../output/refactor-v2/validation-20261120/full-clean-linux-648f6c5.json)及[完整 TAP](../output/refactor-v2/validation-20261120/full-clean-linux-648f6c5.tap)保留日志哈希。逐项比对 Windows 与 Linux TAP，466 个名称和数量一致，每项至少在一端通过；两端各自的跳过仍保留，不宣称单次零跳过或目标环境签收。 |
| `npm run refactor:test:postgres` | [当前真实 PostgreSQL 120/120](../output/refactor-v2/20261120T091153082Z-postgres/summary.json)，零失败、取消或跳过。覆盖受限应用/恢复账号、固定统计函数权限、真实多连接、在途资金、恢复锁、跨页余额链、200 行帧写入、同数审计错误、原号重试，以及导出取消、隔离、换代、会话撤销和连接断开后接手。 |
| 进程与资源故障 | [PostgreSQL 进程故障](../output/refactor-v2/validation-20261120/process-faults-final/summary.json)与 [SQLite 进程/资源故障](../output/refactor-v2/validation-20261120/sqlite-process-faults/summary.json)均记录 `f74a8f2` 源码摘要，验证 API/数据库进程中断、WAL、`SQLITE_BUSY`、真实 `SQLITE_FULL` 和 XLSX worker 接续。对应数据库、归档服务及 SQLite 实现相对当前候选未变；HTTP 上传读取另由当前回归、HTTPS 冒烟及只读演练验证。均为工作站证据，不替代目标资源和 Android 真机验收。 |
| 扩展随机事务 | [文件 SQLite](../output/refactor-v2/20261119T233125718Z-random-sqlite/summary.json) 和 [真实 PostgreSQL](../output/refactor-v2/20261119T233647495Z-random-postgres/summary.json) 各通过 1,000 种子 × 200 步，运行期间各自源码未变。它们是较早候选的范围证据；SQLite 和领域路径未变，PG 后续归档/恢复及数据库权限变化由较新的真实 PG 核心、全量回归与增长报告覆盖，不把旧摘要计作当前随机测试。另有 100 种子 × 100 步的独立领域参考模型。 |
| 架构、构建及凭据检查 | [当前候选架构审计](../output/refactor-v2/validation-20261120/architecture-audit-closure-reviewed.json)：151 个可达模块，0 项发现；[网页生产构建](../output/refactor-v2/validation-20261120/web-build-closure-reviewed.log)和[后台生产构建](../output/refactor-v2/validation-20261120/admin-build-closure-reviewed.log)均成功，仍有大 chunk 提示。综合证据见[构建和架构报告](../output/refactor-v2/validation-20261120/build-audit-closure-reviewed.json)。Android 当前仿真器构建另见下行。 |
| Android | 当前摘要下 [API 24 Android 7.0 x86_64 仿真器复跑](../output/refactor-v2/validation-20261120/android-api24/connected-android-test-summary-resume.json) 11/11 通过、0 失败/跳过，其中关系数据库仪表用例 2 项；使用 Debug APK，报告附 APK 哈希与 JUnit XML。[Debug APK、6 项 JVM 单测及仪表源码编译](../output/refactor-v2/validation-20261120/android-export-candidate-verified.log)和[签名检查](../output/refactor-v2/validation-20261120/apk-export-candidate-signature.log)也已通过。仿真器仅验证系统 API 24 的可执行路径，不代表正式签名实体手机；尚未签收各营业机型、应用外读回、系统安装器或卸载重装。 |
| 合成开账与恢复 | [当前候选本机只读 HTTPS 演练](../output/refactor-v2/validation-20261120/upload-drain-readonly/readonly-rehearsal-summary.json)：Caddy、只读 chroot（写探针 `EROFS`）、两套隔离 PostgreSQL 和受限角色；开账 91 位合成会员，新记 3 笔，经外部文件读回归档、恢复并逐人对账；旧代际被拒绝，恢复后可记新账、下载 XLSX，恢复原号重试未覆盖新账。这是 WSL 演练，不是目标镜像签收。 |
| 当前候选 HTTPS 冒烟 | [Caddy 与真实 PostgreSQL](../output/refactor-v2/validation-20261120/reference-load-smoke-648f6c5.json)：30/30 请求通过，6 笔写入；错代际写入为 0；刻意丢失已提交响应后用原命令号找回 1 笔，未换号重发。单独施压工具 SHA-256 见报告。本项验证入口与恢复，不签收目标吞吐。 |
| 浏览器 UI/API 冒烟 | [Chrome 与工作站 loopback Vite/API、隔离 PostgreSQL schema](../output/refactor-v2/validation-20261120/browser-ui-smoke.json)：91 位合成会员；登录、搜索、打开档案，预览并确认充值 200 分；数据库复核余额 200 分、恰好 1 笔流水。对应[可复跑驱动](../output/refactor-v2/validation-20261120/workstation-browser-ui-smoke.mjs)和 Chrome/PG 版本记在报告。仅为工作站冒烟，目标 HTTPS/Compose 浏览器全流程仍待 REF-02 签收。 |

保留历史的 [Windows 回归失败](../output/refactor-v2/validation-20261120/regression-final.tap)、[PG 夹具竞争取消](../output/refactor-v2/20261119T232527363Z-postgres/summary.json)、[PG 随机运行中源码变化](../output/refactor-v2/20261119T230634938Z-random-postgres/summary.json)，以及 [f74a8f2 候选 PG 首次运行](../output/refactor-v2/20261120T013625527Z-postgres/summary.json)与只读演练的测试角色冲突。源码变化的随机运行即使走完步数也不计为通过。该角色冲突清理临时库后按顺序复验通过；当前 648f6c5 的真实 PostgreSQL 核心、全量回归和只读 HTTPS 报告分别记录在上表。

增长归档先发现两类实际问题：[账户版本顺序复现](../output/refactor-v2/validation-20261120/pg-archive-version-reproduced.tap)显示版本 10 排到 2 前，现已按 BIGINT 排序；[同一目标库的预览与正式恢复](../output/refactor-v2/validation-20261120/reference-fixtures-d1-candidate.json)曾因冷表统计反复扫全店。现按表使用游标、一次核对全部资金和会员审计、按交易验证原回执，回执关联的同步变更按复合主键查找。[两百万同步变更的实库计划](../output/refactor-v2/validation-20261120/pg-growth-changes-plan.json)复现同批查询约 171 毫秒，按主键变为约 0.18 毫秒。恢复每个不超过 200 行、512 KiB 的归档帧一次 INSERT；不再按 1,000 个参数重复拆分。保留[错误查询计划](../output/refactor-v2/validation-20261120/pg-growth-live-cold-plans.json)、[查询拆分后仍超时](../output/refactor-v2/validation-20261120/reference-fixtures-d2-reconcile.json)及[小批写入超时](../output/refactor-v2/validation-20261120/reference-fixtures-d2-cursor-lookup.json)的 D2 结果；最新验证器另录各阶段 SQL 耗时。

后续 [D2 百万笔复验](../output/refactor-v2/validation-20261120/reference-fixtures-d2-batch.json)又发现外键自身选错索引：预览回滚后，正式恢复的明细写入通过流水分页索引反复扫全店，仅 118 帧就耗时 437.59 秒，最终在原有 10 分钟时限回滚。最终在 f74a8f2 版本安装固定七张表的无参数统计函数，在流水导入后与最终校验前调用；SECURITY DEFINER 的 schema 在迁移时完整限定，search_path 固定 pg_catalog，从 PUBLIC 撤权。普通应用调用被拒绝，恢复身份只获函数执行权，不获 MAINTAIN、所有权或 DDL；缺少执行权时启动失败。[统计修复候选复验](../output/refactor-v2/validation-20261120/reference-fixtures-d2-statistics.json)通过，完整 2,500 帧消费明细 SQL 共 11.70 秒，两次统计刷新共 2.42 秒；[代表性外键查询计划](../output/refactor-v2/validation-20261120/pg-growth-fk-statistics-restore-after-plan.json)使用完整主键，此记录不是触发器内部缓存计划或 EXPLAIN ANALYZE。f74a8f2 随后通过 D1/D2/D3 增长归档和进程故障复验；本轮只读演练针对 648f6c5 HTTP 收尾路径。各报告保留原候选摘要和失败记录。

### 本机容量探索

- 按顺序独立运行 `npm run refactor:capacity:sqlite`，以及 `npm run refactor:capacity:postgres -- d1 probe`（再分别用 `d2 probe`、`d3 probe`、`d1 sample`）。PG 入口只接受本机可丢弃的测试库；真实 PG 测试另需同集群的管理员测试连接。注入 `MEMBER_RELATIONAL_TEST_DATABASE_URL`、`MEMBER_TEST_ADMIN_DATABASE_URL` 和 `MEMBER_TEST_DATABASE_DISPOSABLE=1`；连接串不得写入报告。
- 下列 PG 探针和长测启动于早期摘要，用于定位瓶颈；当前候选仍需在目标 API、代理、外部 PG 和独立施压端复验。现有 `refactor:capacity:postgres` 在施压进程内启动回环 API，不能用于目标验收。

| 本机容量档位 | 结果摘要 |
| --- | --- |
| [桌面 SQLite D1](../output/refactor-v2/20261119T234924160Z-sqlite-growth-d1/summary.json) | SQLite 实现未变，1,000 人、10 万流水；导出 34.49 秒、外部读回 0.17 秒、预览 37.53 秒、恢复 38.57 秒。逐人金额和版本、恢复后新交易、原号重试及每页查询上限均通过。设备性能另验。 |
| [f74a8f2 PG D1 完整归档](../output/refactor-v2/validation-20261120/reference-fixtures-d1-process-faults.json) | 1,000 人、10 万合成流水，归档另含 1 笔新单；导出 22.36 秒、外部读回 0.19 秒、预览 32.77 秒、恢复 28.68 秒。默认 SQL 超时 15 秒，1,000 户金额与版本一致；预览零写入，换代与恢复原号校验通过。 |
| [f74a8f2 PG D2 完整归档](../output/refactor-v2/validation-20261120/reference-fixtures-d2-process-faults.json) | 10,000 人、100 万合成流水，归档另含 1 笔新单、约 1.94 GB。导出 208.62 秒、外部读回 1.81 秒、同一空库预览 292.02 秒、正式恢复 316.53 秒；均保留 SQL 15 秒及归档 10 分钟时限。10,000 户金额与版本一致，预览零写入、新代际及恢复原号保留后续新交易通过。此项是上一候选的本机直调服务验证，目标 HTTPS、受限资源与并行营业另验；归档服务实现未在 648f6c5 修改。 |
| [f74a8f2 PG D3 完整样本](../output/refactor-v2/validation-20261120/reference-fixtures-d3-process-faults.json) | 20 店合计 10,000 人和 20 万流水；逐店核对原充值/消费回执、逐户金额和版本、报表及跨店拒绝。第一店 500 人、10,001 笔完成归档读回和恢复，预览 3.57 秒、恢复 4.24 秒；没有把单店恢复算作 20 店并行恢复。 |
| [PG D1 探针](../output/refactor-v2/20261119T220659542Z-pg-d1-probe/summary.json) | 写入 P95 41.4 ms，常用报表 43.4 ms，零资金不变量错误。 |
| [PG D2 探针](../output/refactor-v2/20261119T220711488Z-pg-d2-probe/summary.json) | 百万流水。会员/流水首屏 P95 43.1/29.7 ms，常用报表 204.1 ms；每类 12 次。 |
| [PG D3 探针](../output/refactor-v2/20261119T220817410Z-pg-d3-probe/summary.json) | 20 店各 500 人、各 1 万流水，同类操作并发；写入 P95 164.6 ms，池等待 P95 42.5 ms，零资金不变量错误。 |
| [PG D1 混合样本](../output/refactor-v2/20261119T220840465Z-pg-d1-sample/summary.json) | 90 秒完成 1,800/1,800 请求，写入 P95 30.4 ms，常用报表 P95 43.3 ms；零非预期结果。 |
| [D1 30 分钟稳态](../output/refactor-v2/20261119T221149727Z-pg-d1-steady/summary.json) | 20 RPS 完成 36,000/36,000，写入 P95 39.2 ms、常用报表 P95 62.8 ms，零资金不变量错误。 |
| D1 突发 | [40 RPS](../output/refactor-v2/20261119T224658385Z-pg-d1-burst2/summary.json)：完成 11,944/12,000，56 次限流；[100 RPS](../output/refactor-v2/20261119T225841325Z-pg-d1-burst5/summary.json)：完成 12,323/30,000，17,308 次限流、219 次忙拒绝、客户端漏发 150。各恢复阶段完成 600/600，零资金不变量错误。100 RPS 期间源码变更，标记为观察，不签收吞吐或恢复。 |
| [D1 4 小时长测](../output/refactor-v2/20261119T231021552Z-pg-d1-soak/timeline.ndjson) | 使用早期摘要、回环流量，且受到本机增长测试干扰。2026-11-20 03:08 UTC 的采样完成 279,132 请求，记录客户端漏发 156 次和繁忙拒绝 311 次；仍只作本机观察，不签收当前候选或目标长测。 |

依赖锁的 [生产审计](../output/refactor-v2/validation-20261120/npm-audit-export-runtime.json) 与 [含开发依赖审计](../output/refactor-v2/validation-20261120/npm-audit-export-full.json) 的 registry 回报均为 0；这些报告来自 package-lock 未变的前序候选。Gradle、镜像及目标链路安全，以及异步导出和增长归档与正常收银同时运行的资源影响，仍由目标验收覆盖。

## 剩余工作与放行顺序

按 [目标环境验收执行单](refactor-target-acceptance.md) 移交隔离服务、施压端、测试机和负责签收的人员。

| 阶段 | 负责人 | 退出条件 |
| --- | --- | --- |
| 目标服务与合成全流程 | 运维、测试、开发 | 在隔离环境固定源码和镜像；外部 PostgreSQL、实际反向代理及独立施压端就绪。签收只读容器、受限角色、安全和故障恢复；用独立施压端运行热点/并发阶梯、D1 稳态/突发/4 小时长测、D2/D3 与导出干扰。合成 91 人从新库开账，在第二个同店空库演练外部文件读回、带新交易恢复和旧待办处置。未签收。 |
| 目标 Android（与目标服务验收并行） | 店主、测试、签名负责人 | 受控构建机用原发布证书签同候选 APK；在 API 24 及实际营业机型的专用机上通过 [AND-01–07](../deploy/android-install-verification.md#按机型逐项记录)，包括 D1、杀进程、应用外读回、卸载重装和系统安装器。未执行。 |
| 真实开账与恢复营业 | 店主、运维 | 前两项签收后才约维护窗口。停旧写入口，核对最后一笔和原待办；独立读回两份旧备份，复核来源与期初内容摘要、真实 91 人逐笔资料和余额，并记录原批次回执、手机代际。店主确认后开放新版写入口。未开始。 |

期初转换只读运行：

~~~sh
npm run refactor:import -- --source /secure/final-legacy.json --format json-cents --expected-count 91
~~~

也支持 `csv-yuan`。工具默认只输出脱敏统计，不写数据库；生成候选文件时提供 `--out`、`--reviewed-source-digest` 和 `--reviewed-payload-digest`，输出须在仓库外；归档行另外提供 `--archived-review`，确认同一来源所有归档编号的重启用名单。可参考 [转换工具](../tools/relational-import.mjs) 的选项说明。候选与回执归于受控证据，不进 Git 或日志。
