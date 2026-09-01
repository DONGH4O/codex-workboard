# 参与贡献

感谢参与 Codex Workboard。提交改动前请先创建 Issue，说明问题、预期行为和影响范围。

## 开发环境

- macOS 或 Windows x64
- Node.js 22 或更高版本
- npm 11
- 如需运行真实 App Server 测试，需安装并登录 Codex CLI 或 ChatGPT/Codex 桌面应用

```bash
npm ci
npm test
npm run build
```

## 提交要求

1. 不提交本机用户名、绝对路径、对话 ID、数据库、截图或真实验收证据。
2. 新功能应补充或更新单元测试；UI 行为变更应运行 `npm run pack` 和 `npm run test:ui`。
3. 不直接读取或修改 Codex 的私有数据库、会话文件或应用资源。
4. 提交前运行 `npm run release:check`。
5. PR 应保持范围清晰，并在说明中列出验证命令与结果。
6. Windows 目录打包使用 `npm.cmd run pack:win`；不得在普通测试中运行 NSIS 安装程序，也不得把 `dist`、运行状态或用户数据提交到仓库。

## 真实集成测试

以下命令会连接当前账号的 Codex App Server，只适合在明确隔离的本机环境运行，不在公共 CI 中执行：

```bash
npm run test:live
npm run test:create-thread
npm run test:flow
```

正式流程测试使用独立临时 `userData`，但仍会读取当前账号可见的对话目录。生成的证据 JSON 已被 Git 忽略。
