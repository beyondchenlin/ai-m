# Pixelle 单端口 ComfyUI 工作流准备

本流程从只读源 `D:\demo1\Pixelle\Pixelle\workflows\selfhost` 准备 ai-m 候选工作流包，目标后端统一为 `http://127.0.0.1:8000`。prepare 不修改 Pixelle、不写数据库、不创建 profile，也不会 import、promote 或 enable。

## 1. Prepare 候选包

先创建一个独立的 staging 父目录。staging 目标本身必须不存在，或必须含有与规范路径完全匹配的 ai-m ownership marker；已有 unmanaged 目录即使为空也拒绝接管。

```powershell
New-Item -ItemType Directory -Force 'D:\demo1\ai-m-workflow-staging' | Out-Null
$env:PIXELLE_ROOT = 'D:\demo1\Pixelle\Pixelle'
$env:PIXELLE_WORKFLOW_STAGING_DIR = 'D:\demo1\ai-m-workflow-staging\pixelle-single'
Remove-Item Env:COMFYUI_INVENTORY_FILE -ErrorAction SilentlyContinue
corepack pnpm workflow:prepare:pixelle-single
```

脚本在 staging 同一父目录创建随机临时目录，完整写入并校验后才原子切换。替换已有 staging 前必须验证 `.ai-m-pixelle-staging.json` 的 schema、producer 与 canonical path。仓库根、用户 profile、盘符根、Pixelle 及其父子目录、symlink/junction 都会被拒绝。脚本不会直接 `rm` 任意已有目录。

无 inventory 时，六个目录只是 `prepared-environment-unverified` 候选：

- `tts-index2`
- `tts-index2-8g`
- `tts-omnivoice-longform-bf16`
- `tts-omnivoice-clone-duration-bf16`
- `image-z-image-turbo`
- `video-wan2.1-fusionx`

每个候选包含 `workflow.api.json`、`manifest.json`、现有 compiler 生成的 `compiled-bindings.json`，以及按实际字节生成并校验的 `package.lock.json`。包内不写绝对 Pixelle 路径。

## 2. 用 live inventory 做环境验证

`COMFYUI_INVENTORY_FILE` 必须来自 Task 4 对当前 `8000` 实例执行的 live verify/reprobe 命令，不能根据磁盘上“看起来存在”的文件手写或猜测节点注册状态。格式为：

```json
{
  "schemaVersion": 1,
  "source": "ai-m-live-comfyui-probe-v1",
  "baseUrl": "http://127.0.0.1:8000",
  "capturedAtMs": 2000000000000,
  "maxAgeMs": 300000,
  "backendFingerprint": "<64 lowercase hex>",
  "nodeClasses": ["SaveAudio", "VHS_VideoCombine"],
  "models": {
    "diffusion_models": ["example.safetensors"],
    "text_encoders": [],
    "vae": []
  },
  "objectInfoSha256": "<sha256 of canonical nodeClasses bytes, 64 lowercase hex>",
  "inventoryDigest": "<sha256 of the canonical payload excluding this field>"
}
```

```powershell
$env:COMFYUI_INVENTORY_FILE = 'D:\demo1\ai-m-workflow-staging\inventory-8000.json'
corepack pnpm workflow:prepare:pixelle-single
```

schema、source、端口、新鲜度、backend fingerprint、node class evidence hash 与完整 inventory digest 任一不匹配都会拒绝整个 inventory。`maxAgeMs` 由 Task 4 probe 配置，范围为 1 秒至 24 小时；过期或明显来自未来的快照拒绝使用。节点名、模型 folder/filename 必须安全且唯一。

CLI 分别输出：

- `inventoryMatched`：Task 4 live inventory 中的 node classes 与明确声明的 model folder/filename 匹配；状态为 `prepared-inventory-matched`，仍需后续 live run/review，不能等同于生产可用。
- `unverified`：没有提供 inventory；不能称为可用或可导入。
- `blocked`：列出缺失节点或模型；禁止进入 import。

当前本机已知 blocker（安装或同步后仍必须重启 ComfyUI 并 live reprobe）：

- `tts-omnivoice-clone-duration-bf16`：缺少已注册节点 `PixelleDurationInput`。使用 Pixelle 对应 sync 工具同步自定义节点后重启并复查 `/object_info`。
- `video-wan2.1-fusionx`：缺少 `diffusion_models/wan-fusionx/WanT2V_MasterModel.safetensors` 与 `vae/wan_2.1_vae.safetensors`。安装模型后重启并重新生成 inventory。

