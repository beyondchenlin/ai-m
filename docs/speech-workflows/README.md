# 本地声音工作流接入

声音模型已经作为 `speech` 能力进入模型中心，但项目不会内置伪造的 ComfyUI 节点名称。IndexTTS2 和 OmniVoice 的社区节点实现并不唯一，节点类名与输入字段必须来自你电脑中实际安装并验证过的工作流。

## 工作流包要求

每个正式包必须包含：

- `workflow.api.json`：从 ComfyUI 导出的 API 格式工作流；
- `manifest.json`：能力、参数绑定、输出和依赖声明；
- `compiled-bindings.json`：由平台编译器生成，禁止手工伪造；
- `package.lock.json`：对上述文件和环境锁进行内容寻址。

模板目录中的 `manifest.template.json` 不能直接晋级。请把 `REPLACE_*` 字段替换成真实节点类、节点标题、输入字段、模型目录和模型文件。

## 必须提供的语义绑定

| 业务键 | 来源 | 用途 |
|---|---|---|
| `text` | request | 当前旁白块 |
| `voiceReference` | voice-reference | 受控音色参考文件 |
| `referenceText` | request | 参考音频对应文字，可选 |
| `speed` | request | 语速，可选 |
| `pitch` | request | 音调，可选 |
| `language` | request | 语言标签，可选 |
| `emotion` | request | 情绪文字，可选 |
| `emotionStrength` | request | 情绪强度，可选 |

工作流至少输出一个 `audio` 工件。生成结果由工作进程流式归档，并通过 ffprobe 记录真实时长。

## 导入与晋级

```powershell
$env:WORKFLOW_PACKAGE_DIR="D:\workflows\indextts2"
$env:WORKFLOW_IMPORTER_ID="admin-importer"
$env:PROFILE_KEY="speech.indextts2.clone"
$env:PROFILE_DISPLAY_NAME="IndexTTS2 声音克隆"
$env:EXECUTION_BACKEND_ID="你的声音后端ID"
$env:PROFILE_CONFIG_FILE="docs\speech-workflows\profiles\indextts2.profile.json"
pnpm workflow:import
```

导入后仍为禁用状态。完成独立审核、真实节点与模型检查后再晋级：

```powershell
$env:WORKFLOW_DIGEST="导入输出的摘要"
$env:CONFIRM_WORKFLOW_DIGEST=$env:WORKFLOW_DIGEST
$env:CONFIRM_ENVIRONMENT_LOCK_DIGEST="包锁中的环境摘要"
$env:EXECUTION_BACKEND_ID="你的声音后端ID"
$env:PROFILE_REVISION_ID="导入输出的配置修订ID"
$env:WORKFLOW_REVIEWER_ID="另一位审核者"
$env:ENABLE_BACKEND="true"
$env:SET_DEFAULT_CAPABILITY="speech"
pnpm workflow:promote
```

## 共享输入目录

声音工作流使用受控共享输入目录，不接受浏览器传入的宿主机绝对路径：

```text
AI_M_COMFYUI_SHARED_INPUT_ROOT=D:\ComfyUI\input\ai-m-private
```

该目录必须与应用上传目录隔离。工作进程按任务和执行尝试建立命名空间，并在确定终态后清理。

## 真实声音冒烟测试

完成工作流导入、审核与晋级，并启动独立工作进程后执行：

```powershell
$env:SMOKE_PROJECT_ID="项目ID"
$env:SMOKE_USER_ID="用户ID"
$env:SMOKE_VOICE_PROFILE_ID="音色档案ID"
$env:SMOKE_PROFILE_REVISION_ID="声音生成配置修订ID"
$env:SMOKE_SPEECH_TEXT="这是一段真实声音工作流验收音频。"
pnpm smoke:speech
```

冒烟测试只有在持久任务成功、输出被安全归档为音频、并由 ffprobe 写入大于零的真实时长后才通过。
