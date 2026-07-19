# Pixelle 单端口 ComfyUI 工作流准备

> 当前剩余工作、十包强制验收、故障注入、证据格式和最终放行判定统一见 [`../remaining-work-development-and-acceptance-plan.md`](../remaining-work-development-and-acceptance-plan.md)。本文保留具体命令和单端口安全操作约束。

部署挂载与摄取根的代码/dry-run 验收见[部署隔离验收记录](deployment-isolation-attestation.md)。

## Task 4：单端口盘点、执行、整体重启和重连

验证器只接受 `http://127.0.0.1:8000`，只读取 `PIXELLE_WORKFLOW_STAGING_DIR/current.json` 指向的当前内容寻址代际，并只调用 Pixelle 固定的 `scripts/comfyui/stop_backend.ps1` 与 `start_backend.ps1`。它不会 import、promote 或 enable 工作流。

默认是安全的盘点模式（`dry-run` 是 `inventory-only` 的别名）：检查代际/package digest、实际 `/system_stats`、`/object_info`、节点和模型 inventory，不提交任务，也不重启 ComfyUI：

```powershell
$env:PIXELLE_ROOT = 'D:\demo1\Pixelle\Pixelle'
$env:PIXELLE_WORKFLOW_STAGING_DIR = 'D:\demo1\ai-m-workflow-staging\pixelle-single'
$env:AI_M_MANAGED_COMFYUI_DATA_ROOT = 'E:\ComfyUIData-ai-m'
$env:AI_M_MANAGED_COMFYUI_MODELS_ROOT = 'E:\ComfyUIData\models'
$env:AI_M_COMFYUI_SHARED_INPUT_ROOT = 'E:\ComfyUIData-ai-m\input'
$env:AI_M_MANAGED_COMFYUI_ROOT = 'E:\comfyui\resources\ComfyUI'
$env:AI_M_MANAGED_COMFYUI_PYTHON_EXE = 'E:\ComfyUIData\.venv\Scripts\python.exe'
$env:AI_M_MANAGED_COMFYUI_BASE_URL = 'http://127.0.0.1:8000'
$env:AI_M_MANAGED_COMFYUI_COMMAND_TIMEOUT_MS = '120000'
$env:AI_M_MANAGED_COMFYUI_READY_TIMEOUT_MS = '300000'
$env:TASK4_MODE = 'inventory-only'
corepack pnpm workflow:verify:pixelle-single
```

真实验证需要提供按 package 名分组的 JSON 参数文件；语音包还需要一个受控 WAV 文件。只有显式确认精确令牌后，CLI 才会顺序执行当前代际的包。每个包都执行：submit 前持久化 restart-required marker、限时轮询 history、流式限额下载并 fsync 临时归档、关闭旧连接、停止并启动整个 8000 后端、确认 PID/process creation/connection identity 全部变化、重新探测并收集 evidence 事实。上一包的 `restart.after` 必须精确等于下一包的 `listener.before`；十包全部通过后，CLI 使用同一个新鲜 `issuedAt` 对全部 evidence 重新签名，默认有效期为 1 小时且绝不允许超过 24 小时。运行窗口到 `expiresAt` 超过 24 小时会 fail closed。CLI 随后在当前时间严格重验磁盘上的全部 evidence，把最后一包 `restart.after` 记录为最终 endpoint，再一次原子 rename 发布整个 committed set：

可复制的十包参数基线见 [`task4-parameters.example.json`](task4-parameters.example.json)。语音参考必须是明确获准的声音，或像本轮准备项一样使用本机系统合成语音，不能擅自使用真实人员录音。

```powershell
$env:TASK4_MODE = 'verify'
$env:TASK4_CONFIRM_RESTART = 'RESTART-127.0.0.1:8000'
$env:TASK4_PARAMETERS_FILE = 'D:\task4\parameters.json'
$env:TASK4_REFERENCE_AUDIO_FILE = 'D:\task4\controlled-reference.wav'
$env:TASK4_REFERENCE_IMAGE_FILES_JSON = '["D:\\task4\\reference-a.png","D:\\task4\\reference-b.png"]'
$env:TASK4_COMMITTED_DIR = 'D:\task4\committed-generation'
corepack pnpm workflow:verify:pixelle-single
```

