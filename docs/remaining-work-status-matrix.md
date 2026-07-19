# `ai-m` 剩余工作状态矩阵

状态：`ACTIVE`  
审计基线：`dev` / `04d1ace`  
审计日期：2026-07-19  
总计划：[剩余工作开发与验收计划](remaining-work-development-and-acceptance-plan.md)

语音依赖决策：[语音依赖开源复用评估](reviews/2026-07-19-speech-dependency-open-source-assessment.md)

第二轮审查：[第二轮独立对抗审查记录](reviews/2026-07-19-second-round-adversarial-review.md)

## 1. 状态判定规则

- `ACCEPTED`：当前代码路径、自动化测试和必要的运行证据都存在。
- `PARTIAL`：已有实现，但缺少计划要求的边界、测试或真实环境证据。
- `NOT_STARTED`：未找到足以证明目标能力的实现。
- `ENVIRONMENT_REQUIRED`：工具和假后端测试已完成，但必须在指定真实设备上运行。

旧计划保留任务设计和历史勾选，不再单独表示当前状态。本文的状态必须随代码和证据更新。

## 2. 运维安全加固任务

| 原任务 | 当前状态 | 当前证据 | 剩余动作 | 映射 |
| --- | --- | --- | --- | --- |
| Task 1：Job/attempt 原子恢复与取消 | ACCEPTED | `state-transitions.ts`；job recovery、worker cancellation 和 cancel/completion 测试 | 保持回归通过 | RW-01 回归 |
| Task 2：资源槽释放与对账 fencing | ACCEPTED | 0060/0061；`leases.ts`；slot reconciliation 多连接测试 | 保持迁移和并发回归通过 | RW-01 回归 |
| Task 3：工件 writer/recovery lease | ACCEPTED | 0062；`commit.ts`；artifact recovery concurrency 和 delayed writer 测试 | 保持回归通过 | RW-01 回归 |
| Task 4：WebSocket 统一端点策略 | ACCEPTED | `comfyui-websocket-policy.test.ts`、connection manager 和 network policy 测试 | 保持 HTTP/WS 共同策略回归 | RW-01 回归 |
| Task 5：ComfyUI 绝对操作超时 | ACCEPTED | `comfyui-deadlines.test.ts`、orchestrator deadline 测试 | 保持 body stream/slowloris 回归 | RW-01 回归 |
| Task 6：可信代理证明和持久防重放 | ACCEPTED | v2 精确请求证明、0063 durable nonce、跨进程 replay 和请求变异测试均通过 | 保持安全回归和迁移回归 | RW-01 / SEC-01 |
| Task 7：入队前规范化 compiled input | ACCEPTED | 服务层 typed snapshot、v2 digest/双读、零 job/attempt/slot 集成测试、400/413 API 测试 | 保持专项与构建回归 | RW-01 / SEC-02 |
| Task 8：输入快照和单一已验证句柄 | ACCEPTED | 0064 job input descriptor snapshot、事务内链接、跨连接删除保护、单句柄/路径身份复核测试 | 保持迁移、文件系统与 worker 回归 | RW-01 / SEC-03 |
| Task 9：源工件配额预留 | ACCEPTED | 0065 reservation 状态机、BEGIN IMMEDIATE、多进程竞争、续租/TTL、断连与探测失败清理测试 | 保持迁移与上传失败回归 | RW-01 / SEC-04 |
| Task 10：语音配置并发幂等 | ACCEPTED | 0066 scoped key/digest、双进程 winner、语义冲突 409、project/user 隔离和 API 测试 | 保持迁移与并发回归 | RW-01 / SEC-05 |
| Task 11：中央 mutation origin/CSRF | ACCEPTED | `proxy.ts` 对全部 API mutation 执行中央分类；静态测试枚举 53 个 mutating handlers；浏览器、admin bearer 和 trusted-proxy 边界测试通过 | 保持路由覆盖、来源校验和生产构建回归 | RW-01 / SEC-06 |
| Task 12：canonical JSON/bytes 摘要分离 | ACCEPTED | `canonical.test.ts` 覆盖排序、Unicode、数值、非法值、循环和 API 歧义；全部调用已迁移为 `sha256Canonical`/`sha256Bytes`，无 `sha256(value)` 残留 | 保持黄金向量和持久摘要回归 | RW-01 / SEC-07 |

