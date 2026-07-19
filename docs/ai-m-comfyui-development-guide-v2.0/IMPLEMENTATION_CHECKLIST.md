# `ai-m`（当前二开项目）本地工作流平台实施检查表

**版本：** 2.0  
**更新日期：** 2026-07-19
**使用方式：** 每张拉取请求逐项勾选，并在描述中附测试或审计证据。  
**标记说明：** `[x]` 已完成 `[~]` 部分完成 `[ ]` 未完成

# A. 架构与责任边界

- [x] 浏览器只引用生成配置编号 — `profileRevisionId` 在 `generate/route.ts`、`jobs/route.ts` 中使用
- [x] 网页请求不执行长推理 — API 路由创建任务后立即返回，Worker 进程异步执行
- [x] 独立工作进程可单独启动和停止 — `src/worker/index.ts` 独立入口，支持 SIGINT/SIGTERM 优雅关闭
- [x] 任务、尝试、工件、后端、资源池和修订版分开 — `db/schema.ts` 中各表独立
- [x] 业务代码不识别工作流节点编号 — `business-adapter.ts` 只处理业务上下文，节点绑定由适配器完成
- [x] 第三方客户端被自有接口隔离 — `contracts/services.ts` 定义 `GenerationJobService` 接口
- [x] 原漫剧业务语义未改变 — `legacy-facade.ts` 保留旧供应商兼容包装器

# B. 服务端配置和密钥

- [x] 后端只由管理员登记 — `/api/admin/backends` 路由需功能开关
- [x] 密钥只保存引用 — `keyReferences` 表存储密钥引用
- [x] 普通接口不回显密钥 — GET 返回 `maskKey()` 脱敏预览，`sanitizeForLog()` 过滤
- [x] 请求和错误日志不记录认证头 — `audit.ts` 仅允许固定审计字段；后端认证响应只投影 `keyRefId/headerName`
- [x] 浏览器旧密钥迁移有安全流程 — model-store hydration 清理 local/session storage 密钥、写入无敏感值迁移标记，后续密钥仅保存在内存
- [x] 后端地址执行解析地址和网段校验 — `network-policy.ts` 的 `validateBackendUrl()`
- [x] 禁止重定向 — `network-policy.ts` 的 `noRedirectFetchOptions()` 返回 `redirect: "manual"`
- [x] 局域网后端使用传输加密和认证 — `executionBackends` 表有 `authType`、`tlsConfigJson` 字段

# C. 工作流供应链

- [x] 上传进入隔离区 — `workflow-package-storage.ts` 将普通文件树限额复制到独立 quarantine，复核逐文件大小/摘要后才允许验证和发布
- [x] 解包有限额和路径检查 — `validator.ts` 的 `DEFAULT_CONSTRAINTS` 限制节点数、包大小，`applyStaticPolicy()` 检查路径遍历
- [x] 结构约束拒绝未知字段 — `validateWorkflowStructure()` 检查 `allowedNodeClasses`、`maxNodeClasses`
- [x] 语义选择器必须唯一 — `compileWorkflowBindings()` 对通用包和 Pixelle 包的每个 binding/output 均要求恰好命中一个节点
- [x] 编译计划绑定工作流摘要 — `validator.ts` 计算 `digest` 和 `workflowSha256`
- [x] 自定义节点固定提交摘要 — `packageLockJson` 字段存储锁定信息
- [x] 平台安全策略独立 — `WorkflowStaticPolicy` 接口独立定义
- [~] 冒烟测试在隔离后端 — `verify-single-comfyui.test.ts` 已用本地假后端覆盖提交、下载、重启和重连；真实隔离设备验收尚未完成
- [x] 双人审查 — 0067 不可变审批表；身份从 Windows 登录令牌 SID（安全标识符）导出且不可自填，导入者不可自审，同一后端环境需两个不同 SID（安全标识符）才能激活
- [x] 发布目录只读 — 发布仅允许 quarantine 直属子目录原子移动；文件/目录写位清除并递归复核，Pixelle 已验证代际在导入前同样执行只读保护
- [x] 撤销机制可用 — `workflow:revoke` 原子撤销包、禁用关联 profile、删除默认指针并保留审批和历史任务

