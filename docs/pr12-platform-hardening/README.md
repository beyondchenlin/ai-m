# PR-12 平台稳定性加固

## 目标

本阶段不增加用户功能。它把现有本地工作流能力冻结为可审计、可恢复、可回滚的执行平台，并保持原漫剧链路兼容。

## 不可突破的边界

- 网页进程只创建和查询持久任务，不执行长时间推理。
- 独立工作进程负责租约、提交、对账、收集和归档。
- 工作流必须由真实 `workflow.api.json`、严格清单、编译绑定和锁定文件组成。
- 运行时只使用编译后的固定节点绑定，不进行模糊节点匹配。
- 工作领取租约与显卡资源租约独立，并分别使用防旧写令牌。
- 外部提交状态不确定时只执行对账，不允许盲目重提。
- 共享后端禁止全局中断。
- 所有输出必须流式进入两阶段不可变工件提交。
- 所有管理员接口必须通过独立认证；密钥只保存加密信封。
- 后端地址必须通过拓扑、域名解析、端口和重定向策略验证。

## 工作流晋级

1. 从真实 `ComfyUI` 导出接口工作流。
2. 执行 `pnpm workflow:import`，只进入已安装状态。
3. 由不同审核者执行 `pnpm workflow:promote`。
4. 晋级过程检查节点类别、模型文件、环境指纹和锁定摘要。
5. 只有精确的“工作流版本 + 后端修订 + 环境指纹”组合可以启用生成配置。

## 质量门禁

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:validate-examples
pnpm test:migrations
pnpm test:pr12-static
pnpm worker:build
pnpm build
```

## 真实后端冒烟

先启动独立工作进程，再指定已经晋级的生成配置：

```powershell
$env:SMOKE_PROJECT_ID="项目编号"
$env:SMOKE_PROFILE_REVISION_ID="生成配置修订版编号"
$env:SMOKE_USER_ID="用户编号"
$env:SMOKE_CAPABILITY="image"
$env:SMOKE_REQUEST_JSON='{"prompt":"一只白猫坐在窗边","width":1024,"height":1024,"seed":42}'
$env:SMOKE_EXPECT_MIME_PREFIX="image/"
pnpm smoke:generation
```

该测试必须经过持久任务、独立工作进程、真实后端、输出收集、媒体校验和工件归档；成功但没有已提交工件仍判定失败。

## 回滚

- 默认关闭所有新功能开关。
- 回滚代码时不删除任务、工件、工作流修订版或密钥引用。
- 禁用生成配置和后端即可停止新任务进入本地执行平台。
- 状态不确定或需要人工处理的任务不得自动重新提交。
