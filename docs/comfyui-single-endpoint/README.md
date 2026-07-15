# Pixelle 单端口 ComfyUI 工作流准备

本流程从本机只读源 `D:\demo1\Pixelle\Pixelle\workflows\selfhost` 准备 ai-m 工作流包，目标 ComfyUI 地址统一为 `http://127.0.0.1:8000`。准备脚本不会修改 Pixelle，不会导入数据库，不会启用或提升任何包。

## 准备

在 PowerShell 中明确设置源目录和独立 staging 目录：

```powershell
$env:PIXELLE_ROOT = 'D:\demo1\Pixelle\Pixelle'
$env:PIXELLE_WORKFLOW_STAGING_DIR = 'D:\demo1\ai-m-workflow-staging\pixelle-single'
corepack pnpm workflow:prepare:pixelle-single
```

脚本只接受这两个显式环境变量。staging 不能位于 Pixelle 内部、不能包含 Pixelle，也不能经过符号链接或 junction。每次执行会安全清理并重建整个 staging 目录；成功状态为 `prepared-not-imported`。

生成六个包：

- `tts-index2`
- `tts-index2-8g`
- `tts-omnivoice-longform-bf16`
- `tts-omnivoice-clone-duration-bf16`
- `image-z-image-turbo`
- `video-wan2.1-fusionx`

每个目录包含真实 `workflow.api.json`、`manifest.json`、现有编译器生成的 `compiled-bindings.json`，以及按实际文件字节计算的 `package.lock.json`。绝对 Pixelle 路径不会写入包。

## 契约证据

- ComfyUI 内置 `SaveAudio` 的 UI history 字段为 `audio`，依据本机 `E:\comfyui\resources\ComfyUI\comfy_api\latest\_ui.py` 的 `SavedAudios.as_dict()`。
- VideoHelperSuite 的 `VHS_VideoCombine` 对 MP4 也使用 UI history 字段 `gifs`，依据本机 `E:\ComfyUIData\custom_nodes\ComfyUI-VideoHelperSuite\videohelpersuite\nodes.py` 的返回值。视频包因此声明 `VHS_VideoCombine.gifs`，而不是 `SaveImage.images`。
- Z-Image 与 Wan 模型仅从 `UNETLoader.unet_name`、`CLIPLoader.clip_name`、`VAELoader.vae_name` 生成明确的 ComfyUI folder/filename 映射。
- IndexTTS2 与 OmniVoice 节点内部的模型标识不是 ComfyUI model folder 文件契约，因此不伪造 `requirements.models`；依赖由真实 `requirements.nodeClasses` 和环境锁约束。

若所需节点、唯一 title/class selector、保存输出或模型字段缺失/重复，准备会 fail closed，不会留下部分 staging 包。

## Review、import、promote 分离

1. **prepare**：运行上述命令，只生成 staging 包。
2. **review**：人工检查每个 `workflow.api.json`、`manifest.json`、`compiled-bindings.json` 与锁摘要，并在 `http://127.0.0.1:8000/object_info` 核对节点环境。
3. **import**：逐包显式执行 `corepack pnpm workflow:import <package-dir>`；导入后的 profile 仍为 disabled。
4. **promote**：完成单机实跑、输出下载和 ComfyUI 重启重连验证后，再按不可变锁摘要显式运行 `workflow:promote`。

不要把 prepare、review、import、promote 合并成自动流水线。单端口运行时，同一时间只执行一个 GPU 任务；任务输出完成归档后再完整重启 ComfyUI，并在健康检查通过后建立新连接。