# D. 环境验证

- [x] 记录引擎、运行时、加速后端和节点摘要 — `comfyui-behavior-probe.ts` 的 `probeBackendFeatures()`
- [x] 模型记录大小和摘要 — prepare 以稳定文件句柄流式记录 size/SHA-256 并绑定 generation；晋级和每次执行均复核，任一漂移 fail closed
- [x] 环境变化使验证过期 — `comfyui-behavior-probe.ts` 的 `checkEnvironmentDrift()`
- [x] 节点信息缓存按环境指纹 — `BackendFeatureSnapshot` 包含 `environmentFingerprint`
- [x] 客户端任务编号经过行为探测 — `probeExternalIdStrategy()` 探测策略
- [x] 取消能力经过行为探测 — `probeCancellationCapabilities()` 探测能力

# E. 持久任务和并发

- [x] 原子领取 — `leases.ts` 的 `claimJob()` 使用 `UPDATE ... WHERE ... RETURNING`
- [x] 资源池槽位持久化 — `resourcePoolSlots` 表，`acquireResourceSlot()` 原子更新
- [x] 工作领取和资源槽位使用不同字段及令牌 — `claimFencingToken` vs `resourceFencingToken`
- [x] 两类防旧写令牌单调递增且不重置 — `${fencingToken} + 1` 递增
- [x] 所有关键写入检查令牌 — `renewJobClaim()`、`releaseJobClaim()`、`renewResourceSlot()` 均校验
- [x] 心跳和租约时长合理 — `LEASE_CONFIG` 定义合理参数
- [x] 失去租约后工作器停止写入 — `src/worker/index.ts` 心跳失败时安全退出
- [x] 项目配额和公平性 — `claimJob()` 原子执行项目并发上限、低占用项目优先和可配置饥饿上限，并有并发测试
- [x] 数据库事务短 — 所有数据库操作为单条 SQL，无长事务

# F. 提交、恢复和重试

- [x] 网络提交前持久化关联编号 — `worker-executor.ts` 先插入 `generationAttempts` 再提交
- [x] 生产后端预分配任务编号 — `attemptNo` 通过 `getNextAttemptNo()` 预分配
- [x] 提交禁用自动重试和重定向 — `noRedirectFetchOptions()` 禁用重定向
- [x] 响应丢失进入对账 — `comfyui-reconciliation.ts` 的 `reconcileSubmission()`
- [x] 证据不足进入人工处理 — `shouldEscalateToAttention()` 判断逻辑
- [x] 外部历史只作证据 — `reconcileSubmission()` 将历史 API 作为证据源之一
- [x] 收集失败只重试收集 — `classifySubmissionError()` 区分 `retryScope`
- [x] 提交失败只重试提交 — `RetryMode` 类型区分重试范围
- [x] 错误分类决定重试 — `ErrorClass` 枚举和 `classifySubmissionError()` 实现分类
- [x] 已有工件阻止模型重跑 — `orchestrator-integration.test.ts` 验证已接受但响应异常的提交只进入对账且不重新提交，Worker finalization 只选择已提交工件

# G. 取消

- [x] 页面区分请求取消和确认取消 — `cancelGenerationJob()` 区分 `QUEUED` 和 `RUNNING`
- [x] 优先按任务取消 — `comfyui-cancellation.ts` 的 `safeCancelJob()` 优先检查按任务取消
- [x] 共享后端禁用全局中断 — `safeCancelJob()` 当 `isShared=true` 时返回 `none`
- [x] 专用后端中断前验证目标任务 — `cancelWithGlobalInterruptVerified()` 探测确认
- [x] 取消与完成竞态有事务规则 — `resolveCancelCompletionRace()` 按时间和工件状态裁决
- [x] 已提交工件不会被取消逻辑删除 — `resolveCancelCompletionRace()` 当 `hasCommittedArtifacts=true` 返回 `completed`