任何未知执行状态、提交结果不确定、节点/模型/schema 缺失、输出超限、重启超时或身份未变化都会 fail closed，且不会生成可导入的 evidence。完成后仍需单独执行人工 review/import/promote；本命令不会代替这些步骤。

如果 stop/start 或重连 readiness 结果不确定，CLI 会保留 `PIXELLE_WORKFLOW_STAGING_DIR/task4-restart-blocked.json` 并拒绝后续运行。操作员必须先从系统外部核对 8000 listener、PID、启动时间及健康探测，再用当前 generation digest 明确解除；例如 `$env:TASK4_RECOVERY_CONFIRM = 'RECOVER-<generationDigest>'`。恢复流程会再次建立新 WebSocket、核对 OS listener 并执行两项 readiness probe，全部成功后才删除 marker。

整个 recovery、连接、十包运行、重启和 committed 发布都先取得 staging 共用的 identity-bound `prepare.lock`，再取得 `task4.lock`，并按相反顺序释放。固定顺序避免死锁，也让 prepare/GC 与 Task 4 互斥。两把锁覆盖锁内读取 `current.json`、十包执行和最终 committed 发布；签名和发布前都会再次确认 current digest 未切换。prepare、GC 与 Task 4 共用同一个 boot-session/process-creation identity 和 process-liveness 实现。锁记录使用 schema 2 的 PID、process identity、随机 token 与开始时间；旧 Task 4 的 Windows epoch-ms identity 会按其毫秒精度与新 identity 比较，新格式之间仍按完整 100ns 精度比较。不可识别的旧 schema 2 identity 在 owner 存活时 fail closed 并要求人工审计。PID 复用或陈旧锁只有在旧身份明确不同/不存在时才隔离恢复。

本阶段只从只读目录 `D:\demo1\Pixelle\Pixelle\workflows\selfhost` 准备六个候选包，统一面向 `http://127.0.0.1:8000`。结果始终是 `prepared-environment-unverified`：prepare 不探测 ComfyUI、不写数据库、不创建 profile，也不执行 import、promote 或 enable。

## 准备不可变代际

```powershell
New-Item -ItemType Directory -Force 'D:\demo1\ai-m-workflow-staging' | Out-Null
$env:PIXELLE_ROOT = 'D:\demo1\Pixelle\Pixelle'
$env:PIXELLE_WORKFLOW_STAGING_DIR = 'D:\demo1\ai-m-workflow-staging\pixelle-single'
corepack pnpm workflow:prepare:pixelle-single
```

首次运行会创建带 ownership marker 的 staging 根目录。以后每次运行都先取得跨进程 `prepare.lock`，对九个唯一源工作流建立同一快照，再在带 token marker 的临时目录中写完并逐字节校验全部十个包。两个量化包共享同一份源工作流，因此源工作流数不是内容包数。内容摘要确定后，目录原子改名为 `generations/<generationDigest>`，最后只原子更新 `current.json` 指针。

相同输入会复用同一代际；输入变化会增加新代际，旧代际不会删除或覆盖。崩溃留下的、可识别的 `.tmp-generation-*` 会被报告为 orphan，不会自动递归清理。已有 unmanaged 目录、危险路径、symlink/junction、异常 lock 或无法确认归属的临时内容都会拒绝处理。

prepare lock 使用 schema 2，同时绑定 PID、process identity（系统 boot session 与进程 creation time）和随机 token。陈旧 lock 只有在原进程明确不存在，或 PID 已被创建时间不同的新进程复用时才可恢复；身份无法确认时必须停止并进行 manual recovery audit，禁止直接删 lock。

发布会 fsync 每个文件，并在平台支持时 fsync 目录。directory fsync 在 Windows/文件系统不支持时，CLI 的 `durability.directoryFsync` 会明确为 `false`；此时依靠原子 rename、文件 fsync，以及下次启动对 `current.json`、generation 和每个 package digest 的完整复验，任何不完整状态都会拒绝继续。

默认保护阈值为 32 个 generations、16 个 temp orphans、4 GiB staging 字节和 256 MiB 磁盘低水位。超过任一 generation/orphan/byte/free-space 限制都会停止发布，旧代际不会被自动删除。

每个代际包含十个包：

