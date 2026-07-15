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
$env:REQUIRE_TASK4_VERIFIED_EVIDENCE = 'true'
$env:WORKFLOW_IMPORTER_ID = 'local-importer'
$env:PROFILE_KEY = 'pixelle.tts.index2.local'
$env:PROFILE_DISPLAY_NAME = 'Pixelle IndexTTS2 Local'
$env:EXECUTION_BACKEND_ID = '<8000 后端数据库 ID>'
Remove-Item Env:PROFILE_CONFIG_FILE -ErrorAction SilentlyContinue

$logDir = "$env:PIXELLE_WORKFLOW_STAGING_DIR\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
corepack pnpm workflow:import | Tee-Object -FilePath (Join-Path $logDir 'import-tts-index2.log')
```

日志应保留到单机验收完成，并设置明确的保留期限；日志可能含 workflow digest、profile/backend 标识和错误上下文等敏感信息，不应提交进仓库或随意共享。完成真实生成、整体重启、重连复验和独立 review 后，才可参考现有 `workflow:promote` 命令，逐包人工 promote。
