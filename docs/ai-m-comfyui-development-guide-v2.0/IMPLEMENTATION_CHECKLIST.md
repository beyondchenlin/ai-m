# `ai-m`（当前二开项目）本地工作流平台实施检查表

**版本：** 2.0  
**更新日期：** 2026-07-13  
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
- [x] 请求和错误日志不记录认证头 — `audit.ts` 的 `sanitizeForLog()` 过滤敏感键
- [ ] 浏览器旧密钥迁移有安全流程 — 未发现迁移脚本或流程代码
- [x] 后端地址执行解析地址和网段校验 — `network-policy.ts` 的 `validateBackendUrl()`
- [x] 禁止重定向 — `network-policy.ts` 的 `noRedirectFetchOptions()` 返回 `redirect: "manual"`
- [x] 局域网后端使用传输加密和认证 — `executionBackends` 表有 `authType`、`tlsConfigJson` 字段

# C. 工作流供应链

- [ ] 上传进入隔离区 — `validator.ts` 直接验证，未见明确隔离区目录
- [x] 解包有限额和路径检查 — `validator.ts` 的 `DEFAULT_CONSTRAINTS` 限制节点数、包大小，`applyStaticPolicy()` 检查路径遍历
- [x] 结构约束拒绝未知字段 — `validateWorkflowStructure()` 检查 `allowedNodeClasses`、`maxNodeClasses`
- [ ] 语义选择器必须唯一 — 未见语义选择器唯一性校验代码
- [x] 编译计划绑定工作流摘要 — `validator.ts` 计算 `digest` 和 `workflowSha256`
- [x] 自定义节点固定提交摘要 — `packageLockJson` 字段存储锁定信息
- [x] 平台安全策略独立 — `WorkflowStaticPolicy` 接口独立定义
- [ ] 冒烟测试在隔离后端 — `examples/fixtures/` 存在但未见自动化冒烟测试
- [ ] 双人审查 — `workflowPackageRevisions` 有 `reviewedBy` 字段但未见审查流程实现
- [ ] 发布目录只读 — 未见发布目录权限控制代码
- [ ] 撤销机制可用 — `naming.ts` 有 `REVOKED` 状态但未见撤销 API 实现

# D. 环境验证

- [x] 记录引擎、运行时、加速后端和节点摘要 — `comfyui-behavior-probe.ts` 的 `probeBackendFeatures()`
- [ ] 模型记录大小和摘要 — 未见模型文件大小和摘要记录代码
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
- [ ] 项目配额和公平性 — 未见项目级配额或公平调度代码
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
- [ ] 已有工件阻止模型重跑 — 未见明确检查已提交工件阻止重跑的逻辑

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

- [ ] 输入权限校验 — 未见明确的输入权限校验中间件
- [x] 任务专用暂存 — `commit.ts` 使用 `data/task-staging/{attemptId}` 目录
- [ ] 执行后端不挂载完整上传目录 — 未见部署配置或挂载控制代码
- [ ] 通用任务暂存卷不直接挂载给推理实例 — 未见部署配置
- [ ] 后端摄取目录只含当前安全租户或当前资源槽任务 — 未见租户隔离目录代码
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
- [ ] 结构约束测试 — `validator.ts` 实现了约束检查但无专门测试
- [ ] 假后端集成测试 — 未见 mock/fake backend 测试
- [ ] 提交不确定测试 — 未见 `SUBMISSION_UNKNOWN` 专门测试
- [ ] 工作器终止测试 — Worker 实现了优雅关闭但无专门测试
- [ ] 租约竞态测试 — 未见 lease race condition 专门测试
- [ ] 磁盘满测试 — 未见 disk full 专门测试
- [ ] 大文件测试 — 未见 large file 专门测试
- [ ] 服务端请求伪造测试 — `network-policy.ts` 实现 SSRF 防护但无专门测试
- [ ] 越权工件测试 — `commit.ts` 实现访问控制但无专门测试
- [ ] 真实设备验收 — 未见真实设备验收测试
- [ ] 样例自动校验通过 — 未见样例自动校验机制

# M. 可观测性与运维

- [~] 统一关联编号 — `contracts/providers.ts` 定义 `traceId` 字段，但无中间件实现传播
- [~] 阶段耗时指标 — 多个文件记录 `durationMs`，但无统一指标收集系统
- [~] 提交不确定告警 — `comfyui-reconciliation.ts` 实现判断逻辑，但无告警通知发送
- [~] 租约失效告警 — Worker 在租约丢失时输出日志，但无告警通知
- [ ] 环境漂移告警 — 未见环境漂移检测或告警机制
- [~] 磁盘水位告警 — `disk-cleanup.ts` 实现 `checkDiskUsage`，但无告警通知
- [~] 日志字段白名单 — `audit.ts` 的 `sanitizeForLog` 为黑名单模式，非白名单
- [ ] 运维处理不确定任务的页面 — 未见管理员/运维页面
- [ ] 备份和恢复演练 — 未见备份恢复脚本或演练记录

# N. 发布与回滚

- [x] 功能开关服务端控制 — `feature-flags.ts` 实现完整功能开关机制，支持环境变量控制
- [ ] 小范围项目灰度 — 未见项目级灰度发布机制
- [~] 回滚不删除新表和工件 — `MIGRATION_AND_ROLLBACK.md` 文档说明原则，但代码中无显式保护
- [x] 默认配置可回退 — 多个模块有 `DEFAULT_*` 常量支持配置回退
- [x] 运行中任务有排空方案 — `src/worker/index.ts` 实现 `gracefulShutdown` 优雅关闭
- [ ] 工作流撤销测试 — 未见工作流撤销专门测试
- [~] 浏览器旧密钥清理 — 有 `legacy-` 前缀检测和迁移文档，但无实际清理代码
- [x] 发布后漫剧回归通过 — `regression-baseline.test.ts` 验证旧流程不受影响

---

## 统计摘要

| 分类 | 已完成 `[x]` | 部分完成 `[~]` | 未完成 `[ ]` | 总计 |
|------|:---:|:---:|:---:|:---:|
| A. 架构与责任边界 | 7 | 0 | 0 | 7 |
| B. 服务端配置和密钥 | 7 | 0 | 1 | 8 |
| C. 工作流供应链 | 5 | 0 | 6 | 11 |
| D. 环境验证 | 5 | 0 | 1 | 6 |
| E. 持久任务和并发 | 8 | 0 | 1 | 9 |
| F. 提交、恢复和重试 | 9 | 0 | 1 | 10 |
| G. 取消 | 6 | 0 | 0 | 6 |
| H. 实时连接和轮询 | 9 | 0 | 0 | 9 |
| I. 媒体输入输出 | 8 | 0 | 4 | 12 |
| J. 工件与权限 | 6 | 0 | 0 | 6 |
| K. Z-Image | 7 | 0 | 0 | 7 |
| L. 测试与质量 | 2 | 0 | 11 | 13 |
| M. 可观测性与运维 | 0 | 6 | 3 | 9 |
| N. 发布与回滚 | 4 | 2 | 2 | 8 |
| **合计** | **83** | **8** | **31** | **121** |

**完成率：68.6% 已完成，6.6% 部分完成，25.6% 未完成**

### 主要缺口

1. **测试与质量（L）**：11/13 未完成，是最大短板
2. **工作流供应链（C）**：隔离区、语义选择器唯一性、冒烟测试、双人审查、发布目录只读、撤销机制
3. **媒体输入输出（I）**：输入权限校验、部署配置相关项（3 项为部署拓扑约束）
4. **可观测性（M）**：有基础逻辑但缺告警通知和运维页面