- `tts-index2`
- `tts-index2-8g`
- `tts-omnivoice-longform-bf16`
- `tts-omnivoice-clone-duration-bf16`
- `image-z-image-turbo`
- `image-z-image-base-bf16`
- `image-z-image-turbo-gguf-q4`
- `image-z-image-turbo-gguf-q8`
- `image-qwen-edit-2511-gguf-q4`
- `video-wan2.1-fusionx`

每个包包含 `workflow.api.json`、`manifest.json`、`compiled-bindings.json` 和 `package.lock.json`。CLI 和包内不输出本机绝对 staging 路径；输出的 requirements 只是后续验证清单，不代表当前 ComfyUI 已满足要求。

## 当前禁止 import/promote

Task 4 必须在目标 `8000` ComfyUI 的同一进程生命周期内完成 live probe、真实执行、数据库绑定检查，并产生与 `generationDigest`/`packageDigest` 绑定的 verified evidence。完成后还要整体重启 ComfyUI，等待健康检查通过，再重连并复验；在这份 verified evidence 出现以前，禁止 import/promote。

严格入口只信任固定路径 `$HOME/.ai-m/trust/pixelle-task4-ed25519-public.pem` 的本地 Ed25519 公钥，不接受环境变量替换 trust root。Task 4 的签名 evidence 必须包含有效期、backend fingerprint、目标 listener 的 PID/process identity/connection ID、每次 live run 及 artifact 摘要，以及整体重启前后的不同 process identity/connection ID；签名覆盖全部字段。缺文件、字段、签名、时效或任一绑定不匹配都会 fail closed。对应私钥必须由 Task 4 进程从受限的本机密钥存储读取，不能放进仓库、staging 或 evidence 文件。

首次使用前必须由当前 Windows 用户在本机配置固定 trust store；脚本不会接受环境变量替换路径，也不会自动补全、修复或覆盖已经存在的 root。已存在目标只执行严格 verify。新目标通过同目录随机临时 root 发布：先逐路径组件拒绝 reparse point，再用 Windows `DirectorySecurity` 清除继承和无关 ACE，验证仅当前 SID 与 SYSTEM 后才生成 key，完整复验后原子 rename；竞争或 rename 失败只清理该进程自己的临时 root，不向失败目标写 key：

```powershell
corepack pnpm workflow:trust:provision:pixelle-single
corepack pnpm workflow:trust:verify:pixelle-single
```

配置与验证会检查 private/public Ed25519 key、32-byte audit HMAC key 和公钥 fingerprint metadata。目录与文件必须属于当前 SID、禁用 DACL 继承、ACL 只能包含当前 SID 与 SYSTEM，并且不能是 symlink、junction 或其他 reparse point。evidence 的每个 live run 必须绑定同一个 backend fingerprint 和重启前 listener 的 PID、process creation time、boot ID、process identity、connection ID。时间线必须满足 run 完成早于 stopped/restarted，随后 `/system_stats` 与 `/object_info` 成功 readiness 摘要、reconnected、issued、当前验证时间和 expires 的严格顺序；超长字段、对象、签名、公钥或链接路径会直接拒绝。

当前已知 blocker 只作为 Task 4 排查线索：

- `tts-omnivoice-clone-duration-bf16` 需要实际注册的 `PixelleDurationInput` 节点。
- `video-wan2.1-fusionx` 需要实际可加载的 FusionX diffusion model 与 Wan 2.1 VAE。

磁盘上存在节点代码或模型文件不等于运行进程已经加载，不能据此解除 blocker。

## Task 4 verified evidence 后的命令参考

下面命令现在不能执行，仅保留为 Task 4 验证通过后的人工参考。importer 不接受任意包目录：必须提供代际根目录、包名以及 Task 4 evidence 绑定的两个预期摘要；导入前会从实际字节重新计算并核对。