## 3. 单端口 ComfyUI 任务

| 原任务 | 当前状态 | 当前证据 | 剩余动作 | 映射 |
| --- | --- | --- | --- | --- |
| Task 1：托管运行时控制器 | ACCEPTED | `managed-comfyui-runtime.ts` 及真实子进程/本地服务器测试 | 保持回归 | RW-02 前置 |
| Task 2：任务结算后重启边界 | ACCEPTED | `job-runtime-boundary.ts`、Worker 顺序和 fail-stop 测试 | 保持回归 | RW-02 前置 |
| Task 3：十个不可变 Pixelle 包 | ACCEPTED | 九个唯一源工作流生成十包；代际 `a39c4c9340299866b75d7137f1622f8fa616b1cd12b8d12a630781321acc2467` 已完成摘要、锁、模型字节和运行时分类复核 | 保持代际不变性 | RW-02 前置 |
| Task 4：真实单机配置和验证 | BLOCKED | 十包只读现场盘点通过，未提交任务、未重启、未签发证据。IndexTTS2 与 OmniVoice 的核心依赖版本无交集，当前正式验收器又只能管理一套解释器和服务根目录；Windows 文件系统目录级同步也不满足正式证据耐久性要求 | 实现并验收多执行环境监督与统一证据；准备受控音频和双参考图；十包顺序实跑并补齐应用任务链、资源槽与数据库证据 | RW-02、RW-03 |
| Task 5：双轮审查和集成 | BLOCKED | 两名独立审查代理已完成两轮；第二轮确认受控输入证据、多文件一致快照和十包文档问题，相关代码问题已修复并通过全量门禁，但多执行环境与正式设备证据仍未关闭 | 完成真实发布、两个不同操作系统身份审批和回滚演练 | RW-05、RW-06 |

## 4. 实施检查表未完成项映射

### 4.1 未完成 `[ ]`

| 分类/项目 | 映射 |
| --- | --- |
| L 真实设备验收 | RW-02 |

### 4.2 部分完成 `[~]`

| 分类/项目 | 已有能力 | 剩余动作 | 映射 |
| --- | --- | --- | --- |
| C 隔离后端冒烟 | 本地假后端通过 | 真实隔离设备通过 | RW-02 |
| I 输入权限 | source asset、voice profile、artifact 已复核 | 中央 guard 和入口覆盖 | RW-01/SEC-06、RW-04 |
| M 统一关联编号 | 已完成：job `traceId`→attempt/backend correlation→artifact metadata | 无 | RW-04 |
| M 阶段耗时 | 已完成：按 phase 汇总数量、平均和最大耗时 | 无 | RW-04 |
| M 提交不确定告警 | 已完成：持久告警、证据确认、自动恢复 | 无 | RW-04 |
| M 租约失效告警 | 已完成：24h 错误与过期槽位触发 critical | 无 | RW-04 |
| M 环境漂移告警 | 已完成：环境/模型/validation 漂移触发 warning | 无 | RW-04 |
| M 磁盘水位告警 | 已完成：85% warning、95% critical、降阈值自动恢复 | 无 | RW-04 |
| N 回滚保留新数据 | 有文档原则 | 自动检查和隔离回滚演练 | RW-06 |

## 5. 本轮证据

### 5.1 已发现并修复的基线阻断

Windows `core.autocrlf=true` 会将 0061 SQL 物化为 CRLF，而迁移前置条件仅接受仓库 LF 字节摘要，导致所有测试数据库初始化失败。当前修复让前置条件只接受该迁移已知的 LF/CRLF 两个精确身份，其他摘要继续 fail closed，并更新跨平台测试。

### 5.2 当前已运行命令

```text
corepack pnpm vitest run
  src/lib/db/__tests__/migration-startup.test.ts
  src/lib/generation/resources/__tests__/leases.test.ts
  src/lib/generation/archiving/__tests__/commit.test.ts
结果：3 files / 96 tests passed

corepack pnpm vitest run
  src/lib/generation/workflows/__tests__/validator.test.ts
  scripts/__tests__/verify-single-comfyui.test.ts
  src/lib/generation/transports/__tests__/orchestrator-integration.test.ts
  src/worker/__tests__/index.test.ts
  src/lib/generation/resources/__tests__/leases.test.ts
  src/lib/generation/archiving/__tests__/commit.test.ts
  src/lib/security/__tests__/network-policy.test.ts
结果：7 files / 167 tests passed

corepack pnpm test:validate-examples
结果：PASS
```