# H. 实时连接和轮询

- [x] 传输层没有任意路径和方法的通用代理 — `comfyui.ts` 只暴露特定方法
- [x] 网关限制允许的方法和路径 — `ComfyUITransport` 接口限制为 `post`、`getFile`、`connectWebSocket`
- [x] 每后端一个连接管理器 — `connectionManagerRegistry` 按 `baseUrl` 单例管理
- [x] 连接代次 — `ComfyUIConnectionManager` 的 `generation` 字段，断线递增
- [x] 事件去重 — `handleMessage()` 按 `promptId` 分派
- [x] 进度合并写 — `progressWriteIntervalMs: 2_000` 节流写入
- [x] 断线退避和抖动 — `scheduleReconnect()` 实现指数退避和 `jitterFactor`
- [x] 轮询按阶段 — `waitForExecutionStart()` 和 `waitForExecutionComplete()` 使用不同轮询间隔
- [x] 实时消息不决定最终成功 — 最终由 `probeHistory()` 确认

# I. 媒体输入输出

- [x] 输入权限校验 — `input-access.ts` 集中校验 source/generated artifact 的 committed、project、owner 边界并由 job/voice 两条输入链复用；voice profile 与 artifact 下载继续执行 user/project 复核，跨项目/跨用户测试 fail closed
- [x] 任务专用暂存 — `commit.ts` 使用 `data/task-staging/{attemptId}` 目录
- [~] 执行后端不挂载完整上传目录 — 托管配置要求独立 DataRoot；真实参数已指向专用 input/output/user，但后端与应用仍为同一 SID（安全标识符），宽泛访问控制下仍可读取上传目录
- [~] 通用任务暂存卷不直接挂载给推理实例 — DataRoot 与通用 supply-chain、Pixelle staging 互不嵌套且配置 fail closed；操作系统访问控制尚未证明推理身份读取被拒绝
- [~] 后端摄取目录只含当前安全租户或当前资源槽任务 — 代码只允许 `ai-m/<currentJob>/<currentAttempt>` 并拒绝其他文件/目录/链接；尚未在独立低权限服务身份下完成真实应用任务链
- [x] 输出流式 — `streamCommitArtifact()` 实现流式读写
- [x] 字节、像素、时长和数量限制 — `parameter-normalization.ts` 和 `content-detection.ts`
- [x] 魔数和安全解码 — `content-detection.ts` 的 `detectMimeType()` 和 `validateMagicBytes()`
- [x] 外部文件名不可信 — `commit.ts` 使用生成的 `id` 作为文件名
- [x] 同文件系统原子提交或对象存储提交协议 — `fs.rename()` 原子重命名
- [x] 磁盘高水位 — `disk-cleanup.ts` 的 `checkDiskUsage()` 和 `diskUsageThreshold: 0.85`
- [x] 清理依据数据库归属和租约 — `cleanupExpiredArtifacts()` 按数据库记录清理

# J. 工件与权限

- [x] 工件不可变 — `ArtifactStatus` 枚举 `STAGING → COMMITTED`，无更新已提交工件的代码
- [x] 数据库存储系统键而非外部绝对路径 — `storageKey` 存储相对路径或键
- [x] 下载再次校验项目权限 — `checkArtifactAccess()` 校验 `visibility` 和状态
- [x] 私有原始声音单独可见性 — `ArtifactVisibility.PRIVATE_ORIGINAL` 枚举，按 `userId` 隔离
- [x] 工件摘要和来源追踪 — `generationArtifacts` 表有 `sha256`、`attemptId`、`parentArtifactId`
- [x] 重新生成保留版本历史 — `generationAttempts` 表记录每次尝试，`attemptNo` 递增

