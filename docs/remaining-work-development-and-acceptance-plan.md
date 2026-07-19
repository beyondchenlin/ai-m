# `ai-m` 剩余工作开发与验收计划

状态：`ACTIVE`  
基线：`dev` / `04d1ace`（2026-07-17）  
建立日期：2026-07-19  
适用版本：`0.2.3` 之后的首个可发布版本

## 1. 目的与文档权威

本文是当前剩余工作的唯一总入口，用于解决旧计划分散、勾选状态滞后、真实设备证据格式不统一，以及最终发布缺少明确 Go/No-Go 标准的问题。

执行时按以下优先级解释文档：

1. 本文定义剩余范围、完成定义、证据要求和发布判定。
2. [单端口 ComfyUI 验收计划](superpowers/plans/2026-07-15-single-endpoint-comfyui-acceptance.md)提供 Task 1～5 的实现背景。
3. [运维安全加固计划](superpowers/plans/2026-07-14-operations-security-hardening.md)提供安全任务的竞态、兼容与回滚细节。
4. [Pixelle 单端口操作说明](comfyui-single-endpoint/README.md)提供命令和安全操作约束。
5. [实施检查表](ai-m-comfyui-development-guide-v2.0/IMPLEMENTATION_CHECKLIST.md)用于逐项审计，不单独作为发布完成证明。
6. [语音依赖开源复用评估](reviews/2026-07-19-speech-dependency-open-source-assessment.md)记录 IndexTTS2 与 OmniVoice 的上游、许可证、依赖冲突、方案取舍和架构变更验收标准。
7. [第二轮独立对抗审查记录](reviews/2026-07-19-second-round-adversarial-review.md)记录本轮已关闭问题、仍未关闭阻塞和最终候选门禁。

旧文档中的 `[x]` 或 `[ ]` 只表示编写者记录的进度。没有本文要求的可复核证据，不能据此判定完成。

## 2. 当前基线和剩余范围

### 2.1 已合入、需要回归保护的能力

- Job、attempt、资源槽和工件恢复的事务边界与 fencing。
- 工件 writer/recovery lease、媒体结构完整性检查。
- ComfyUI HTTP/WebSocket 端点策略与绝对操作超时。
- 单端口托管运行时、任务结算后重启和重新探测。
- Pixelle 六个候选工作流包的不可变代际、摘要、信任根、审计链和安全 GC。
- `workflow:verify:pixelle-single` 验证工具及假后端测试。

这些能力不得因为剩余工作而降级。相关回归失败一律为发布阻断。

### 2.2 剩余工作包

| ID | 优先级 | 工作包 | 当前状态 | 发布要求 |
| --- | --- | --- | --- | --- |
| RW-00 | P0 | 对齐代码、计划和检查表状态 | 已完成；见[状态矩阵](remaining-work-status-matrix.md) | 必须完成 |
| RW-01 | P0 | 完成尚未关闭的安全边界任务 | 已完成；SEC-01～SEC-07 均已验收 | 必须完成 |
| RW-02 | P0 | 十个真实 Pixelle/ComfyUI 工作流验收 | 未完成 | 必须完成 |
| RW-03 | P0 | 故障、取消、恢复和不确定状态验收 | 未完成 | 必须完成 |
| RW-04 | P1 | 供应链、权限、部署隔离和运维缺口 | 部分完成；代码与自动化通过，但操作系统身份隔离、第三方许可证和 Windows 目录提交耐久性未验收 | 必须完成或书面批准延期 |
| RW-05 | P0 | 全量质量门禁与双轮独立审查 | 未完成 | 必须完成 |
| RW-06 | P0 | 发布、稳定服务验证和回滚演练 | 未完成 | 必须完成 |

“书面批准延期”必须记录负责人、风险、补偿控制、截止日期和跟踪事项。P0、安全认证、租约 fencing、重复推理、工件越权、真实工作流或回滚恢复项目不得延期。

## 3. 全局完成定义

每个工作包只有同时满足以下条件才能标记完成：

