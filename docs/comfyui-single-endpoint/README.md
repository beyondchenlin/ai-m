# Pixelle 单端口 ComfyUI 工作流准备

本阶段只从只读目录 `D:\demo1\Pixelle\Pixelle\workflows\selfhost` 准备六个候选包，统一面向 `http://127.0.0.1:8000`。结果始终是 `prepared-environment-unverified`：prepare 不探测 ComfyUI、不写数据库、不创建 profile，也不执行 import、promote 或 enable。

## 准备不可变代际

```powershell
New-Item -ItemType Directory -Force 'D:\demo1\ai-m-workflow-staging' | Out-Null
$env:PIXELLE_ROOT = 'D:\demo1\Pixelle\Pixelle'
$env:PIXELLE_WORKFLOW_STAGING_DIR = 'D:\demo1\ai-m-workflow-staging\pixelle-single'
corepack pnpm workflow:prepare:pixelle-single
```

首次运行会创建带 ownership marker 的 staging 根目录。以后每次运行都先取得跨进程 `prepare.lock`，对六个源文件建立同一快照，再在带 token marker 的临时目录中写完并逐字节校验全部包。内容摘要确定后，目录原子改名为 `generations/<generationDigest>`，最后只原子更新 `current.json` 指针。

相同输入会复用同一代际；输入变化会增加新代际，旧代际不会删除或覆盖。崩溃留下的、可识别的 `.tmp-generation-*` 会被报告为 orphan，不会自动递归清理。已有 unmanaged 目录、危险路径、symlink/junction、异常 lock 或无法确认归属的临时内容都会拒绝处理。

prepare lock 使用 schema 2，同时绑定 PID、process identity（系统 boot session 与进程 creation time）和随机 token。陈旧 lock 只有在原进程明确不存在，或 PID 已被创建时间不同的新进程复用时才可恢复；身份无法确认时必须停止并进行 manual recovery audit，禁止直接删 lock。

发布会 fsync 每个文件，并在平台支持时 fsync 目录。directory fsync 在 Windows/文件系统不支持时，CLI 的 `durability.directoryFsync` 会明确为 `false`；此时依靠原子 rename、文件 fsync，以及下次启动对 `current.json`、generation 和每个 package digest 的完整复验，任何不完整状态都会拒绝继续。

默认保护阈值为 32 个 generations、16 个 temp orphans、4 GiB staging 字节和 256 MiB 磁盘低水位。超过任一 generation/orphan/byte/free-space 限制都会停止发布，旧代际不会被自动删除。

每个代际包含六个包：

- `tts-index2`
- `tts-index2-8g`
- `tts-omnivoice-longform-bf16`
- `tts-omnivoice-clone-duration-bf16`
- `image-z-image-turbo`
- `video-wan2.1-fusionx`

每个包包含 `workflow.api.json`、`manifest.json`、`compiled-bindings.json` 和 `package.lock.json`。CLI 和包内不输出本机绝对 staging 路径；输出的 requirements 只是后续验证清单，不代表当前 ComfyUI 已满足要求。

## 当前禁止 import/promote

Task 4 必须在目标 `8000` ComfyUI 的同一进程生命周期内完成 live probe、真实执行、数据库绑定检查，并产生与 `generationDigest`/`packageDigest` 绑定的 verified evidence。完成后还要整体重启 ComfyUI，等待健康检查通过，再重连并复验；在这份 verified evidence 出现以前，禁止 import/promote。

严格入口只信任固定路径 `$HOME/.ai-m/trust/pixelle-task4-ed25519-public.pem` 的本地 Ed25519 公钥，不接受环境变量替换 trust root。Task 4 的签名 evidence 必须包含有效期、backend fingerprint、目标 listener 的 PID/process identity/connection ID、每次 live run 及 artifact 摘要，以及整体重启前后的不同 process identity/connection ID；签名覆盖全部字段。缺文件、字段、签名、时效或任一绑定不匹配都会 fail closed。对应私钥必须由 Task 4 进程从受限的本机密钥存储读取，不能放进仓库、staging 或 evidence 文件。

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
$env:TASK4_VERIFIED_EVIDENCE_FILE = 'D:\demo1\ai-m-workflow-staging\evidence\tts-index2.json'
$env:WORKFLOW_IMPORTER_ID = 'local-importer'
$env:PROFILE_KEY = 'pixelle.tts.index2.local'
$env:PROFILE_DISPLAY_NAME = 'Pixelle IndexTTS2 Local'
$env:EXECUTION_BACKEND_ID = '<8000 后端数据库 ID>'
Remove-Item Env:PROFILE_CONFIG_FILE -ErrorAction SilentlyContinue

$logDir = "$env:PIXELLE_WORKFLOW_STAGING_DIR\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
corepack pnpm workflow:import:verified-generation | Tee-Object -FilePath (Join-Path $logDir 'import-tts-index2.log')
```

通用 `workflow:import` 与 `WORKFLOW_PACKAGE_DIR` 继续兼容既有非 Pixelle 工作流；它不是 Pixelle verified-generation 入口，不得用于绕过上面的 Task 4 证据要求。

日志应保留到单机验收完成，并设置明确的保留期限；日志可能含 workflow digest、profile/backend 标识和错误上下文等敏感信息，不应提交进仓库或随意共享。完成真实生成、整体重启、重连复验和独立 review 后，才可参考现有 `workflow:promote` 命令，逐包人工 promote。

## 安全人工 GC

在线 GC 不删除文件，只隔离已经完成摘要复验、且不是 `current.json` 指向目标的旧代际。命令与 prepare 使用同一把 lock，要求操作者身份和两次完全一致的目标摘要，写入 HMAC 签名 hash-chain 审计记录后，把目标原子改名到受控 `quarantine/<generationDigest>`。quarantine 的数量和字节仍计入 fail-closed 配额，因此命令不会虚假声称已释放空间。

审计只信任固定路径 `$HOME/.ai-m/trust/pixelle-gc-audit-hmac.key` 的本机受限密钥。普通 JSON 不是不可变记录；必须用 `workflow:audit:verify:pixelle-single` 校验每项签名、previous digest 和签名 head，篡改、重排或截断都会失败。

```powershell
$env:PIXELLE_WORKFLOW_STAGING_DIR = 'D:\demo1\ai-m-workflow-staging\pixelle-single'
$env:GC_GENERATION_DIGEST = '<non-current generationDigest>'
$env:CONFIRM_GC_GENERATION_DIGEST = $env:GC_GENERATION_DIGEST
$env:GC_ACTOR_ID = 'local-operator'
corepack pnpm workflow:gc:pixelle-single
corepack pnpm workflow:audit:verify:pixelle-single
```

quarantine 只能在 ComfyUI、ai-m worker 和 prepare 全部停机后，由操作者先验证 audit chain、确认不被 `current.json` 或数据库引用，再使用操作系统离线工具人工清除。在线 Node 命令不会遍历或删除可能被 junction 替换的目录树。
