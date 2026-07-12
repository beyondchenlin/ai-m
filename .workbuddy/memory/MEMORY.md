# 项目长期笔记 (ai-m 二开)

## 项目身份
- ai-m 是从 AIComicBuilder fork 的二开项目（用户 LingyiChen-AI）。
- 仓库状态（2026-07-12）：纯原版 AIComicBuilder + 漫画侧分镜页重设计 task_plan.md。尚无短视频二开代码。

## 二开方向（已收敛，来自与 ChatGPT 的方案规划）
目标：在 AIComicBuilder 上新增「旁白解说型短视频」业务，做成**本地优先短视频工作室**。
- 保留原漫剧流水线不动；新增短视频业务独立模块与数据表。
- 三个核心决定：
  1. 角色升级为「视觉主体资产层」（支持人/动物/卡通/吉祥物/机器人等），原漫剧角色通过快照导入复用。
  2. 音频成为主时间线（先生成真实旁白→ffprobe 取时长→再定镜头数量与时长）。
  3. 模型接入围绕能力而非供应商名：本地 Z-Image 出稳定关键帧，本地 IndexTTS2/OmniVoice 出旁白，云端 Kling/Seedance/Veo/Grok 只负责让画面动。
- 本地媒体由 ComfyUI 执行；合成由 FFmpeg。
- 把 Pixelle-Video 当「业务规格参考实现」，不直译其 Python 服务为 TS。

## 关键约束 / 待核实
- 需核实 Pixelle-Video dev 分支是否真有文档所述 AssetBible/IPProfile/SceneCast 等契约（勿只信方案转述）。
- 第一版范围被低估；一致性是工程难点非架构可解；数据模型有过度规范化风险（建议先用 JSON 字段，稳定后再拆表）。
- agents/ 目录是百炼/扣子/Dify 平台 agent 导出，与短视频二开无关。