输出契约已有源码证据：ComfyUI `SaveAudio` history 字段为 `audio`；VideoHelperSuite `VHS_VideoCombine` 对 MP4 使用 history 字段 `gifs`。IndexTTS2/OmniVoice 节点内部模型标识不是 ComfyUI model folder 文件契约，因此不伪造 `requirements.models`。

## 3. Review 与逐包 import

只对 Task 4 live verify 后 CLI `inventoryMatched` 列表中的包执行。先人工检查 workflow、manifest、compiled bindings、package lock 和 inventory fingerprint。没有 Task 4 live verify，即使本地磁盘存在节点或模型文件，也不能 import/promote。

import 脚本只从环境变量读取完整流程配置；不要使用 positional package 参数。下面示例会同时导入不可变 workflow package 并创建一个 disabled profile：

```powershell
$env:WORKFLOW_PACKAGE_DIR = 'D:\demo1\ai-m-workflow-staging\pixelle-single\tts-index2'
$env:WORKFLOW_IMPORTER_ID = 'local-importer'
$env:PROFILE_KEY = 'pixelle.tts.index2.local'
$env:PROFILE_DISPLAY_NAME = 'Pixelle IndexTTS2 Local'
$env:EXECUTION_BACKEND_ID = '<8000 后端数据库 ID>'
Remove-Item Env:PROFILE_CONFIG_FILE -ErrorAction SilentlyContinue

corepack pnpm workflow:import | Tee-Object -FilePath '.\import-tts-index2.log'
```

无配置文件时，上面的主流程会使用 `{"defaultParameters":{}}`，仍会创建 disabled profile（admin visibility）。对每个 inventoryMatched 包分别设置 `WORKFLOW_PACKAGE_DIR`、唯一 `PROFILE_KEY`、匹配 capability 的 `PROFILE_DISPLAY_NAME` 后重复执行。记录命令输出中的：

- `workflowDigest` → 后续设置为 `WORKFLOW_DIGEST` 与 `CONFIRM_WORKFLOW_DIGEST`。
- `profileRevisionId` → 后续设置为 `PROFILE_REVISION_ID`。
- `package.lock.json.environmentLockDigest` → 后续设置为 `CONFIRM_ENVIRONMENT_LOCK_DIGEST`。

如果不设置 `PROFILE_KEY`，import 只安装 workflow package，不创建 profile；只有设置 `PROFILE_KEY` 的 import 才要求 `EXECUTION_BACKEND_ID`，并创建初始为 disabled/admin 的 profile。

确实需要 `PROFILE_CONFIG_FILE` 时，必须先创建完整合法 JSON，再设置变量：

```powershell
New-Item -ItemType Directory -Force 'D:\demo1\ai-m-workflow-staging\profiles' | Out-Null
@'
{
  "defaultParameters": {}
}
'@ | Set-Content -Encoding utf8 'D:\demo1\ai-m-workflow-staging\profiles\tts-index2.profile.json'
$env:PROFILE_CONFIG_FILE = 'D:\demo1\ai-m-workflow-staging\profiles\tts-index2.profile.json'
```

## 4. Live review 与 promote

promote 会再次探测后端节点和模型，并要求 reviewer 与 importer 不同。完成真实生成、输出下载、ComfyUI 完整重启及重连验证后，逐包设置：

```powershell
$env:WORKFLOW_DIGEST = '<import 输出的 workflowDigest>'
$env:CONFIRM_WORKFLOW_DIGEST = $env:WORKFLOW_DIGEST
$env:CONFIRM_ENVIRONMENT_LOCK_DIGEST = '<package.lock.json 的 environmentLockDigest>'
$env:EXECUTION_BACKEND_ID = '<8000 后端数据库 ID>'
$env:WORKFLOW_REVIEWER_ID = 'local-reviewer'
$env:PROFILE_REVISION_ID = '<import 输出的 profileRevisionId>'

# 仅在后端当前 disabled 且本次审查明确决定启用时设置
$env:ENABLE_BACKEND = 'true'

# 可选：审查通过后将此 profile 设为对应 capability 的全局默认
$env:SET_DEFAULT_CAPABILITY = 'speech'

corepack pnpm workflow:promote
```

非生产环境只有在明确接受 importer/reviewer 同一人的风险时才可设置 `ALLOW_WORKFLOW_SELF_REVIEW=true`。正常本地验收也应使用不同身份。不要把 prepare、inventory review、import、live run、promote 合并成自动流水线。
