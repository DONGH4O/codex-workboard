# Changelog

本项目遵循语义化版本格式。

## [1.0.0] - 2026-08-31

### Added

- 本地优先的 macOS 三阶段任务看板：计划中、执行、验收和回顾
- 通过 Codex App Server 同步、创建、恢复和继续对话
- 模型、速度、思考深度、审批策略、截图输入和执行引导
- 用户验收、AI 验收、批量流转、审计轨迹和终态归档
- 项目筛选、对话分类、任务时序图和本地 SQLite 持久化
- 每日维护入口与 GitHub macOS CI/Release 工作流

### Security

- Renderer 启用 context isolation 与 sandbox，禁用 Node integration
- 窗口拒绝新窗口并限制导航来源
- 发布前执行依赖安全审计和个人路径扫描
