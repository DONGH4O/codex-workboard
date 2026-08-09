# Codex Workboard

一个本地优先的 macOS 桌面工作台，用任务看板组织本机 Codex 对话。它通过官方 `codex app-server` 读取和继续对话，不修改 Codex 应用，也不直接访问 Codex 的内部数据库。

## 已实现

- 三个主阶段：计划中、执行、验收和回顾
- 高透明度冰蓝玻璃桌面工作台、顶部任务指标、中央三阶段看板和右侧智能验收面板
- 任务新增、优先级、执行人、验收标准和项目路径
- 看板拖动流转和列内子状态
- 显式同步 App Server 的 10 种对话来源，覆盖当前与归档对话
- 统一对话目录，支持主题自动分类、人工分类、标签、备注与转为任务
- 关联本机真实 Codex 对话、读取消息、继续提交消息
- 独立审计角色；执行人与验收人相同时拒绝通过
- 验收结论只能通过审计入口写入，状态变化与审计事件原子提交
- SQLite 本地任务库、离线缓存提示、旧 Demo 任务迁移和审计轨迹
- Electron 安全边界：context isolation、sandboxed preload、无 renderer Node 权限

## 启动成品

双击：

`dist/mac-arm64/Codex Workboard.app`

这是本地未签名的 1.0.0 正式功能版。若 macOS 首次阻止打开，可在 Finder 中右键应用并选择“打开”。它尚未做 Apple Developer ID 签名、公证和自动更新，因此不等同于可对外分发的商店版本。

## 开发与验证

```bash
npm install
npm test
npm run pack
npm run test:ui
npm run test:flow
```

## 边界

当前版本是在独立 macOS 窗口中承载 Codex 任务工作流，并通过 App Server 接入对话能力。它不会把“任务看板”按钮注入官方 Codex 的侧栏；那一步依赖官方扩展入口，或需要承担每次升级后重新适配的非官方注入风险。