## 6. RW-04 已实现项与未关闭阻断

- 工作流供应链：0067 保存不可变、环境绑定的审查记录；导入者和审查者身份从当前 Windows 登录令牌的 SID（安全标识符）导出，审批服务拒绝未由本进程令牌解析器签发的伪造对象；导入者不能自审，两个不同 SID（安全标识符）审查后才激活。旧的纯文本审批记录不计入门槛。撤销命令会原子阻止新使用、禁用关联配置与默认指针，同时保留历史任务、工件和审批。本控制不抵抗能任意修改进程内存或 SQLite 文件的同 SID 本机管理员。
- 浏览器密钥：model-store 不再写 localStorage 或 sessionStorage，凭据仅存于当前内存；hydration 会清理两类旧存储并写无敏感值迁移标记。
- 审计白名单：控制平面审计仅允许固定字段和标量/字符串数组值；认证配置响应只投影 key reference 和 header name，未知或嵌套字段直接丢弃。
- 项目调度：原子 claim 查询执行每项目并发上限、低活跃项目优先和饥饿时间上限；并发额度竞争、压力公平和饥饿恢复测试通过。
- 通用 semantic selector：所有导入均经 `compileWorkflowBindings()`，每个 binding/output 必须恰好解析到一个节点。
- 通用供应链隔离：导入先将有限额、无链接的普通文件树复制到独立 quarantine，逐文件复核大小与 SHA-256，验证成功后才以原子移动发布；验证失败只清理该 quarantine 子目录。
- 发布目录只读：通用包和 Pixelle 已验证代际在数据库导入前清除文件/目录写位并递归复核，后续修改必须形成新的发布目录和摘要。
- 不确定任务处置台：管理员页面和 API 只读取最小证据字段并写入受控原因码/证据引用审计，明确保持 job/attempt/slot 状态不变，不能用人工确认绕过对账或强制结束。
- 模型不可变身份：prepare 通过单一稳定文件句柄流式读取实际模型，记录精确大小和 SHA-256 到 manifest/environment lock；晋级时重新读取核对，Worker 在提交推理前再次核对，缺少身份或任一大小/摘要漂移均 fail closed。废止旧代际 `72fd10d71b738d036328bd8d4dd8ae32cf76961c8b7340f7fff5e4748aa0accb` 只记录了 Z-Image/Wan 六个模型共约 41.97 GB，不能作为语音候选证据；当前阻塞代际为 `5a40f8bb7c4b8a0f437aca2a73c85e532a9c72e5963acc242992ec4d494d9681`，依赖架构改变后还必须重新生成最终候选代际。
- 项目灰度：全局 feature flag 可附加精确项目 allowlist；任务创建、本地图片和本地语音入口统一执行。未启用全局开关、空/畸形/超限 allowlist 或不在名单的项目均 fail closed。
- 备份恢复：`ops:recovery:rehearse` 在明确停写后生成 SQLite 在线备份和 uploads、通用供应链、Pixelle generation/GC audit、公开 trust metadata 的逐文件摘要清单，只允许恢复到全新隔离目录。2026-07-19 真实演练恢复 85 个文件/25,578,737 字节，bundle digest `4e79b2edfee828185c4e3bc06e2712a06056e21682fab41f1d4996e1232a4122`，恢复点年龄 537ms，恢复耗时 294ms，SQLite integrity 与全量摘要一致。私钥/HMAC key 不进入普通恢复包，继续由受保护密钥存储独立托管。
- 部署隔离：[单端点部署隔离验收记录](comfyui-single-endpoint/deployment-isolation-attestation.md)保存试运行参数与真实进程反证。实际基础目录已改为专用 `E:\ComfyUIData-ai-m`，参数隔离成立；但推理进程与应用仍使用同一 SID（安全标识符），目录访问控制仍允许宽泛读取，因此操作系统层隔离未关闭。
- 代际耐久性：新十包生成记录显示文件同步成功，但 Windows 目录同步结果为 `false`。验证器已改为遇到目录同步不支持时禁止签名和发布；在证明同目录原子改名后的目录项能跨断电持久化，或批准并验证等价的双清单、重放恢复协议前，不能满足 AC-02-05 与 AC-02-14。
- 磁盘满：artifact staging 写入注入真实 `ENOSPC`，结果为有界失败、数据库 `QUARANTINED`、零已发布工件和零残留 staging 文件；archiving 文件 25 项测试通过。
- 统一可观测性：0068 保存四类告警的 OPEN/ACKNOWLEDGED/RESOLVED 生命周期；Worker 与管理 API 刷新任务/阶段/租约/漂移/磁盘指标，确认必须绑定原因码和证据引用，信号清除后自动恢复。任务创建、attempt 提交和工件 metadata 已贯通可信关联号。
- 中央输入权限：`input-access.ts` 统一验证 source media 与 generated artifact 的 committed/project/owner 边界，任务创建和 voice profile 复用同一检查；跨项目、跨用户引用均 fail closed。
- 回滚保护：`ops:rollback:preservation` 将候选摘要、迁移日志、15 张保护表的列、主键和逐行摘要，以及既有工件摘要固化为不可覆盖清单；回滚后拒绝降级迁移、删列、删行、行篡改及工件修改或删除。旧版本真实读取演练仍未完成。