```powershell
$env:WORKFLOW_GENERATION_ROOT = 'D:\demo1\ai-m-workflow-staging\pixelle-single\generations\<generationDigest>'
$env:WORKFLOW_PACKAGE_NAME = 'tts-index2'
$env:EXPECTED_GENERATION_DIGEST = '<generationDigest>'
$env:EXPECTED_PACKAGE_DIGEST = '<packageDigest>'
$env:TASK4_VERIFIED_EVIDENCE_FILE = 'D:\task4\committed-generation\evidence\tts-index2.json'
$env:PROFILE_KEY = 'pixelle.tts.index2.local'
$env:PROFILE_DISPLAY_NAME = 'Pixelle IndexTTS2 Local'
$env:EXECUTION_BACKEND_ID = '<8000 后端数据库 ID>'
Remove-Item Env:PROFILE_CONFIG_FILE -ErrorAction SilentlyContinue

$logDir = "$env:PIXELLE_WORKFLOW_STAGING_DIR\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
corepack pnpm workflow:import:verified-generation | Tee-Object -FilePath (Join-Path $logDir 'import-tts-index2.log')
```

导入身份不再接受环境变量；命令会从当前 Windows 登录令牌读取 SID（安全标识符）并写入来源记录。后续两次晋级审批必须分别由两个不同的 Windows SID（安全标识符）执行，且都不得与导入者相同。

通用 `workflow:import` 与 `WORKFLOW_PACKAGE_DIR` 继续兼容既有非 Pixelle 工作流；它不是 Pixelle verified-generation 入口，不得用于绕过上面的 Task 4 证据要求。

日志应保留到单机验收完成，并设置明确的保留期限；日志可能含 workflow digest、profile/backend 标识和错误上下文等敏感信息，不应提交进仓库或随意共享。完成真实生成、整体重启、重连复验和独立 review 后，才可参考现有 `workflow:promote` 命令，逐包人工 promote。

## 安全人工 GC

在线 GC 不删除文件，只隔离已经完成摘要复验、且不是 `current.json` 指向目标的旧代际。命令与 prepare 使用同一把 lock，要求操作者身份和两次完全一致的目标摘要。它先在现有 `audit_events` 数据库写入单调 `intent` anchor，再写 signed-chain intent，之后才把目标原子改名到受控 `quarantine/<generationDigest>`，最后写 signed-chain 与数据库 `committed`。数据库不可用时 fail closed 且不改名。启动重试会同时核对数据库 intent、signed chain、可能存在的唯一 trailing entry/`head.*.tmp`，以及 `generations`/`quarantine` 两侧状态；entry fsync、head temp fsync 或 head rename 后的崩溃都只能按 pending transaction、sequence、signature 和 previous digest 幂等 roll-forward。已验证的 existing head temp 会被直接发布，不会再创建第二个；字节完全相同的重复 temp 可确定性去重，不同内容则视为不一致。不一致尾记录会移入 `audit-recovery-quarantine` 并写 recovery-blocked 标记，要求人工 review；双存在或双缺失也不会自动处理。quarantine 的数量和字节仍计入 fail-closed 配额，因此命令不会虚假声称已释放空间。

审计只信任固定路径 `$HOME/.ai-m/trust/pixelle-gc-audit-hmac.key` 的本机受限密钥。普通 JSON 不是不可变记录，signed 文件链也只是辅助证据；`audit_events` 是链外单调 anchor。必须用 `workflow:audit:verify:pixelle-single` 同时校验数据库 intent/committed、每项签名、previous digest 和签名 head。单文件篡改、重排、截断，或把完整 entries/head 一起回滚到旧快照都会失败。数据库本身的离线管理员级回滚不在该机制的防护边界内。

本阶段范围是单人、单机正常运维与非同 SID 路径攻击防护；不声称能够抵御已经取得当前用户同一 SID 完全控制权的攻击者。同 SID 对 trust key、数据库与 staging 的联合控制属于后续安全加固范围。

```powershell
$env:PIXELLE_WORKFLOW_STAGING_DIR = 'D:\demo1\ai-m-workflow-staging\pixelle-single'
$env:GC_GENERATION_DIGEST = '<non-current generationDigest>'
$env:CONFIRM_GC_GENERATION_DIGEST = $env:GC_GENERATION_DIGEST
$env:GC_ACTOR_ID = 'local-operator'
corepack pnpm workflow:gc:pixelle-single
corepack pnpm workflow:audit:verify:pixelle-single
```

quarantine 只能在 ComfyUI、ai-m worker 和 prepare 全部停机后，由操作者先验证 audit chain、确认不被 `current.json` 或数据库引用，再使用操作系统离线工具人工清除。在线 Node 命令不会遍历或删除可能被 junction 替换的目录树。
