# 关系化 v2 接口合同

更新：2026-11-20。网页收银、商家后台、Android 和天猫精灵的账本功能均已接入 v2；发布与切换状态见 [实施台账](refactor-implementation.md)。

## 身份、版本与金额

沿用商家 Bearer 身份、会话/设备和商业授权检查；平台令牌不能充当商家身份。现有 auth 接口不代表复用旧账务协议。读写在 SQL 事务内重新授权，资金成功前再次检查授权时间和设备；店主负责期初/冲正，员工可在授权范围内记账，只读账号不能写入。

v2 仅运行新账本。数据库迁移检测到旧账表会拒绝执行；须创建独立新库并导入期初。/api/v1 仅保留登录、设备、账号、门店资料、审计、语音及更新等非账本接口；旧快照、旧回放及 v1 资金入口已退役。

### 账本代际与恢复隔离

GET /api/v2/book 在当前授权下返回 storeId、ledgerEpoch。ledgerEpoch 为规范小写 UUID，独立于门店 ID、账户版本和同步水位。新库初始化产生代际；受控恢复必须在排他门店锁内为恢复后的账本创建新代际，不能沿用备份中的代际。PG 普通运行身份无修改 stores.ledger_epoch 的权限，正常事务持共享门店锁直至提交。standalone 与云端空库恢复核心均已实现原子换代；云端须独立恢复账号，不能把手工更新代际当作恢复工具。

资金命令、资料/配置任务和正式期初预览/导入必须显式携带捕获时的 ledgerEpoch；增量和命令/任务回执查询以查询参数传入。缺失或格式错误返回 LEDGER_EPOCH_REQUIRED（400），与当前账本不符返回 LEDGER_EPOCH_MISMATCH（409），在去重回执、账户版本和资金修改前拦截。会员、流水与报表明细游标也绑定代际。一次性来源转换工具仍只生成候选清单；在线应用核对目标账本后，在首次正式请求捕获时绑定代际，不能给已经发送或结果未知的旧请求补当前代际。

SQLite cloud 首次初始化须传入已查询的 ledgerEpoch，并保存初始/当前代际；店主重建后允许按原绑定重新打开当前副本，其他来源不能自动换绑。standalone 初次初始化产生本地代际。同步在发送首个待办前检查门店、代际和游标，写事务和每页增量再次核验。发现不符或水位异常返回 blocked，保留原单、余额和水位，禁止自动改号、换版本或重记。

恢复后保留历史回执的原代际；即使调用方手工将旧请求改为新代际，相同 ID 的原回执仍拒绝重放。历史交易与任务结果保留在关系表和新备份中；原号重试保证适用于同一账本代际。Android 与网页已提供原单核对和外部保存入口，操作约束见本页“手机云端副本重建”。旧开发态 PG 回执缺代际时保持 NULL，不从当前门店补造来源，不能用于正常重试或结果恢复。

数据库金额列使用 *_cents；JSON 使用同义 camelCase 的 *Cents，值一律为十进制整数字符串，例如 balanceCents="1010" 表示 10.10 元。禁止 JSON number、浮点、科学计数、空金额和静默舍入。资料版本、账户版本和游标也是非负 BIGINT 整数字符串。新建会员为零余额，其他来源走明确的期初或资金命令。

## 路由

| 方法与路径 | 核心合同 |
| --- | --- |
| GET /api/v2/book | 当前授权下的 storeId、ledgerEpoch；首次捕获请求前核对账本归属 |
| GET /api/v2/book/watermark | 店主、原 ledgerEpoch；返回 storeId、ledgerEpoch、cursor，用于会员表格一致性及副本提交前核对 |
| GET /api/v2/sync/snapshot | 店主、原 ledgerEpoch；一致确认快照，用于重建手机云端副本，不是业务备份 |
| GET /api/v2/backup | 店主及 backup 授权下导出有界的云端完整业务备份；不含账号凭据或许可 |
| POST /api/v2/backup/restore/preview | 同店空账本核对来源摘要、源/目标代际、数量及需新增的历史操作人数量 |
| POST /api/v2/backup/restore | 独立恢复账号、排他事务、明确已核对摘要；原任务号重试返回首次结果 |
| GET /api/v2/backup/restores/:id | 原目标 ledgerEpoch 查询参数；只读当前店主账号/设备的原恢复回执 |
| GET /api/v2/configuration | 配置版本、当前服务/套餐和赠送规则；仅读明确关系表 |
| POST /api/v2/tasks | 资料/配置任务；原任务号、门店、类型、目标和完整 data；同内容重试返回首次结果，见下文 |
| GET /api/v2/tasks/:id | ledgerEpoch 查询参数；当前账号及设备的已提交任务类型、原结果与 completedAt；不能据 404 改号重做 |
| POST /api/v2/batches | 完整资料批次及捕获身份，最多 500 行/512 KiB；原子保存明确关系行，初始 paused，不执行业务 |
| GET /api/v2/batches | ledgerEpoch、after、limit=1～100；按批次号查找当前账号/设备捕获的批次，便于重开后恢复 |
| GET /api/v2/batches/:id | 捕获门店/账号/设备/代际查询参数；原始行任务号、完成/待办/取消计数，after 为行位置 |
| GET /api/v2/batches/:id/items/:taskId | 同一捕获身份；读取经摘要核验的原始完整行请求，供重新核对 |
| POST /api/v2/batches/:id/control | 捕获身份、expectedVersion 和 state=active/paused/cancelled；取消为终态 |
| POST /api/v2/batches/:id/items/:taskId | 只传原批次捕获身份；从关系表读取原行，不接受重新绑定版本/内容 |
| POST /api/v2/batches/:id/steps | 同批次身份和有界的原行任务号，逐行提交，允许按回执恢复；不跨行回滚 |
| GET /api/v2/members | 搜索和筛选、opaque cursor、limit=1～100，仅在用资料；不同筛选绑定各自顺序和游标 |
| GET /api/v2/members/:id | 当前资料、标签、balanceCents、version、accountVersion、archivedAt |
| GET /api/v2/ledger | memberId、opaque cursor、limit=1～100，按 occurred_at,entry_id 倒序；含 accountVersion、冲正关系 |
| POST /api/v2/exports/ledger | 店主且有 `cashier` 权限，提交 `{id,ledgerEpoch,from,to}`，202 返回异步 XLSX 任务 |
| GET /api/v2/exports/ledger | 查询参数 `ledgerEpoch`；返回当前账号/设备的有效任务或 `null` |
| GET /api/v2/exports/ledger/:id/file | 查询参数 `ledgerEpoch`；下载当前账号/设备的 `ready` 文件 |
| POST /api/v2/exports/ledger/:id/discard | 请求体 `{ledgerEpoch}`；丢弃当前账号/设备的任务或文件，返回 `{discarded}` |
| POST /api/v2/commands | 捕获的完整资金命令，见下文 |
| GET /api/v2/commands/:id | ledgerEpoch 查询参数；同店、同账号、同设备的已提交结果；404 不能证明在途请求永远不会提交，仍须原号重试 |
| POST /api/v2/import/openings/preview | 完整期初批次，只校验和计算，不写资金 |
| POST /api/v2/import/openings | 店主、backup 授权、新空账本、全批一个事务 |
| GET /api/v2/sync/changes | ledgerEpoch 必传，after 默认 "0"，limit=1～100；返回 storeId,ledgerEpoch,head,cursor,hasMore,items |
| GET /api/v2/reports/summary | from/to 左闭右开，基础 SQL 汇总，不是完整经营报表替代品 |
| GET /api/v2/reports/breakdown | from/to、kind=payment 或 service、opaque cursor、limit=1～100；从历史成交/付款快照聚合，含期间冲正抵销 |
| GET /api/v2/reports/business | from/to、offsetMinutes；日/月趋势、笔数、新客、消费人数/均额、前十消费净额和当前在用会员余额分布 |
| POST /api/v1/voice/aligenie | 保留平台接入路径和语音签名合同；v2 门店在同一事务内调用 v2 资金服务，不访问旧业务账本 |

