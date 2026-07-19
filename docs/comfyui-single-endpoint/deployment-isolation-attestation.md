# 单端点部署隔离验收记录

状态：`NOT_ACCEPTED`  
日期：2026-07-19  
真实推理状态：代码守卫已通过，操作系统身份与访问控制实证失败

## 目标拓扑

| 用途 | 受控根 | 推理后端可见 |
| --- | --- | --- |
| 应用 uploads/工件 | `D:\demo1\ai-m\uploads` | 否 |
| 通用工作流供应链 | `D:\demo1\ai-m\data\workflow-supply-chain` | 否 |
| Pixelle generation/trust evidence | `D:\demo1\ai-m-workflow-staging\pixelle-single` | 否 |
| ComfyUI 任务摄取 | `E:\ComfyUIData-ai-m\input` | 是，仅当前 slot/attempt |
| ComfyUI 输出 | `E:\ComfyUIData-ai-m\output` | 是 |
| 模型只读来源 | `E:\ComfyUIData\models`（由 extra-model config 引用） | 是 |

## 实际 dry-run 证据

Pixelle `start_backend.ps1 -DryRun -Json` 已返回以下关键参数：

```text
--user-directory   E:\ComfyUIData-ai-m\user
--input-directory  E:\ComfyUIData-ai-m\input
--output-directory E:\ComfyUIData-ai-m\output
--base-directory   E:\ComfyUIData-ai-m
--database-url     sqlite:///E:/ComfyUIData-ai-m/user/comfyui.db
--listen           127.0.0.1
--port             8000
```

参数中不包含应用 uploads、通用 workflow staging 或 Pixelle generation 根。经授权重启后，真实监听进程的启动命令已经使用 `--base-directory E:\ComfyUIData-ai-m`，与上述试运行输出一致；参数隔离已经成立，但仍不能替代下述操作系统身份和访问控制实证。

## 真实进程与访问控制反证

2026-07-19 对监听 8000 端口的实际进程检查得到：

- 推理进程与当前应用操作者使用同一个 SID（安全标识符）：`S-1-5-21-3065164270-402950936-3062693177-1001`。
- 实际命令使用 `--base-directory E:\ComfyUIData-ai-m`，并通过额外模型配置只引用共享根中的 `custom_nodes` 和 `models`。
- 应用上传目录、通用供应链目录、Pixelle 暂存目录、推理输入输出目录与模型目录都继承了宽泛访问规则；`Authenticated Users`（已认证用户）具有修改权限，`Users`（用户组）具有读取和执行权限。

因此，“启动参数没有显式挂载某目录”只能证明参数隔离，不能证明进程不可读取该目录。当前推理进程与应用同身份，且目录访问控制没有形成拒绝边界，I-01 与 I-02 不满足完整验收标准。

本机账户只读盘点也没有发现已获项目批准、可直接用于该服务的专用低权限账户。工具自身的沙箱账户不属于项目服务身份，禁止挪用来制造隔离通过记录。创建服务账户、容器身份或修改目录访问控制均属于新的部署授权，在获得明确授权并完成拒绝读取实测前，本项保持不通过。

## 强制规则

- 托管运行时启用时，`AI_M_COMFYUI_SHARED_INPUT_ROOT` 必须精确等于 `<DataRoot>\input`。
- DataRoot 必须与 `UPLOAD_DIR`、`AI_M_WORKFLOW_SUPPLY_CHAIN_ROOT`、`PIXELLE_WORKFLOW_STAGING_DIR` 互不相等且互不嵌套；缺少任一配置即 fail closed。
- 任务物化前递归检查摄取根：根目录只能有 `ai-m/<currentJob>/<currentAttempt>`，出现其他项目、attempt、普通文件、链接或 reparse point 即拒绝推理。
- 图片上传响应必须返回请求的当前 attempt subfolder；上传文件和音频直拷文件均登记到同一清理集合，在终态后删除。
- 资源池容量和物理 slot 数仍必须精确为 1；本记录不替代真实后端运行、重启和故障注入验收。

## 验收结论

- I-01 后端不能读取完整 uploads：`NOT_ACCEPTED`。同一 SID（安全标识符）且宽泛目录访问控制可读。
- I-02 后端不能读取通用 staging：`NOT_ACCEPTED`。同一 SID（安全标识符）且宽泛目录访问控制可读。
- I-03 摄取目录只含当前资源槽和安全租户：`PARTIAL`。运行时守卫与自动化测试通过，但尚未在隔离服务身份下实测。
- RW-02 真实设备冒烟：`NOT_ACCEPTED`，不得由试运行或直接调用后端的验证器替代。

解除阻断的完整验收标准：

1. 推理进程使用与应用、交互操作者不同的专用低权限 SID（安全标识符）或等价容器身份。
2. 专用身份对应用上传、通用供应链、Pixelle 暂存和数据库根执行真实读取探测，均返回拒绝；对当前任务摄取目录、输出目录、必需模型和节点目录的最小权限探测成功。
3. 实际进程命令、进程所有者、目录访问控制和读取探测结果写入同一时间窗口的证据文件。
4. 重启后重新执行上述探测，进程身份与权限边界不漂移。
5. 在该身份下完成六包应用任务链及十八类故障注入，才可将本记录改为通过。

## 后续真实探测

专用后端已成功监听 `127.0.0.1:8000`，系统与节点探测均成功。旧代际 `72fd10d71b738d036328bd8d4dd8ae32cf76961c8b7340f7fff5e4748aa0accb` 因语音模型清单不完整而废止。全部模型落盘并复核后，新代际 `5a40f8bb7c4b8a0f437aca2a73c85e532a9c72e5963acc242992ec4d494d9681` 已生成；真实首包随后因 IndexTTS2 与 OmniVoice 的 `transformers` 版本约束无交集而执行失败。该结果不改变访问隔离结论，也不得用参数隔离或模型完整性替代操作系统身份与目录拒绝读取实证。
