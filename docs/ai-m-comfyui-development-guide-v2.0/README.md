# `ai-m`（当前二开项目）本地工作流平台开发资料包 2.0

本资料包是对 1.0 版进行两轮对抗式审查后的根源性重构版本。

> 当前剩余工作、证据要求和最终发布判定以 [`../remaining-work-development-and-acceptance-plan.md`](../remaining-work-development-and-acceptance-plan.md) 为统一入口。本资料包的实施检查表用于审计，不单独证明发布完成。

## 推荐阅读顺序

1. `../remaining-work-development-and-acceptance-plan.md`（当前剩余工作与验收）
2. `QUALITY_GATE_REPORT.md`（质量门禁报告）
3. `AI-M_ComfyUI_对抗式双轮审查报告_v2.0.md`（双轮审查报告）
4. `AI-M_ComfyUI_本地工作流平台开发执行手册_v2.0.md`（主开发手册）
5. `SECURITY_THREAT_MODEL.md`（安全威胁模型）
6. `MIGRATION_AND_ROLLBACK.md`（迁移与回滚）
7. `IMPLEMENTATION_CHECKLIST.md`（实施检查表）
8. `adrs/`（架构决策）
9. `examples/`（结构约束、配置、数据库和测试夹具）
10. `qa/`（机器可读质量结果与自动校验日志）

## 自动校验

```bash
python tools/validate_examples.py
```

## 关键变化

- 不再把地址和密钥保存在浏览器；
- 不再在网页请求中执行长任务；
- 不再把工作流当普通模型编号；
- 不再宣称跨系统恰好一次；
- 不再依赖进程内显卡锁；
- 不再整块读取大媒体；
- 不再允许工作流包控制平台安全策略；
- 不再让外部历史充当项目数据库；
- 建立不可变修订版、持久尝试、资源租约和工件提交。

资料包中的通用工作流夹具只用于验证平台契约，不是生产 `Z-Image`（造相文生图模型）工作流。


## 最终质量状态

两轮对抗式审查、自动结构校验、可访问性审计、逐页 `DOCX`（可编辑文档）与 `PDF`（固定版式文档）渲染检查均已完成。详细证据见 `QUALITY_GATE_REPORT.md`（质量门禁报告）。