专项证据：双轮审查修复后的最终自动化质量门禁通过：77 个测试文件、837 个测试、21 个运行时测试、69 个迁移、工作进程构建、生产网页构建和两套静态架构检查全部通过；代码检查为零错误、102 个既有警告。十包现场只读盘点同时通过。该门禁证明代码基线可构建且当前服务能识别十包，不替代十包真实生成、部署隔离、故障注入、旧版本读取或不同操作系统身份审批。

第二轮审查修复目录耐久性伪证据、受控输入证据绕过和模型快照竞态后，全量测试更新为 77 个文件、837 项全部通过，类型检查和差异格式检查通过。由于真实十包和环境门禁仍未通过，该结果不构成候选发布门禁。

## 7. 下一执行顺序

1. 完成 RW-04 中不依赖真实 GPU 的供应链、权限和运维代码。
2. 先解决 IndexTTS2 与 OmniVoice 在单一 Python 环境中的不可满足依赖冲突，并取得插件代码可修改、可商用的明确许可证依据；随后通过真实本地公开端点完成 RW-02 十包验收和 RW-03 故障注入。
3. 在最终候选 SHA 上执行 RW-05、RW-06。

## 8. RW-01 已关闭项

### SEC-01：可信代理证明与持久防重放

状态：`ACCEPTED`

证据：

- `trusted-proxy-auth.ts` 的 v2 证明绑定 issuer、key-id、user、timestamp、nonce、scheme、authority、method、path/query 和实际请求体 SHA-256。
- 0063 迁移创建以 `(issuer, key_id, nonce)` 为主键的持久 nonce 表和过期索引；预留使用数据库事务，唯一冲突按 replay 失败。
- 两个真实 Node 进程同时提交同一证明时恰好一个成功；scheme、authority、method、path、query 顺序/编码和 body 变异全部使签名失效。
- 专项 4 文件 34 测试通过；迁移空库与四类旧基线升级通过；全量静态门禁 57 文件 743 测试及 21 个 runtime 测试通过。

### SEC-02：工作流输入在入队前规范化

状态：`ACCEPTED`

证据：

- `request-validation.ts` 从 compiled bindings 生成唯一类型化快照，覆盖未知/非 request 键、禁止覆盖、必填、类型、有限数值、范围、step、深度、集合、字符串和总字节上限。
- 规范化发生在幂等摘要和 job 写入之前；执行快照标记 `requestDigestVersion: 2`，旧 caller-input 摘要保留双读。
- 真实 SQLite 集成测试证明非法请求产生零 job、零 attempt、零 slot；API 测试证明稳定 `400/413` 和错误码。
- 专项 5 文件 31 测试、生产构建和全量静态门禁通过；全量为 60 文件 765 测试及 21 个 runtime 测试。

### SEC-03：输入快照与单一已验证句柄

状态：`ACCEPTED`

证据：

