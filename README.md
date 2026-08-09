# Codex Taskboard Demo

一个独立的 macOS 桌面容器，用任务看板组织本机 Codex 对话。它通过官方 `codex app-server` 读取和继续对话，不修改 Codex 应用，也不直接访问 Codex 的内部数据库。

## 已实现

- 三个主阶段：计划中、执行、验收和回顾
- 任务新增、优先级、执行人、验收标准和项目路径
- 看板拖动流转和列内子状态
- 关联本机真实 Codex 对话、读取消息、继续提交消息
- 独立审计角色；执行人与验收人相同时拒绝通过
- SQLite 本地任务库和审计轨迹
- Electron 安全边界：context isolation、sandboxed preload、无 renderer Node 权限

## 启动成品

双击：

`dist/mac-arm64/Codex Taskboard Demo.app`

这是本地未签名 Demo。若 macOS 首次阻止打开，可在 Finder 中右键应用并选择“打开”。

## 开发与验证

```bash
npm install
npm test
npm run pack
npm run test:ui
```

## 边界

当前版本是在独立窗口中复刻 Codex 的任务工作流，并通过 App Server 嵌入对话能力。它不会把“任务看板”按钮注入官方 Codex 的侧栏；那一步依赖官方扩展入口，或需要承担每次升级后重新适配的非官方注入风险。