原来开发态的 POST/PATCH members、归档 POST 与 PUT configuration 写路由已移除。会员新增、编辑、归档及配置写入均走任务回执。

## 商家后台 XLSX 导出

在用会员表格按页读取，最多 5,000 行，生成文件前核对首尾水位与代际；任一不一致须重做。流水表格按 `occurred_at` 筛选，`from`、`to` 为带时区的 ISO 时间（至毫秒），范围左闭右开、最多 366 天。任务 `id` 为客户端生成的小写 UUID。提交后以原会话、任务号、日期区间和捕获的代际去重；不能用同一号换区间。每店一个有效任务、全库八个槽；槽满或超范围有明确错误。

当前任务返回 `{id,ledgerEpoch,from,to,expiresAt,state,snapshotAt,rows,failure}`，状态为 `queued`、`running`、`ready` 或 `failed`。查询、下载与丢弃均重新核对店主、门店、当前会话、设备、`cashier` 权限和代际；离开页面后可用同一账号和设备返回查询。生成前及发布文件前还会校验任务捕获的会话。原会话撤销、设备变化或换代会阻止旧任务发布，已过期任务不可查询或下载。

后台采用 PostgreSQL 一致快照，按发生时间及流水号倒序分页；快照时点后的写入不进入文件。编码在独立线程，后台生成最多 90 秒、25,000 数据行；编码输入及成品各受 8 MiB 限制。超限返回失败状态，用户应缩小范围。任务自提交起最多可访问 15 分钟，过期由后台清理，也可主动丢弃。文件在 PostgreSQL 临时保留，无 API 本地文件，不进入有界备份或流式业务归档。