- 0064 创建 `job_input_artifacts`，固化来源种类、ID、角色、storage key、SHA-256、大小与 MIME；插入触发器在 job 事务中复核项目、状态和描述符。
- 已链接的 source/generation artifact 不能改变状态或内容描述符；第二数据库连接的删除尝试失败。
- 文件物化只打开源文件一次，流式散列精确读取字节，并复核初始/最终 handle 及最终路径的 device、inode、size、mtime 身份；同长度路径替换及描述符不匹配均失败。
- 65 个迁移在空库和四类旧基线通过；专项 5 文件 75 测试及全量 61 文件 769 测试通过。

### SEC-04：源工件配额预留

状态：`ACCEPTED`

证据：

- 0065 创建项目级 quota reservation；`BEGIN IMMEDIATE` 原子计算 STAGING/COMMITTED 资产与未过期 RESERVED 字节。
- 上传在创建 staging 文件前完成预留，长写期间按 owner token 续租，资产插入与 reservation `COMMITTED` 在同一事务完成。
- 两个真实 Node 进程争抢 100 字节配额、各申请 60 字节时恰好一个成功；精确 100 字节边界成功，超一字节失败。
- 客户端中断与 ffprobe 失败均留下 `RELEASED` reservation、零资产和零 staging 文件；过期崩溃 reservation 会被下一次原子预留回收。
- 66 个迁移、专项 4 文件 67 测试以及此前全量静态门禁通过。

### SEC-05：语音配置并发幂等

状态：`ACCEPTED`

证据：

- 0066 为 voice profile 增加 `(project_id, user_id, idempotency_key)` 部分唯一索引与语义摘要。
- 摘要覆盖规范化名称、provider、引用身份、reference text、language、speed、pitch 和 consent version。
- 两个真实 Node 服务进程并发提交同一请求时返回同一 profile ID，数据库仅一行；SQLite busy snapshot loser 会等待并读取 winner。
- 同 key 改变任一语义字段稳定返回 `409/idempotency_key_conflict`；不同项目/用户使用同 key 相互隔离。
- API 强制新写入提供 bounded body/header key；专项 4 文件 67 测试及全量 65 文件 781 测试通过。

### SEC-06：中央 mutation origin/CSRF 边界

状态：`ACCEPTED`

证据：

- `proxy.ts` 在所有 `/api/**` 请求进入 route handler 前调用 `assertMutationRequest`；GET 等非 mutation 原样放行。
- Cookie 请求始终归类为浏览器边界，必须提供规范同源 Origin/Referer，生产配置必须是 HTTPS，`Sec-Fetch-Site: cross-site` fail closed；bearer 不能借 Cookie 降级。
- 无 Cookie 的管理员服务调用只有在携带并通过强 admin credential 时才归类为服务；无 credential 的同源管理员页面请求仍走浏览器边界。
- trusted-proxy 服务请求仅在显式 trusted-proxy mode 且完整证明头存在时通过分类，完整签名和 durable nonce 仍由身份边界验证，避免重复消费 nonce。
- 静态覆盖测试递归枚举 53 个 mutating handlers，并断言 Proxy matcher 覆盖 API 且调用中央 guard。
- 专项 4 文件 18 测试、Next.js 生产构建和完整静态门禁通过；最终全量为 67 个测试文件、789 个测试、21 个 runtime 测试和 67 个迁移，ESLint 0 errors。

### SEC-07：规范 JSON与原始字节摘要分离

状态：`ACCEPTED`

证据：

- `canonical.ts` 只导出 `sha256Canonical` 和 `sha256Bytes`。
- 黄金测试覆盖 UTF-16 属性排序、RFC/ECMAScript 数值、负零、转义、NaN/Infinity、undefined、function、symbol、循环、稀疏数组和 lone surrogate。
- manifest parser 不再构造带 undefined 的 selector 字段。
- workflow、job idempotency、Pixelle prepare/verify 相关 118 个测试通过。
- `rg '\bsha256\(' src scripts` 无结果。
- TypeScript typecheck 通过。
- 完整 `quality:static` 通过：55 个测试文件、731 个测试、21 个 runtime 测试、63 个空库迁移，以及 PR-12/PR-13 静态门禁全部通过；ESLint 0 errors。