1. 范围内代码、迁移、配置示例和操作文档已更新。
2. 先有能复现缺陷或边界的 RED 测试，再有 GREEN 结果；纯文档或环境验收项除外。
3. 正向、反向、超时、并发、重启和清理路径均有覆盖。
4. 所有验收命令退出码为 `0`，且结果中没有被忽略的失败、未处理 Promise rejection 或孤儿进程。
5. 证据包含命令、UTC/带时区时间、Git SHA、环境摘要、退出码和脱敏日志位置。
6. 不记录密钥、令牌、`.env` 内容、私人音频内容、机器用户目录或无关数据库内容。
7. 新迁移为前向兼容；紧急回滚不得删除新表、证明、工件或幂等数据。
8. `git diff --check` 通过，`git status --short` 中只有明确属于当前任务的文件。
9. 规格审查和代码质量审查均无未关闭 P0～P3 问题。
10. 文档状态、实施检查表和实际代码一致。

允许使用以下状态：

- `NOT_STARTED`
- `IN_PROGRESS`
- `BLOCKED`
- `READY_FOR_REVIEW`
- `ACCEPTED`
- `DEFERRED_WITH_RISK`

`ACCEPTED` 必须附证据路径；`BLOCKED` 必须写明阻塞条件；不得使用“基本完成”“应该可用”等模糊状态。

## 4. RW-00：状态与范围对齐

### 开发工作

1. 逐项核对两个旧计划的任务与当前 `dev` 实现。
2. 将“代码已实现但真实环境未验收”和“尚未实现”分开记录。
3. 更新实施检查表中的失效判断，例如已经存在的假后端、租约竞态、SSRF 和样例校验测试。
4. 给每个未完成项分配负责人、目标版本、依赖和证据位置。
5. 不修改历史提交事实；状态更正必须附代码、测试或运行证据。

### 验收标准

- AC-00-01：旧计划中的每一个 open task 都能映射到本文某个 RW ID，或有带理由的 `NOT_APPLICABLE` 记录。
- AC-00-02：实施检查表的统计由实际标记重新计算，表格合计与逐行结果一致。
- AC-00-03：每个“已完成”项至少有一个代码路径和一个测试/运行证据。
- AC-00-04：不存在同一任务在两份现行文档中状态冲突的情况。
- AC-00-05：README、开发资料包入口和单端口说明均链接到本文。

## 5. RW-01：剩余安全边界

详细竞态安排和兼容策略沿用[运维安全加固计划](superpowers/plans/2026-07-14-operations-security-hardening.md)。以下验收项是发布最小标准。

### SEC-01：可信代理证明与持久防重放