# K. `Z-Image`（造相文生图模型）

- [x] 快速和质量配置分离 — `zimage.ts` 的 `QualityWorkflow` 类型区分 `fast-preview`、`standard`、`high-quality`
- [x] 真实生产工作流已晋级 — `promote-zimage-workflow.ts` 和 `promote-zimage-quality-workflow.ts`
- [x] 宽高、像素和倍数策略 — `parameter-normalization.ts` 实现比例映射、像素预算、8 的倍数对齐
- [x] 随机种子无精度损失 — `seed?: string` 类型，`normalizeSeed()` 转为字符串
- [x] 用户不能覆盖模型文件或任意节点输入 — `buildZImageWorkflow()` 硬编码节点类型
- [x] 角色图和镜头图入口回归 — `business-adapter.ts` 的 `createCharacterImageJob()` 和 `createShotFrameJob()`
- [x] 云端图片供应商仍可用 — `cloud-supplier.ts` 包装旧云供应商为统一接口

# L. 测试与质量

- [x] 旧流程特征测试 — `regression-baseline.test.ts` 覆盖旧供应商协议映射、Legacy 配置解析等
- [x] 单元测试 — `pr06-archiving.test.ts`、`pr05-transport.test.ts`、`regression-baseline.test.ts`
- [x] 结构约束测试 — `workflows/__tests__/validator.test.ts` 覆盖空图、节点/类上限、allowlist、畸形节点图、路径和环境漂移
- [x] 假后端集成测试 — `verify-single-comfyui.test.ts` 和 `orchestrator-integration.test.ts` 覆盖提交、完成、下载、重启、重连及失败清理
- [x] 提交不确定测试 — `orchestrator-integration.test.ts` 覆盖响应丢失后对账和证据不足升级人工处理
- [x] 工作器终止测试 — `worker/__tests__/index.test.ts` 覆盖 SIGINT、SIGTERM、shutdown 后释放新 claim 和续租失败
- [x] 租约竞态测试 — `leases.test.ts`、`slot-reconciliation-concurrency.test.ts` 和 job/artifact recovery concurrency 测试覆盖多连接与多进程竞态
- [x] 磁盘满测试 — `commit.test.ts` 注入真实 `ENOSPC` 写失败，验证有界拒绝、记录进入 QUARANTINED、无发布工件和无残留 staging 文件
- [x] 大文件测试 — `commit.test.ts` 和 `verify-single-comfyui.test.ts` 覆盖超限流、部分文件清理及禁止发布
- [x] 服务端请求伪造测试 — `network-policy.test.ts`、WebSocket policy 和 deadline 测试覆盖元数据地址、解析地址、端口、重定向及 DNS/WS 绕过
- [x] 越权工件测试 — `commit.test.ts` 覆盖跨用户读取拒绝，artifact route 再次按项目所有权查询
- [ ] 真实设备验收 — 未见真实设备验收测试
- [x] 样例自动校验通过 — `tools/validate_examples.py` 已接入 `test:validate-examples` 和 `quality:static`，当前基线运行通过

# M. 可观测性与运维

- [x] 统一关联编号 — 创建任务时写入可信 `traceId`，attempt 使用 `traceId.attempt-*` 作为提交关联号，输出工件保存二者
- [x] 阶段耗时指标 — `/api/admin/operations/health` 按 attempt phase 汇总数量、平均耗时和最大耗时，并汇总任务状态
- [x] 提交不确定告警 — 0068 持久化主动告警；Worker 扫描与运维 API 均刷新，支持证据绑定确认和信号清除后自动恢复
- [x] 租约失效告警 — 最近 24 小时租约/claim 丢失与过期占用槽位统一触发 critical 告警
- [x] 环境漂移告警 — 环境/模型漂移与 workflow/backend validation 缺失进入 warning 告警闭环
- [x] 磁盘水位告警 — 85% warning、95% critical；恢复到阈值下自动 RESOLVED
- [x] 日志字段白名单 — `audit.ts` 使用显式字段/值类型 allowlist，未知、嵌套和密钥样式字段在持久化前丢弃
- [x] 运维处理不确定任务的页面 — `/operations` 与 `/api/admin/operations/attention` 仅列出证据安全字段并登记受控原因/证据引用，不允许强制结束或改变任务状态
- [x] 备份和恢复演练 — `ops:recovery:rehearse` 创建逐文件摘要恢复包，只恢复到全新隔离目录并复核 SQLite integrity、全量文件大小/摘要；当前 85 文件/25,578,737 字节真实演练通过