下载仅在 `ready` 时返回 200，媒体类型为 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`，带 `Content-Length`、`X-Export-Bytes`、附件名和 `Cache-Control: private, no-store, no-transform`。客户端核对实际接收的字节数后才提供下载。金额、编号、电话等原值按文本写入，用户文本不会被当作 Excel 公式。

## 资料与配置任务

任务包含 id、storeId、ledgerEpoch、type、data；member.update/member.archive 还须 memberId，可捕获 actorId/deviceId。ID 规则同资金命令，storeId 必须匹配当前身份。网页收银、后台与 Android 在线工作台首次提交前已接入原号、完整内容和身份的保存。结果未知时在“账本待办”用原账号/设备选择“按原号核对”：先查原回执，明确原号未查到时只发送同一捕获的请求；回执字段一致才确认。SQLite 独立离线模式只查本机原回执。身份、版本或代际不符时按 [原单处置](refactor-implementation.md#原单与恢复处置) 核对，不自动改号或换绑。

    {
      "id": "<original-task-uuid>",
      "storeId": "<authenticated-store-uuid>",
      "ledgerEpoch": "<captured-book-uuid>",
      "type": "member.update",
      "memberId": "<member-id>",
      "data": { "name": "<reviewed-name>", "phone": "", "notes": "", "tags": [], "expectedVersion": "0" }
    }

- member.create：data 为 name/phone/notes/tags；只建立零余额会员，拒绝任意资金字段。
- member.update：完整资料与 expectedVersion；只更新档案。
- member.archive：data={}，店主且余额为零；保留资料与历史。
- configuration.update：店主、settings 功能；data 为 expectedVersion、完整 services/rechargePlans/rechargeSettings；遗漏实体停用，历史不变。

POST 返回该操作原结果；GET 返回 ledgerEpoch/taskId/type/result/completedAt。门店+任务锁、业务修改、变更水位、完整回执和核心审计在同一事务中。相同任务号改内容、换目标、换类型、换账号或设备均拒绝（TASK_CONFLICT）；重试先重新授权，再返回原结果，不重新执行版本校验或读取当前实体冒充原结果。资料或配置后来变化不改变旧任务结果。GET 仅同账号/设备可见；404 不能证明另一个在途请求永远不会提交。

SQLite standalone 的 executeTask/getTask 使用同一任务合同；便捷 createMember/updateMember/archiveMember/updateConfiguration 方法必须显式提供任务元数据，不能自动生成一个不可恢复的新号。结果用 local_task_receipts、task_member_results/tags、task_configuration_results/services/plans 关系表保存并禁止改删，不存整店 JSON。cloud 副本的资料/配置任务须在线发送服务器，再拉增量，不能冒充本地权威。

## 持久资料批次与取消/续传

批次仅编排 member.create/member.update/member.archive；不编排资金或配置，不代替新空账本期初导入的全批原子事务。批次必须提供 id、storeId、ledgerEpoch、actorId、deviceId 和 items。items 每行含独立原始 id、type、完整 data，编辑/归档含 memberId。编辑 data.expectedVersion 在捕获时固定。可选 sourceDigest 是原文件 SHA-256 来源标记；摘要不是来源签名。可选 phone/notes 必须为文本或省略，不能用 null 表示空白。

    {
      "id": "<original-batch-uuid>",
      "storeId": "<store-uuid>",
      "ledgerEpoch": "<captured-book-uuid>",
      "actorId": "<captured-user-id>",
      "deviceId": "<captured-device-id>",
      "sourceDigest": "<source-file-sha256>",
      "items": [
        { "id": "<original-row-task-uuid>", "type": "member.create", "data": { "name": "<reviewed-name>" } }
      ]
    }

captureBatch 的头、行、标签、paused/version="0" 控制行和审计在同一事务持久化。姓名/电话/备注、标签原顺序与省略状态、原版本、行任务号都以明确关系列保存，不存批次 JSON 集合。相同批次号和完整内容重试不重建、不自动继续；改内容返回 BATCH_CONFLICT。行任务号不能属于另一个批次；已有同身份同内容回执可被识别为已完成，其他内容拒绝。

首次继续须 controlBatch({id,storeId,ledgerEpoch,actorId,deviceId,state:"active",expectedVersion:"0"})。每次控制成功版本加一；紧接其后的相同版本/状态重试返回原控制结果，经过后续控制后旧版本返回 BATCH_VERSION_CHANGED。paused 可明确继续；cancelled 为终态，只将未完成行终止，不能撤销已提交业务或再次激活。

每行执行都先锁原任务、再锁批次，在行事务内重查当前身份、许可、代际及 active 状态，再将业务、回执、审计和同步水位共同提交。取消取得同一批次锁：先于取消完成的行保留回执；取消之后，包括曾在网络/任务锁中等待的原行请求，都不能写入。直接调用 /tasks 使用该行号也不能绕过屏障。已完成行在重新授权后仍可返回原结果；GET task 的 404 从不被解释为“确定未执行”。

getBatch 的完成数来自逐任务回执，不来自前端进度或重放计数。每页最多 100 行，nextAfter 为下一页所用的前一行位置，全部完成后 pendingCount=0；取消后剩余计入 cancelledCount。getBatchItem 返回原始行内容，禁止客户端自动改版本、改号或换绑账号再续传。listBatches 按批次号分页，after 为原页尾批次号；它可在重开后发现原捕获，不依赖 localStorage 保存业务集合。

SQLite standalone 提供同名 captureBatch/controlBatch/getBatch/getBatchItem/listBatches/executeBatchItem 方法；cloud 副本不在本地执行资料批次。createBatchRunner 是有界前台控制器，每次最多执行 500 行：从仓储读原行，任何未知响应或版本冲突立即停止后续发送，下次明确执行读取回执再续传；不自动生成任务号、刷新版本或重试循环。AbortSignal 只停止此控制器后续发送，不等于数据库已终止批次；可靠暂停/取消必须等待 controlBatch 的确认或原版本重试结果。

两种完整业务备份都保留批次捕获、控制和审计，核验整体/逐行原请求摘要。恢复保留历史批次来源代际，新代际不能续传旧批次。批次页面已接入原行、暂停/继续及冲突提示，手机进程中断和恢复体验仍须真机验收。

## 资金命令

所有命令包含 id、storeId、ledgerEpoch、memberId、type、expectedAccountVersion。ID 为 16～80 个字母/数字/连字符，推荐 UUID。storeId 必须匹配当前身份。

可选 actorId/deviceId 一旦捕获就必须匹配当前认证账号/设备；SQLite 自动捕获两者并保留在 typed outbox 中。切换账号后的旧待办返回 blocked/PENDING_ACTOR_CHANGED，不发起提交；同会员存在其他身份待办时不能新记资金。

    {
      "id": "<original-command-uuid>",
      "storeId": "<authenticated-store-uuid>",
      "ledgerEpoch": "<captured-book-uuid>",
      "memberId": "<member-id>",
      "type": "recharge",
      "expectedAccountVersion": "0",
      "actualPayCents": "1010",
      "giftCents": "101",
      "payMethod": "现金",
      "remark": ""
    }

- recharge：actualPayCents 大于 0，giftCents 默认 "0" 且不小于 0；可以抵欠款，抵后仍为负不需要消费欠款确认。
- consume：amountCents 大于 0，可有 itemsSummary、remark；结果为负须 allowDebt=true，确认必须为布尔值。
- reverse：店主提交 originalEntryId、reason、可选 allowDebt；只撤销同会员尚未冲正的原单，不能再撤销冲正。导致负余额须明确确认。账务冲正不代表真实现金退款已支付。

配置金额仍为字符串分。配置任务的 data 包含 services=[{id,name,priceCents}]、rechargePlans=[{id,payCents,giftCents}] 和 rechargeSettings={giftEnabled:boolean,giftRateBasisPoints:0..10000}；分别最多 500 个服务和 200 个套餐。服务价格允许 0，但整笔消费须大于 0；套餐实付须大于 0。关闭赠送不能保留带赠送的有效套餐。

recharge 可带 planId、configurationVersion，以及 payments=[{method,amountCents}] 组合支付（最多 16 行），付款之和必须等于 actualPayCents；payments 和 payMethod 不能同时传。consume 可带 items=[{serviceId?,name,quantity,unitPriceCents}]（最多 100 行，quantity 为 1～9999 整数），行合计之和须等于 amountCents。使用套餐/服务 ID 必须携带配置版本并核对当前名称/价格；自定义成交可无服务 ID。SQLite 对所有非冲正命令自动捕获配置版本，重启后原号重试仍使用原版本。

配置版本变化返回 CONFIGURATION_VERSION_CHANGED，停用/改价或伪造价格返回 SALE_PRICE_CHANGED，关闭赠送返回 GIFT_DISABLED。同步不自动换版本接受原命令。资金成功时把项目、付款和充值规则分别写入 consumption_items/payment_records/recharge_details；历史查询读取成交快照，禁止联接当前价格重算历史。原号重试先读取原回执，再检查当前价格，规则变化不能破坏已提交命令的幂等性。

账户行锁内校验版本，成功加 1，并原子写原单、余额、必要冲正关系、完整回执、核心审计和变更。重复命令先查原回执，同账号/设备/完整内容返回原结果；相同 ID 不同内容返回 COMMAND_CONFLICT。账户已变化返回 ACCOUNT_VERSION_CHANGED，客户端不能自动刷新版本重新扣款。

结果包括 storeId、ledgerEpoch、commandId、entryId、memberId、type、deltaCents、balanceBeforeCents、balanceAfterCents、accountVersion、occurredAt、cursor。未知结果须查询/重试同命令；SQLite 待办在回执匹配后才移除。拒绝不得留下余额、原单或半成品回执。

### 天猫精灵确认

保持已绑定设备、签名和稳定平台请求/会话标识。预览保留原资金命令、资料版本、余额版本、配置版本、代际和授权绑定，五分钟内须匹配原预览 ID 或平台 1.0 的槽位确认轮次。设备、平台用户和会话边界各自隔离；资料、余额、配置、账号、授权或代际变化须重新核对。预览不写账。手工付款记录为“语音充值”；目录定价消费保留服务 ID、名称和成交价，手工改价作为自定义行保存。金额按整数分解析、计算和保留。会员查询使用门店范围的 SQL，累计到账排除期初和已冲正充值，最近一次到店取未冲正消费。

确认使用内部保留的 voice- 命令号和设备标识，常规会话不能以该命令号执行写入。账务结果、增量、审计、语音回执和清理待确认同一事务提交。原回执只在原授权绑定下返回，未识别到原预览、重复的确认轮次或普通重复 webhook 均不再记账。旧协议的语音业务分支仍须在 RF-04 删除。

## 期初与增量

正式期初请求包含 ledgerEpoch、batchId、sourceDigest、expectedCount、members；每人字段 id,name,phone,notes,tags,balanceCents，可有 sourceMemberId。正式单店来源应恰为确认的 91 人；服务按显式 expectedCount 校验全量，不截断、不补造。本轮测试均为合成资料。

服务重算 payloadDigest 和逐行摘要，同批或同源同内容重试返回原结果。新来源在已有任何关系化会员、期初或流水后拒绝；已成功的原批次只返回收据，不重置营业后的余额。期初允许负/零/正，不生成充值，也不增加期间实收/赠送/消费。

cursor 不透明，不能按 JavaScript 毫秒重造；服务保留 PG 微秒边界。资金顺序由 accountVersion 表示，不以墙钟时间或随机 ID 串联余额。

增量每项含 cursor、entityType、entityId、changeType、value，支持 member/ledger/configuration；配置实体固定 id=store。归档仍返回档案和 archivedAt，冲正同时更新原单关系与新单；ledger 携带 items/payments/recharge 成交快照。value 为该页面一致快照中的当前实体，可能比单个较早事件更新；按实体/版本去重，不能把重复的 value 当成新的资金变化再加一次。

一页的水位、事件和实体来自一致数据库快照。head 的分配与提交受行锁约束，未提交水位不会导致跳过晚提交交易。同代际缺失历史返回 CURSOR_HISTORY_INCOMPLETE，游标高于服务端返回 CURSOR_AHEAD；自动同步不会回拨游标或静默重建。

SQLite 要求 storeId 匹配，页面和游标同事务落库；有本地待办的会员不能被远端覆盖。先提交原命令，再拉取增量；冲突保留原单和待办，等待显式核对。原账号可查询原号确认或保存原单；同代际未找到原回执不收尾。

基础报表 actualPayCents/giftCents 为期间新充值毛额，consumptionCents 为期间新消费，reversalDeltaCents 单列，netChangeCents 为全部新流水净变化。储值/欠款分列，期初不作期间收入；不得误标成已扣除真实现金退款的净收入或完整历史累计。

另含 reversedActualPayCents/reversedGiftCents/reversedConsumptionCents 和对应 netActualPayCents/netGiftCents/netConsumptionCents。冲正按冲正发生期间抵销原单快照；原单在以前期间时，本期净额可以为负。breakdown 同样按历史快照列出服务净数量/金额或付款方式账面净额，服务按 serviceId+成交名称分组。游标绑定期间、类型与账本代际，换条件须从首页重查。上述净额为账务口径，不能当作现金退款已经结算的证明。

报表时间必须为带时区的有效 ISO 时间，最多毫秒，归一 UTC；拒绝无时区、非法日历和隐式自然语言。明细游标为规范 UTF-8 base64url，绑定期间/类型/账本代际，名称按二进制 Unicode 顺序；PG 显式 C collation，与 SQLite 一致。标签亦使用同一顺序。

business 只允许一次最多 366 个日历日；offsetMinutes 是固定 UTC 偏移分钟，默认 480，可为 -840～840 的整数，不是 IANA/DST 时区规则。from/to 仍为精确时间；首尾部分日期会明确列出。daily 补全零记录日，超过 31 日的 trend 按日历月汇总。summary/daily/trend 分开保存充值实收/赠送/到账毛额、消费毛额、冲正数量/原实收/原赠送/原消费和对应净额；笔数为毛交易笔数，消费人数为期间有新消费的不同会员数，averageConsumeCents 为消费毛额÷消费笔数，精确四舍五入到分。期初不计收入或新增会员；newActiveMemberCount 还排除当前已归档会员。

ranking 按本期消费减本期消费冲正的净额降序取前十（再按净笔数、会员 ID 排序），零净额不列，跨期冲正可产生负净额/负净笔数；名称为当前保留的档案名称。balances 是当前在用会员，不随期间改变：storedCents 为正储值，debtCents 为负欠款，debt/zero/low/fundedCount 按欠款、零、(0,5000] 分和 >5000 分分组。这与旧界面“按撤销状态回改原期间有效交易”的算法不同；RF-03 必须同步修改标签和统计说明，不得混用新结果和旧文案。

SQLite 的 summary/breakdown/business 同口径，用整数高低位分段 SQL 聚合与 BigInt 合并，汇总可超过单笔 BIGINT，不能转 REAL 或 Number 凑合。每次查询最多 500 个聚合行，内存中仅日历桶和前十排行，不向桥传输全流水。cloud 报表使用服务器确认时间；未确认交易使用本地时间，并带 localState.mode/ledgerEpoch/cursor/pendingCount/conflictCount，不能把副本报表标成服务器完整权威报表。D1/D2 性能预算仍须实测。

## 手机云端副本重建

店主可在“本机同步”核对同店目标后重建。仅允许当前代际历史缺口或已核对的合法换代；同代际 CURSOR_AHEAD、门店不符、未知操作或未核对待办均不能覆盖本机。准备阶段只读取账本与本机待办。

`GET /api/v2/sync/snapshot?ledgerEpoch=…` 返回 `application/x-ndjson`，格式 `member-relational-stream` / `formatVersion=1`、`engine=cloud-replica` / `schemaVersion=1`。同一 PG 快照按 head、configuration、member、ledger 顺序输出；成员与确认流水分页，每页至多 100 行，按键推进。包含期初、当前配置和成交/冲正关系，不包含本机待办、历史操作凭据、业务归档全表或恢复任务。未完整收到 footer 或校验失败不得使用。

SQLite 在同一个写事务内替换投影、校验成员期初、账户版本及余额连续性、冲正关系，保存游标和审计。提交前再向云端查询店主权限、目标代际与当前水位；云端已换代或水位低于收到的快照时回滚。更高的同代际水位由后续增量追平。取消、传输失败、权限变化和提交前故障均回滚；若提交已发生但确认响应丢失，重开 SQLite 核对当前代际和水位。服务器依旧在每笔写事务中检查代际。

换代的本机待办须由原账号/原设备逐笔核对。选择“已核对金额”或“登记人工处理”，将含原命令、原回执、原/目标代际和结论的文件写到应用外并读回字节摘要。核对记录绑定本次目标，重建事务成功前保留待办，旧单永不改号重发。在线结果未知也只保存原请求/原编号，外部文件回读成功后才结束跨代际待办；网页版需要支持选择及读回外部文件的浏览器。匹配原号回执才确认同代际资金；单次 404 不能证明请求永远不会提交。异常处置见 [实施台账](refactor-implementation.md#原单与恢复处置)。

## 独立离线备份核心

SQLite 仓储提供 exportBackup() 和 restoreBackup(object,metadata)，仅同店 standalone 账本、店主且 backup 功能有效时可用。此有界格式为 member-relational-sqlite，formatVersion=4、schemaVersion=6，并带当前 ledgerEpoch；包含明确关系表、新交易/命令及任务回执/冲正/成交快照/审计、完整期初、资料批次原始捕获/控制及恢复回执，不含登录凭据、许可密钥或旧 JSON 账本。SHA-256 摘要用于完整性检查，不是来源签名或加密，外部文件仍须妥善保管。

恢复前核验摘要、表/列白名单、门店归属、代际格式、规范 UTC 毫秒时间、期初分项、连续账户版本、逐笔与最终余额守恒、命令/任务回执、审计和成交快照；整个新空库恢复与新代际创建为一个 SQLite 事务。返回 ledgerEpoch 与 sourceLedgerEpoch；提交失败时连同换代全部回滚。保留历史回执原代际，恢复后新的营业请求须重新核对并捕获新代际。已有任何业务/配置/审计即 BACKUP_NOT_EMPTY，不覆盖开业后的新交易。cloud 副本拒绝此接口，防止以本地文件覆盖服务器权威或未确认待办。导出按 rowid 每 500 行读取，超过 1,000 行的表不会越过 Android 桥限制，也不截断。

metadata 必须完整包含首次捕获的 {id,ledgerEpoch,actorId,deviceId,digest}，digest 为已核对的文件摘要，不能在调用中自动生成恢复号或绑定当前代际。来源读取/摘要计算前就复制这些字段，调用方后续修改对象不能改变已捕获任务。事务先查同号完成回执，再检查空目标及原目标代际；同文件、原目标代际、当前身份的精确重试返回首次结果，即使其后已有新交易也不重做恢复。getRestoreReceipt(metadata) 可查询原结果，404 不能作为换号重做依据。恢复回执、新代际和 ledger_restored 审计一次提交，不能改删；有界备份与流式格式都保留恢复回执。

schemaVersion=1/2/3/4/5 的开发态数据库和旧开发态备份失败关闭，拒绝自动覆盖；本轮未发布生产 schema 迁移，不可借升级清除其中数据。新空库为 schema 6、有界备份格式为 4。已验证旧 schema 1/2/3/4/5 记录保留，初始化在任何新业务 DDL 前拒绝。

有界接口仍限制 20,000 会员、50,000 流水和 32 MiB，超限明确拒绝；Android 增长备份改用下述流式合同。真机提供方及应用外读回尚未签收，不得据此卸载旧手机。

## SQLite 流式增长备份核心

[流式编解码](../src/relational-archive.js)、[SQLite 应用层](../src/relational-sqlite-archive.js) 和 [分页语义校验](../src/relational-sqlite-validation.js) 提供以下仓储接口。Android 独立离线账本的备份页面通过流式文档控制器调用这些接口：

- exportArchive({write,signal})：write 是接收一行规范 UTF-8 JSON 文本的异步接口，每次 await 后才发送下一块；返回摘要、字节数、表计数及账本代际，不返回整库对象，也不宣称外部文件已保存/读回。
- previewArchiveRestore({chunks,ledgerEpoch,actorId,deviceId,signal})：chunks 为拉取式 Uint8Array 流，导入空目标事务后完成全部文件与数据库校验，再成功 ROLLBACK，返回数量、文件摘要和源/目标代际。回滚失败必须报错并停用连接，不能伪装预览成功。
- restoreArchive({chunks,id,ledgerEpoch,actorId,deviceId,digest,signal})：完整原任务与核对摘要必传；记录、资金语义校验、新代际、持久回执和审计同事务。精确完成重试不再次拉取文件；未完成事务的损坏、截断、取消、授权变化及 SQL/提交错误均不报成功。实际提交后响应丢失时须重新打开已停用连接，再查原回执或重试原号。

文件为 member-relational-stream、formatVersion=1、engine=sqlite、schemaVersion=6 的规范 NDJSON。头包含门店、来源代际和导出时间；每块包含顺序号、前块摘要和本块摘要；每表必须有结束计数，整个文件必须有最终结束记录及换行。字段/表/列固定白名单，不执行文件中的 SQL。缺尾、重复字段、重排、无效 UTF-8、摘要/计数不符及尾部多余内容均拒绝。

显式资源上限为单帧 512 KiB、单输入块 1 MiB、每帧 200 行、每表 4,000,000 行、全文件 20,000,000 行/8 GiB/1,000,000 帧；这些是拒绝边界，不是手机容量承诺。插入最多 120 个绑定；数据库读取分页最多 500 行（当前实现通常为 200），逐会员流水每页 64 笔；任务/批次关联只收集其领域上限内的行，不汇集全店历史。逐笔守恒、配置/成交快照、任务原结果、批次原捕获和审计在数据库分页核验，重算文件摘要链不能绕过业务不变量。

导出由 driver.openSnapshot() 建立独立只读 WAL 快照；Node 和 Android 驱动均已实现。导出期间营业写入可提交，文件保留快照时点；周期检查身份、许可及代际，取消、写端失败和关闭释放读连接。驱动缺少能力时返回 ARCHIVE_SNAPSHOT_UNAVAILABLE。Android 使用 AndroidX bundled SQLite 2.7.1，两连接使用相同引擎，桥限制 1,000 行和约 1 MiB 序列化结果，64 位整数传文本。

[桌面容量工具](../tools/relational-growth-sqlite.mjs) 通过 npm run refactor:capacity:sqlite 创建仓库 output 下的全新合成文件，默认 1,000 会员/100,000 流水，--smoke 为小型自检；不接收真实路径、连接串或会员来源。它使用单事务直接种子验证备份容量，以独立金额公式核对全部会员，记录外部字节读回、快照并发写入、预览回滚、恢复后交易、原号重试、SQL/内存边界和源码摘要。不是 100,000 次应用交易、手机延迟或 PostgreSQL 压测通过证明；实测证据见实施台账。

## 云端完整业务备份与空库恢复核心

格式为 member-relational-postgres，formatVersion=2、schemaVersion=2；旧开发格式 1 不自动接受。导出在 REPEATABLE READ 一致快照内按原生主键每页最多 500 行读取；数字键排序使用原始 BIGINT/整数列，不按导出文本别名排序。所有 SQL 值为文本或明确可空值，时间为规范 UTC 六位微秒；原始会员、账户、期初、资金、冲正、服务/套餐/规则、成交快照、命令及任务原结果、资料批次原始捕获/控制、同步水位与变更、核心业务审计和既往恢复回执进入白名单关系表。审计 event_id 是可恢复的逻辑 UUID，原服务器全局 bigserial 仅作本地分页键，不带入目标，避免与其他门店已有日志冲突。

不备份账号密码、会话、设备授权、商业许可、平台账号、语音机密或旧 accounts.data。只带被业务历史引用的操作人 ID、同店归属、显示名和创建时间；目标同 ID 同门店的现有账号保持原样，不能覆盖其角色、密码、启用状态或显示名。同 ID 已属其他门店则 RESTORE_ACTOR_CONFLICT，全事务不写入。缺失的操作人只创建 historical_only=true、active=false、viewer、不可用于正常登录的固定用户名和无效密码引用；数据库 CHECK、恢复角色写入触发器、认证和员工/平台管理入口共同阻止激活、提升权限或重置其密码。历史引用不占 100 个管理账号数量预算。

预览/正式请求均为 {id,ledgerEpoch,reviewedDigest,backup}；id 为首次捕获的恢复任务号，ledgerEpoch 为已核对的空目标代际，reviewedDigest 必须等于备份摘要。服务同步捕获请求，摘要是 SHA-256 完整性校验，不是来源签名或加密。校验表/列、门店、代际、微秒时间、资金守恒、连续版本、历史价格/付款/规则、回执原结果、水位连续性和核心审计；恢复前另检查目标业务为空。新目标可以已有身份、授权及登录审计；只有未经修改的默认 version=0 赠送配置可作为初始化行存在。已有任何业务/回执/变更/核心审计或有意义配置均 RESTORE_NOT_EMPTY，不提供覆盖恢复。

正式恢复使用 RECOVERY_DATABASE_URL 对应的 member_recovery 独立连接；未配置返回 RECOVERY_UNAVAILABLE（503）。迁移可通过独立 RECOVERY_DATABASE_PASSWORD 创建此角色，生产启动校验其受限权限。角色没有 DDL、删除历史、修改既往资金/回执/审计、改变凭据/会话/授权的能力；为授权行锁授予的无操作列 UPDATE 由触发器禁止实质变更。普通 member_app 不能更新 ledger_epoch、historical_only、写恢复回执或调用恢复统计函数。迁移重设角色时同时撤销遗留列权限，避免仅 REVOKE 表权限留下越界授权。两条连接必须指向同一独立 PostgreSQL 数据库；默认 Compose 不启用本机 PG。

事务先取排他门店锁，再重新核对当前店主、会话、设备和 backup 授权；历史引用、业务行、同步水位、原回执来源、新 ledgerEpoch、恢复回执与核心恢复审计一起提交，任一步和 COMMIT 故障均回滚。恢复返回 taskId、storeId、targetEpoch、sourceEpoch、ledgerEpoch、sourceDigest、memberCount、entryCount、completedAt。恢复成功后即使已有新交易，相同恢复号、原目标代际、文件、当前账号/设备的重试仍只返回首次回执；改变任一绑定返回 RESTORE_TASK_CONFLICT。此例外仅恢复操作本身可用，不能用于重放旧资金/资料任务。恢复后再次导出的备份包含既往恢复回执和逻辑审计身份。

有界接口已验证 PGlite 和可丢弃真实 PostgreSQL，覆盖独立恢复角色、同店空目标、操作人隔离、损坏文件和失败回滚。有界格式受 32 MiB、20,000 会员/50,000 流水和每表 150,000 行上限约束；日常增长备份使用下文流式合同，真实目标代理和灾备演练仍待验收。

## Android 外部文档桥与独立离线文件流程

[android-backup-documents.js](../src/android-backup-documents.js) 与注册在 MainActivity 的 [BackupDocumentsPlugin.java](../android/app/src/main/java/com/hairstudio/memberapp/BackupDocumentsPlugin.java) 提供 Android 系统文档选择器接口。save 先把有界 UTF-8 内容暂存在原生内存，再把小 token/文件名交给 ACTION_CREATE_DOCUMENT；完整账本不进入 Activity 的保存状态参数，也不写缓存文件或原生私有文件。用户取消只返回 cancelled；原生进程重建丢失内存捕获时拒绝写入，不能补造旧备份。一次只允许一个文件流程，结束后释放捕获。

写完并关闭用户选择的文档后，重新打开读取，核对完整字节数和 SHA-256 才返回 saved-verified；普通分享完成或发起下载不具有这个状态。只接受用户选择的 content URI，拒绝本应用 FileProvider，不接收任意路径/URI 参数、不申请广泛存储权限、不保留文档授权。读取同样使用 ACTION_OPEN_DOCUMENT，按实际流字节限制 32 MiB，不信任提供方声明的尺寸，严格解码 UTF-8，不打印内容/路径。系统提供方的读回校验不证明远程网盘已经完成离线同步；卸载前仍须在应用外独立打开并保留备份，真机演练不能省略。

[relational-backup-files.js](../src/relational-backup-files.js) 是 standalone 仓储的有界文件控制器，调用方提供当前 getScope()={storeId,actorId,deviceId}。save() 先导出并验证关系备份，再与原生读回摘要核对。chooseRestore() 读取并验证备份后调用仓储 previewBackupRestore，返回只含数量、摘要、源/目标代际的预览和不透明 token；完整候选文件私有保存在控制器内存，不进入 localStorage 或公开预览对象。restore(token,reviewedDigest) 必须匹配所选预览；token 同时作为稳定恢复任务号，将原目标代际、账号/设备及摘要交给事务核验。已完成回执在空目标检查前返回，故响应丢失后即使已经新增交易，保留的原预览重试仍能取回原结果。没有覆盖/合并既有账本模式，cloud 副本拒绝文件替换。

取消新选文件会清除旧预览；校验失败不会写入资金；提交失败保留原预览供显式重试。外部文件写入或恢复提交完成后才发生账号切换时，结果标记 contextChanged，调用方不能在新身份界面显示旧身份成功或自动刷新其业务；不会把已经完成的写入误报为失败。预览在进程退出后不恢复，不会在重开时自动执行资金恢复。

增长格式由 [流式文档桥](../src/android-archive-documents.js) 与 [文件控制器](../src/relational-archive-files.js) 提供。先选文件再启动快照；64 KiB 块按序传输，关闭后重开读回长度和 SHA-256。预览只保存句柄、所属身份、目标代际及摘要，不缓存完整账本。首次正式恢复按原捕获在事务内重读文件；已确认的恢复原号查回执，无需重读文件或覆盖后续账务。Android 主代码、JVM 单测与仪表源码已通过 Gradle；主界面已接入，实际系统选择器、提供方故障、杀进程、独立读回和卸载重装仍须真机验收。

## PostgreSQL 流式增长备份

[PG 流式应用层](../server/relational-archive.js)、[分页读取](../server/relational-pg-reader.js)、[数据库语义校验](../server/relational-pg-validation.js) 与 [HTTP 流](../server/relational-archive-http.js) 使用共享 NDJSON 摘要链格式；engine=postgres、schemaVersion=2、formatVersion=1，与 SQLite engine/schema 隔离。服务器不创建业务文件、临时表或本地 SQLite 镜像，不向恢复文件开放 SQL、列名或凭据。新格式使用现有 PG 关系表，不增加业务列。

| 接口 | 输入与结果 |
| --- | --- |
| GET /api/v2/backup/archive | 无查询参数；当前店主、backup 授权；返回 application/x-ndjson; charset=utf-8 字节流，固定附件名；HTTP 完整结束后才可当作下载完成 |
| POST /api/v2/backup/archive/restore/preview?id=…&ledgerEpoch=… | application/x-ndjson UTF-8 请求体；id 为预先捕获的稳定恢复任务号，ledgerEpoch 为原目标代际；在独立恢复账号下完整导入、校验后 ROLLBACK；仅成功回滚才返回预览 |
| POST /api/v2/backup/archive/restore?id=…&ledgerEpoch=…&sourceEpoch=…&reviewedDigest=… | 同一文件字节流；sourceEpoch/sourceDigest 必须来自原预览（查询参数名为 reviewedDigest）；历史操作人、业务、新代际、回执和审计一次提交 |
| GET /api/v2/backup/restores/:id?ledgerEpoch=… | 沿用恢复回执查询；仅原账号、设备、原目标代际可取；不因当前账本已换代而换绑 |

预览返回 taskId、sourceDigest、sourceEpoch、targetEpoch、memberCount、entryCount、historicalActorCount、byteLength、rowCount，不返回整个业务对象。恢复结果沿用有界接口。相同原任务号、原目标/来源代际、摘要、当前账号/设备的已完成重试在读取请求体之前返回原回执，即使已经新增资金也不会再次恢复；冲突为 RESTORE_TASK_CONFLICT。HTTP 在这种未读取上传体的重试中关闭该连接，不持续排空任意大小的数据。不得把旧待办的 ledgerEpoch 改成新值续传。

每帧最多 512 KiB/200 行，每次输入块最多 1 MiB；单表最多 4,000,000 行、合计 20,000,000 行、文件 8 GiB、1,000,000 帧。这些是拒绝上限，不是容量或手机资源承诺。所有表均需顺序 tableEnd 和完整最终 end+换行，严格 UTF-8、规范帧 JSON、摘要链、计数及末尾无多余数据。sourceDigest 是末帧摘要链，不是整个文件字节 SHA-256；外部文档仍须独立做完整字节写后读回核对。

导出使用 REPEATABLE READ 快照和原生类型键分页；每会员资金历史以 64 笔页校验，任务/成交/批次仅收集领域上限内的关联，金额聚合留在 PG。操作人按 UUID 排序导出，恢复在数据库重算引用集合的有序摘要，拒绝缺失或多余历史引用。字段、时间微秒、资金/回执/成交/原批次哈希、同步连续水位、核心审计与恢复历史均在最终提交前校验。只允许同店空目标，现有未经修改的 version=0 默认赠送配置可保留或由文件覆盖。

HTTP 每帧等待 Node 写回调完成，传输错误/客户断开结束工作；已发送响应头的失败直接中断响应，不追加 JSON 或补造完整 footer。上传为按需读取，不走 JSON body 缓冲。传输操作总期限 10 分钟（含授权/校验），每次字节源/写端等待 15 秒；SQL 仍受连接池 statement/lock 超时约束。普通非流式请求保留 30 秒请求体期限。慢传输期间定期 SELECT 1 只维持原快照，不声称刷新了授权视图。

PG 在当前快照或恢复事务内使用数据库游标顺序扫描，每次向 API 最多取 200 行；每帧校验后一次入库，帧仍限 512 KiB。档案与资金审计在 PG 中核对，逐账户按整数版本验证余额链。恢复在流水表导入完成后、后续明细外键检查前刷新统计，全部导入后再刷新一次，避免预览回滚留下失真统计而反复扫描整店。迁移安装无参数的 refresh_recovery_statistics()，以 SECURITY DEFINER、固定 search_path=pg_catalog 和迁移时完整限定的七张表执行 ANALYZE；从 PUBLIC 撤权，仅恢复角色获执行权，不授予 MAINTAIN、对象所有权或任意 SQL 能力。普通角色越权或恢复角色缺少执行权均阻止启动。归档保持原表序、格式和哈希链。

一致快照期间持有门店/当前账号/会话/许可的共享锁；资金事务也用共享授权锁，设计允许其继续提交，撤销/换代的排他更新需要等待有界流结束。每个检查点和事务末尾仍按墙钟检查会话/许可到期。真实 PG 专项已通过并发营业写入不进入原快照、撤销等待后生效的用例。目标环境增长归档、代理完整链路、长期资源与故障演练仍须验收。