状态：`ACCEPTED`（2026-07-19）。证据见[状态矩阵](remaining-work-status-matrix.md#sec-01可信代理证明与持久防重放)。

- 两个独立 Node 进程对同一数据库提交相同 issuer/key-id/nonce，只允许一个成功。
- method、scheme、authority、path、query 和 body 任一语义变化都会使原签名失效。
- 解码后不足 32 随机字节或低熵的密钥被拒绝。
- nonce 原子预留、过期清理和迁移测试通过；日志不包含签名或密钥值。

必须通过：

```powershell
corepack pnpm vitest run src/lib/security/__tests__/trusted-proxy-auth.test.ts src/lib/security/__tests__/trusted-proxy-replay-process.test.ts src/lib/security/__tests__/user-identity.test.ts
python tools/test_migrations.py
```

### SEC-02：工作流输入在入队前规范化

状态：`ACCEPTED`（2026-07-19）。证据见[状态矩阵](remaining-work-status-matrix.md#sec-02工作流输入在入队前规范化)。

- 缺失、未知、重复、越界、错误类型、非有限数值和不安全路径在创建 job/attempt/slot 前失败。
- 规范化后的绑定值同时决定请求摘要和实际提交值。
- 非法请求不会访问 ComfyUI，不会写入任何生成状态。
- 合法旧请求保持兼容；若摘要变化，必须提供显式版本与双读策略。

### SEC-03：输入工件快照与单一已验证句柄

状态：`ACCEPTED`（2026-07-19）。证据见[状态矩阵](remaining-work-status-matrix.md#sec-03输入快照与单一已验证句柄)。

- 入队前固化输入的项目归属、storage key、摘要、长度、MIME 和版本。
- 校验、哈希和上传使用同一已打开文件句柄，不能在路径重开后发生 TOCTOU 替换。
- 排队后删除、替换或重命名原始文件不会改变已持久化任务的输入身份。
- 摘要不匹配、权限失效和文件被替换均在后端提交前失败。

### SEC-04：源工件配额预留

状态：`ACCEPTED`（2026-07-19）。证据见[状态矩阵](remaining-work-status-matrix.md#sec-04源工件配额预留)。

- 两个独立连接并发写入时，预留加已提交字节永远不超过配额。
- 失败、取消和进程终止能幂等释放预留；已提交字节不能被释放两次。
- 大文件和未知 `Content-Length` 使用流式上限，不能先写满磁盘再判定。
- 配额拒绝不留下临时文件、数据库悬挂预留或外部请求。

### SEC-05：语音配置并发幂等

状态：`ACCEPTED`（2026-07-19）。证据见[状态矩阵](remaining-work-status-matrix.md#sec-05语音配置并发幂等)。

- 相同作用域、幂等键和语义摘要并发提交只执行一次处理并返回同一资源身份。
- 相同键但语义字段不同，稳定返回 `409`，且没有处理副作用。
- 不同用户和项目之间不能共享幂等结果。
- 失败后重试规则明确，不会重复外部处理。

### SEC-06：浏览器 mutation origin/CSRF 边界

- Cookie 浏览器写请求缺少来源、跨站、畸形 Referer、生产 HTTP origin 或 `Sec-Fetch-Site: cross-site` 时失败。
- 合法同源 HTTPS 浏览器请求按要求校验 CSRF 后成功。
- 有效 bearer/admin/service 请求可在无浏览器头时工作；Cookie 的存在不能让无效 bearer 降级为浏览器路径。
- 静态覆盖测试枚举所有 mutating route，每条路由必须使用中央 guard 或批准的 bearer-only wrapper。

### SEC-07：规范 JSON 与原始字节摘要分离

- `sha256Canonical` 通过 RFC 8785/JCS 对象排序、Unicode、转义、数值和负零黄金向量。
- NaN、Infinity、undefined、function、循环对象和 lone surrogate 明确失败。
- 原始字节只能使用 `sha256Bytes`；代码中不存在含义不明的 `sha256(value)`。
- 现有持久摘要 fixture 不变；如无法保持，必须先增加摘要版本和迁移/双读方案。

### RW-01 总体验收

- AC-01-01：SEC-01～SEC-07 全部满足，不得只以单元测试通过代替边界证明。
- AC-01-02：每项至少包含一个真实并发、真实进程或真实文件系统测试；不适用时由审查者解释。
- AC-01-03：失败路径证明“无数据库副作用、无外部提交、无临时文件泄漏”。
- AC-01-04：所有迁移在空库、旧基线库和当前库副本上通过。

验收结论（2026-07-19）：`ACCEPTED`。SEC-01～SEC-05 使用真实进程、独立数据库连接或真实文件系统证明竞态边界；SEC-06/SEC-07 属纯请求分类和纯序列化边界，不产生外部副作用，以全路由静态枚举、生产构建和黄金向量证明。最终门禁为 67 个测试文件、789 个测试、21 个 runtime 测试、67 个空库迁移及四类旧基线升级全部通过；ESLint 0 errors（保留 102 个既有 warnings）。
- AC-01-05：安全审查无 open P0～P3。

## 6. RW-02：十个真实本地工作流

### 6.1 固定验收对象

必须通过同一个本地公开端点顺序验收以下十个包；语音实现允许端点背后路由到彼此隔离且依赖兼容的执行环境，但证据必须绑定实际执行环境，不能伪装成同一进程：

1. `tts-index2`
2. `tts-index2-8g`
3. `tts-omnivoice-longform-bf16`
4. `tts-omnivoice-clone-duration-bf16`
5. `image-z-image-turbo`
6. `image-z-image-base-bf16`
7. `image-z-image-turbo-gguf-q4`
8. `image-z-image-turbo-gguf-q8`
9. `image-qwen-edit-2511-gguf-q4`
10. `video-wan2.1-fusionx`

不得用 mock、云端供应商、8001/8002 端口或预先生成的媒体代替本节验收。

### 6.2 前置条件

- 当前 Git SHA、Node、pnpm、Python、GPU/驱动、ComfyUI 提交、自定义节点版本和模型清单已记录。
- Pixelle root、ComfyUI root、data root、Python executable 均为固定启动配置，不接受请求或数据库覆盖。
- 8000 只有一个 loopback listener；8001、8002 没有 listener。
- resource pool capacity 和物理 slot 数均为 `1`。
- trust store 所有者、ACL、非 reparse point 和公钥指纹验证通过。
- 十个包来自同一不可变 `generationDigest`，模型物理字节与运行时分类全部匹配。
- 使用无敏感内容、已授权的受控参考 WAV；参数 JSON 不包含密钥。
- 图片编辑包必须使用恰好两张已授权受控参考图。

### 6.3 每个包的强制验收

每个包都必须产生以下事实：

- AC-02-01：提交前已持久化 restart-required marker。
- AC-02-02：提交获得唯一外部 prompt/job identity，且证据与 package/generation digest 绑定。
- AC-02-03：history 明确报告成功；未知、消失、取消或失败不能转换成成功。
- AC-02-04：输出数量、类型、魔数、结构、大小上限和摘要全部通过。
- AC-02-05：工件先流式下载、fsync、原子提交为 `COMMITTED`，之后才允许关闭连接和重启。
- AC-02-06：重启前确认没有 `STAGING` 工件、未结束输出流或未结算 job。
- AC-02-07：关闭旧连接后执行 stop/start，旧 PID、process creation identity 和 connection id 均不再复用。
- AC-02-08：新进程的 `/system_stats` 和 `/object_info` 在限时内成功，且 listener 始终只绑定 `127.0.0.1:8000`。
- AC-02-09：上一包的 `restart.after` 必须逐字等于下一包的 `listener.before`。
- AC-02-10：执行期间同一时刻最多一个生成任务；数据库 slot、进程观察和日志三类证据一致。

### 6.4 十包集合验收

- AC-02-11：十包全部来自同一代际，不允许跳过、替换或部分发布。
- AC-02-12：十份 evidence 使用同一个新鲜 `issuedAt` 重新签名，有效期不超过 24 小时，默认不超过 1 小时。
- AC-02-13：发布前重新从磁盘验证 package、artifact 和 evidence 摘要。
- AC-02-14：完整集合通过同目录原子 rename 发布，存在有效 `commit.json`。
- AC-02-15：验证结束后无孤儿 WebSocket、HTTP socket、子进程、临时目录或未释放非保留 lease。
- AC-02-16：任何一包失败时不产生可导入 committed set，不 import、不 promote。

### 6.5 必须保留的证据

每包证据至少包含：

| 字段 | 要求 |
| --- | --- |
| Git/代际 | Git SHA、generation digest、package digest |
| 后端身份 | URL、PID、process creation、boot/process identity |
| 连接身份 | submit 前 connection id、重启后新 connection id |
| 时间线 | submit、完成、下载、fsync、commit、close、stop、start、ready、reconnect |
| 工件 | media kind、相对 storage key、字节数、SHA-256、结构校验结果 |
| 资源 | pool/slot、claim owner、fencing token、结算结果 |
| 探测 | `/system_stats` 和 `/object_info` 摘要 |
| 结果 | PASS/FAIL、失败阶段、清理结果 |

证据只能记录相对路径或脱敏标识，不记录参考音频内容、密钥或认证头。

## 7. RW-03：故障、取消和恢复验收

以下场景必须使用真实本地进程或可控故障注入运行。每个场景都要验证数据库状态、slot/claim、工件目录、进程和下一任务行为。

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| FI-01 | 入队前非法参数 | 请求失败，无 job/attempt/slot/后端流量 |
| FI-02 | 缺模型或 node | inventory/提交前失败，不生成 verified evidence |
| FI-03 | workflow schema 被篡改 | 摘要或结构校验失败，不 import/promote |
| FI-04 | 提交前连接失败 | 可安全重试，不保留虚假外部 identity |
| FI-05 | 请求已写出但响应丢失 | `SUBMISSION_UNKNOWN`/保留资源，进入对账，不重复提交 |
| FI-06 | 执行中用户取消 | 只有确认取消后终态；完成竞态优先保留已提交工件 |
| FI-07 | 共享后端取消 | 禁止未验证的全局 interrupt |
| FI-08 | 输出下载中断 | 清理部分文件，保留外部身份，只重试收集 |
| FI-09 | 工件 fsync/rename 失败 | 不标记 committed，不重启后端，不丢失恢复证据 |
| FI-10 | ComfyUI 执行中崩溃 | 不猜测结果；slot/claim 按证据保留或对账 |
| FI-11 | stop/start 非零退出 | Worker 进入 blocked，禁止领取下一任务 |
| FI-12 | readiness 超时 | 完整清理受控子进程，Worker 保持 fail-stop |
| FI-13 | Worker 在各阶段终止 | 重启恢复幂等，不双提交、不双释放 |
| FI-14 | 两个恢复扫描器并发 | 最多一个终态动作，无负容量或重复工件 |
| FI-15 | 磁盘满/配额耗尽 | 有界失败，无孤儿临时文件或泄漏预留 |
| FI-16 | 超大或截断媒体 | 在发布前拒绝；MP3 无外部长度证据的固有限制按文档披露 |
| FI-17 | 非 loopback、重定向、DNS/WS 绕过 | 端点策略 fail closed |
| FI-18 | 服务关闭 | bounded shutdown；无 listener、子进程和未说明的 lease |

验收标准：

- AC-03-01：FI-01～FI-18 全部有可重复步骤和结果。
- AC-03-02：每个失败场景至少连续运行 3 次，结果一致。
- AC-03-03：并发场景至少运行 20 轮，零重复推理、零双释放、零孤儿文件。
- AC-03-04：所有超时实测不超过配置 deadline 加 20% 调度余量。
- AC-03-05：故障注入结束后可执行一次正常任务，证明系统不是依赖残留状态“通过”。

## 8. RW-04：供应链、权限、部署和运维缺口

### 8.1 工作流供应链

- 上传先进入不可执行隔离区，验证、审查、发布目录物理分离。
- semantic selector 唯一性由自动化测试证明。
- 隔离后端冒烟测试通过后才能进入审查。
- 发布要求两个不同身份的审查记录；提交者不能同时完成两次批准。
- 已发布目录只读；修改必须产生新 revision/digest。
- revoke 能阻止新任务使用，但保留历史任务和工件可追溯性。

当前实现状态（2026-07-19）：

- 通用包已先复制到有文件数/总字节上限、拒绝链接和 reparse point 的独立 quarantine；复制后逐文件复核大小与 SHA-256，验证失败只清理本次 quarantine 子目录。
- 通过验证的通用包仅能由 quarantine 直属子目录原子发布，随后清除文件与目录写位并递归复核；Pixelle 已验证代际在入库前执行同一只读保护。
- semantic selector、双人审批、导入者不可自审、环境漂移重新审批和 revoke 均已有自动化测试。
- 导入者和审查者身份从当前 Windows 登录令牌的 SID（安全标识符）解析；身份对象由本进程解析器在内存中签发，审批服务拒绝结构相同但未由解析器签发的对象，测试专用构造器在非测试环境直接失败。
- 该控制用于防止普通调用路径和误操作伪造审查人，不把拥有同一 SID（安全标识符）且能任意修改本地进程内存或 SQLite 文件的本机管理员纳入防护边界。若威胁模型要求抵抗本机管理员，必须改用独立身份服务的硬件或远程签名证明。
- 真实隔离后端冒烟仍属于 RW-02 的设备验收项，不能用假后端结果替代。

### 8.2 权限与部署隔离

- 每次输入读取和工件下载都重新验证 user/project 权限。
- 推理后端不挂载完整 uploads；只看到当前 slot 的受控摄取目录。
- 通用 staging 目录不能直接作为 ComfyUI 可读写根。
- 路径逃逸、symlink/junction/reparse point 和跨项目 storage key 测试全部失败。
- 浏览器旧密钥迁移有一次性、安全、可审计流程；迁移后浏览器不再保存后端密钥。

当前实现状态（2026-07-19）：

- 专用 ComfyUI DataRoot 为 `E:\ComfyUIData-ai-m`，Pixelle dry-run 已证明启动参数只挂载其 input/output/user/database；模型通过独立 extra-model config 引用，应用 uploads、通用 supply-chain 和 Pixelle staging 均不出现在参数中。
- 托管配置强制 shared input 精确等于 `<DataRoot>\input`，并要求 DataRoot 与三类应用/供应链根互不嵌套；缺少任一配置即 fail closed。
- 输入物化前只允许 `ai-m/<currentJob>/<currentAttempt>`，其他目录、文件、链接或 reparse point 均拒绝；图片上传响应必须仍在该 subfolder，图片和音频输入统一加入终态清理。
- 详细参数和逐项结论见[单端点部署隔离验收记录](comfyui-single-endpoint/deployment-isolation-attestation.md)。真实推理冒烟仍属于 RW-02，不能由 dry-run 替代。
- 专用后端已使用 `--base-directory E:\ComfyUIData-ai-m` 真实启动在 `127.0.0.1:8000`，系统与节点探测成功，参数层隔离成立；但实际进程与应用使用同一 Windows SID（安全标识符），相关目录仍继承宽泛访问规则。因此操作系统访问隔离未通过。解除条件见[单端点部署隔离验收记录](comfyui-single-endpoint/deployment-isolation-attestation.md)。

### 8.3 调度与重复执行防护

- 项目配额和公平性有明确算法、饥饿上限和并发测试。
- 已有 committed artifact 或确定外部完成证据时，不允许重新执行模型来恢复本地状态。
- 模型 inventory 记录可复核的文件大小和摘要；漂移使相关 profile fail closed。

当前实现状态（2026-07-19）：

- Pixelle prepare 可从受管 ComfyUI model root 以单一稳定文件句柄流式计算大小和 SHA-256，将二者写入不可变 manifest 并纳入 environment lock、package digest 和 generation digest。
- 晋级要求所有声明模型同时具备大小与 SHA-256，并重新读取实际文件复核；Worker 在提交推理前再次复核，缺少 model root、缺少不可变身份或发生漂移均进入需人工关注的 fail-closed 路径。
- 旧清单代际 `72fd10d71b738d036328bd8d4dd8ae32cf76961c8b7340f7fff5e4748aa0accb` 只完整记录了图像和视频所需模型。该旧代际不得导入或晋级。
- 全部语音模型已落盘并复核。旧六包代际曾在首包 `tts-index2` 的真实执行阶段安全失败；当前十包代际为 `a39c4c9340299866b75d7137f1622f8fa616b1cd12b8d12a630781321acc2467`，只读双重清点通过，但尚未重新实跑。失败根因不变：IndexTTS2 官方锁定 `transformers==4.52.1`，插件说明推荐 `4.52.1` 或 `4.54.1` 且声明 `>=4.57.1` 不兼容，而 OmniVoice 要求 `transformers>=5.3.0`。因此单一 Python 环境的依赖约束无交集，不能以降级或忽略元数据的方式伪修复。
- 当前 IndexTTS2 插件的 `pyproject.toml` 声明许可证来自 `LICENSE`，但仓库和已安装副本均缺少该文件；在取得权利人明确授权或选择许可证完整的替代实现前，不得把复制、修改该插件作为商业二开方案。
- 解除依赖阻塞的验收标准：形成经批准的架构决策；全部第三方代码和模型许可证完成核验；十包仍通过单一公开端点访问；各依赖环境可锁定并复现；冷启动、包间重启、显存释放、取消、超时、不确定提交、崩溃恢复和升级回滚均通过；随后从首包完整重跑当前十包代际，不得复用旧代际失败前后的局部证据。
- 新代际生成记录还显示文件 `fsync` 成功而 Windows 目录 `fsync` 为不支持。验证器现已在生产路径 fail closed：目录同步不支持时禁止签名和发布已验证证据。关闭 AC-02-05 与 AC-02-14 前，必须在目标文件系统上证明原子改名和提交标记跨进程崩溃、主机重启及模拟断电后仍可恢复；若平台不能提供目录同步，则必须实现并验证带校验摘要的双清单或写前日志协议，恢复器只能接受完整闭合的提交。
- 项目级灰度由 `FF_<FLAG>_PROJECTS` 精确 allowlist 控制；必须同时启用全局开关，空值、畸形、超限和名单外项目全部 fail closed，避免配置错误扩大发布范围。

### 8.4 可观测性与运维

- 指标至少覆盖队列深度、任务阶段耗时、lease/slot 保留、重启、对账、失败分类、磁盘水位和证据过期。
- 环境、模型、node、workflow digest 漂移产生可操作告警。
- 运维界面能查看但不能无证据地强制结束 `SUBMISSION_UNKNOWN`/`NEEDS_ATTENTION`。
- 所有人工操作有操作者、原因、前后状态和证据引用。
- 完成一次备份恢复演练：恢复数据库、uploads/工件、workflow generation 和 trust/audit 元数据，并重新通过一致性检查。

当前实现状态（2026-07-19）：

- `/operations` 处置台及管理员 API 已能列出 `NEEDS_ATTENTION`/`SUBMISSION_UNKNOWN` 的最小安全证据，登记枚举原因码和受限证据引用。
- “确认”只追加不可变审计事件，明确保持 job、attempt、artifact 和 slot 状态不变；页面不提供强制成功、强制失败、释放槽位或重新提交入口。
- 0068、Worker 周期刷新和运维健康 API/页面已完成统一指标及四类告警闭环。
- 备份恢复现已完成一次真实隔离演练：85 个文件、25,578,737 字节，恢复包 digest 为 `4e79b2edfee828185c4e3bc06e2712a06056e21682fab41f1d4996e1232a4122`，实测 RPO 年龄 537ms、恢复复制与复核 294ms；数据库 `integrity_check`、uploads/工件、通用供应链、Pixelle generation/GC audit 和公开 trust metadata 全部匹配。
- 私钥和 GC audit HMAC key 不写入普通文件恢复包，仍由当前受保护密钥存储独立托管；恢复演练仅恢复公开信任元数据和数据库/审计证据，不降低密钥 ACL。
- RW-04 的非真实 GPU 工作已完成；最终状态只随整体验收批次和发布门禁收口。

### RW-04 验收标准

- AC-04-01：实施检查表中 B、C、D、E、F、I、L、M、N 的每个 open/partial 项均有测试证据或批准的延期记录。
- AC-04-02：权限、重复推理、供应链完整性、备份恢复四类项目不得延期。
- AC-04-03：部署图和实际挂载/ACL 检查一致，不能只提供文字说明。
- AC-04-04：告警至少通过一次受控故障触发，并证明恢复后自动清除或进入已确认状态。
- AC-04-05：恢复演练的恢复点目标和恢复时间有实测值，恢复后抽样工件摘要全部匹配。

## 9. RW-05：全量质量门禁与双轮审查

### 9.1 固定门禁

在干净工作区、固定 Node 22.16.0 环境中依次运行：

```powershell
corepack pnpm preflight:runtime
corepack pnpm quality:static
corepack pnpm worker:build
corepack pnpm build
corepack pnpm quality
git diff --check
git status --short
```

要求：

- 所有命令退出码为 `0`。
- ESLint 必须为 0 errors；warnings 必须记录数量和相对基线的变化，新增 warning 需要修复或批准。
- 测试不得使用 `.only`、无理由 `.skip`、更新快照掩盖失败或吞掉未处理异常。
- 构建产物、数据库、WAL/SHM、日志、媒体、密钥、`.env` 和机器特定路径不进入提交。

### 9.2 规格审查

审查者逐项核对本文 AC、十包时间线、状态机、迁移兼容、权限和回滚。结论只能是：

- `READY`
- `NOT READY`，并列出 finding ID、级别、复现和要求

### 9.3 对抗式代码质量审查

必须检查：

- SQLite/WAL 事务长度和 busy 行为。
- job/attempt/claim/slot/artifact fencing token 一致性。
- 超时、AbortSignal、timer、socket 和子进程清理。
- Windows 参数转义、PID 复用和 process-tree 归属。
- TOCTOU、symlink/junction/reparse point、SSRF、redirect、DNS rebinding。
- 未知提交、取消/完成、下载/提交、重启/结算竞态。
- 日志边界、敏感信息和测试假阳性。

### RW-05 验收标准

- AC-05-01：固定门禁在最终候选 SHA 上重新运行，不接受旧 SHA 的结果。
- AC-05-02：两个审查轮次由不同上下文独立完成，并保存 finding 清单。
- AC-05-03：所有 P0～P3 finding 修复后重新运行受影响测试和完整门禁。
- AC-05-04：最终两份审查结论均为 `READY`，open finding 数为 0。
- AC-05-05：最终证据能从 Git SHA 重现，不依赖未记录的本机修改。

## 10. RW-06：发布、稳定验证与回滚演练

### 10.1 发布顺序

发布必须分成两个独立候选，禁止把兼容过渡和新增迁移合并为一次部署：

1. 冻结“兼容过渡版本”SHA 和证据目录；该版本不得包含 0063～0068 新迁移，但必须保持旧日志的篡改、缺口和未知历史拒绝，同时只读容忍经过批准的未来追加迁移。
2. 在隔离副本上证明兼容过渡版本可读取候选版本写入的新表和保留数据；随后恢复兼容过渡版本和原数据库摘要。
3. 先发布兼容过渡版本，完成生产冒烟和回滚演练；未完成时禁止发布新增迁移。
4. 再冻结“功能候选版本”SHA 和证据目录。
5. 备份数据库、工件、workflow generation 和信任/审计元数据。
6. 停止新任务进入，等待可安全排空的任务；不确定任务保留。
7. 应用 additive migrations。
8. 部署 Web 和 Worker，启动时验证全部 fail-closed 配置。
9. 只在 RW-02 verified evidence 有效时人工 import/promote 十包。
10. 验证 Web、Worker、数据库、8000 后端和指标。
11. 执行最小生产冒烟，观察一个完整任务周期及一次任务间重启。

### 10.2 回滚顺序

1. 停止新任务和新上传。
2. 保留不确定任务、claim、slot、proof、nonce、reservation、idempotency 和工件数据。
3. 只能回滚到已经验收的兼容过渡版本，不得直接回滚到当前 `04d1ace`；不 down-migrate 新增安全数据。
4. 验证兼容过渡版本能读取保留 schema 与 data，且对已知迁移篡改、缺口和非批准未来迁移继续 fail closed。
5. 只在恢复检查通过后重新接收任务。

### RW-06 验收标准

- AC-06-01：`dev` 与远端目标分支 SHA 一致，工作区干净。
- AC-06-02：Web 只按预期地址监听，`/zh` 返回 200 且包含正确语言标记。
- AC-06-03：Worker 报告 schema ready 并能领取一个受控任务。
- AC-06-04：8000 后端身份、pool capacity=1 和物理 slot=1 再次验证。
- AC-06-05：完成一个真实任务，工件提交后重启，随后再次 ready。
- AC-06-06：部署后观察窗口内没有孤儿进程、lease 泄漏、重复推理、数据库漂移或新增错误。
- AC-06-07：在隔离副本上实际执行一次回滚，旧版本能读取保留的新 schema/data。
- AC-06-08：再恢复到候选版本，迁移和工件摘要仍一致。
- AC-06-09：发布记录包含操作者、SHA、版本、开始/结束时间、门禁证据和回滚点。
- AC-06-10：兼容过渡版本与功能候选版本是两个不同 SHA；前者不含新迁移并先完成回滚演练，后者才允许应用 0063～0068。
- AC-06-11：直接使用 `04d1ace` 读取含 0063～0068 的数据库必须稳定失败，并在发布记录中明确标为禁止回滚目标。

建议最小观察窗口为 30 分钟；涉及长视频模型时不得短于一个最长允许任务周期。

## 11. 证据目录与结果格式

建议每次候选验收使用：

```text
docs/acceptance/<version>-<git-sha>/
├── SUMMARY.md
├── environment.json
├── commands.jsonl
├── quality/
├── security/
├── single-endpoint/
│   ├── commit.json
│   ├── evidence/
│   └── sanitized-logs/
├── fault-injection/
├── reviews/
│   ├── specification.md
│   └── adversarial-code-quality.md
├── rollout.md
└── rollback-rehearsal.md
```

默认不提交大媒体、原始日志、数据库、密钥或含本机敏感路径的证据。仓库内只提交脱敏摘要和外部受控证据位置；媒体只记录相对标识、大小和 SHA-256。

`SUMMARY.md` 至少包含：

```markdown
# Acceptance summary

- Version:
- Git SHA:
- Started/finished:
- Environment fingerprint:
- RW-00: ACCEPTED | ...
- RW-01: ACCEPTED | ...
- RW-02: ACCEPTED | ...
- RW-03: ACCEPTED | ...
- RW-04: ACCEPTED | DEFERRED_WITH_RISK
- RW-05: ACCEPTED | ...
- RW-06: ACCEPTED | ...
- Open P0-P3 findings:
- Approved deferrals:
- Final decision: GO | NO-GO
- Approvers:
```

## 12. 最终 Go/No-Go 判定

只有同时满足以下条件才能判定 `GO`：

- RW-00、RW-01、RW-02、RW-03、RW-05、RW-06 全部为 `ACCEPTED`。
- RW-04 为 `ACCEPTED`，或仅含符合规则的 `DEFERRED_WITH_RISK`。
- 十包 verified evidence 完整、未过期且与候选 generation/package digest 一致。
- 全量门禁基于最终候选 SHA 通过。
- 两轮独立审查均为 `READY`，P0～P3 open finding 为 0。
- 发布与回滚演练成功，备份可恢复。
- 没有密钥、环境文件、数据库、日志或生成媒体被误提交。

任一以下情况必须判定 `NO-GO`：

- 真实十包有任意一包未运行、失败、证据缺失或使用 mock 替代。
- 出现不确定提交却释放资源或自动重试模型。
- 工件未提交就重启后端。
- 安全认证、权限、fencing、幂等或供应链问题被延期。
- 全量门禁不是在最终候选 SHA 上执行。
- 有 open P0～P3 finding。
- 回滚需要删除新增安全数据或无法读取已有工件。

最终发布批准不能只写“测试通过”；必须引用本文 AC 编号和对应证据。