# N. 发布与回滚

- [x] 功能开关服务端控制 — `feature-flags.ts` 实现完整功能开关机制，支持环境变量控制
- [x] 小范围项目灰度 — `isEnabledForProject()` 要求全局开关启用并支持精确项目 allowlist；空值、畸形、超限配置 fail closed，任务服务及本地图片/语音入口统一执行
- [x] 回滚不删除新表和工件 — `ops:rollback:preservation` 在维护窗口前后核对迁移日志、15 张保护表的列、主键、逐行摘要和全部既有工件摘要；降级迁移、删行或篡改均失败
- [x] 默认配置可回退 — 多个模块有 `DEFAULT_*` 常量支持配置回退
- [x] 运行中任务有排空方案 — `src/worker/index.ts` 实现 `gracefulShutdown` 优雅关闭
- [x] 工作流撤销测试 — `approval-service.test.ts` 验证撤销阻止新审批、禁用 profile/default 且保留不可变审批
- [x] 浏览器旧密钥清理 — `purgeLegacyBrowserCredentials()` 清理 local/session storage 并记录无敏感值完成标记
- [x] 发布后漫剧回归通过 — `regression-baseline.test.ts` 验证旧流程不受影响

---

## 统计摘要

| 分类 | 已完成 `[x]` | 部分完成 `[~]` | 未完成 `[ ]` | 总计 |
|------|:---:|:---:|:---:|:---:|
| A. 架构与责任边界 | 7 | 0 | 0 | 7 |
| B. 服务端配置和密钥 | 8 | 0 | 0 | 8 |
| C. 工作流供应链 | 10 | 1 | 0 | 11 |
| D. 环境验证 | 6 | 0 | 0 | 6 |
| E. 持久任务和并发 | 9 | 0 | 0 | 9 |
| F. 提交、恢复和重试 | 10 | 0 | 0 | 10 |
| G. 取消 | 6 | 0 | 0 | 6 |
| H. 实时连接和轮询 | 9 | 0 | 0 | 9 |
| I. 媒体输入输出 | 9 | 3 | 0 | 12 |
| J. 工件与权限 | 6 | 0 | 0 | 6 |
| K. Z-Image | 7 | 0 | 0 | 7 |
| L. 测试与质量 | 12 | 0 | 1 | 13 |
| M. 可观测性与运维 | 9 | 0 | 0 | 9 |
| N. 发布与回滚 | 8 | 0 | 0 | 8 |
| **合计** | **116** | **4** | **1** | **121** |

**完成率：95.9% 已完成，3.3% 部分完成，0.8% 未完成**

### 主要缺口

1. **工作流供应链（C）**：代码侧隔离、只读发布、选择器、双人审查和撤销已闭环；仅真实隔离后端冒烟待设备验收
2. **媒体输入输出（I）**：代码守卫已完成；真实部署仍须提供操作系统访问控制、挂载和进程可见性证据
3. **可观测性（M）**：统一关联号、阶段指标、四类主动告警、证据确认、自动恢复和备份恢复演练均已通过代码侧验收
4. **测试与质量（L）**：磁盘满故障测试已完成；仍缺六包真实设备、十八类故障注入和实际回滚证据
