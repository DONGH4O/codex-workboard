# Codex Workboard

[中文](#中文) | [English](#english)

## 中文

作者：new school

一个本地优先的 macOS 桌面工作台，正在适配 Windows x64 目录版，用任务看板组织、执行和验收 Codex 对话。Windows 源码自动验证通过不等于目录包已生成、启动或完成人工验收。

## 已实现

- 三个主阶段：计划中、执行、验收和回顾
- 高透明度冰蓝玻璃桌面工作台、顶部任务指标、中央三阶段看板和右侧智能验收面板
- 任务新增、优先级、执行人、验收标准和项目路径
- 新建任务可指定项目、模型、思考深度和速度；默认自动创建并命名独立 Codex 会话，并立即发送首条任务指令
- 也可改为关联已有会话或仅保存任务卡；卡片支持多选、批量迁移阶段和逐项审计的批量验收
- 看板拖动流转和列内子状态
- 左侧“工作流”三个阶段可点击筛选；再次点击当前阶段恢复完整三列看板
- 任务详情的“迁移工作阶段”区域提供可撤销的直接归档按钮
- 每列支持“最新对话优先”排序，按关联 Codex 对话的更新时间排列，未关联任务置后
- 显式同步 App Server 的 10 种对话来源，覆盖当前与归档对话
- 统一对话目录，支持主题自动分类、人工分类、标签、备注与转为任务
- 支持一键将所有未关联对话去重转换为三阶段任务；归档、标题动作和审查关键词共同决定阶段
- 关联本机真实 Codex 对话、读取消息，并在“关联对话”页直接续聊；模型、思考深度和审批策略与实时执行共用
- 任务右侧提供“实时执行”：启动前选择 App Server 返回的模型、真实速度档位、思考深度与审批策略；审批策略包含未信任操作询问、Codex 按需申请和完全访问权限
- 新建任务沿用同一套模型、速度、思考深度与审批策略；“所属项目”显示业务项目名，并自动选择该项目最活跃的工作目录
- 完全访问权限会发送 `approvalPolicy: never` 与 `sandboxPolicy: dangerFullAccess`；界面显示风险提示并在每次启动前再次确认，切回普通策略时会显式恢复工作区沙盒
- 受保护操作直接在 Workboard 显示审批卡，可批准一次、在本次会话允许或拒绝；审批、完成和失败会触发系统通知
- 右上角通知中心汇总等待审批、阻塞/返工、待验收和同步异常；数量实时更新，点击通知直接进入对应处理位置
- 执行证据持久化到本地 SQLite；应用重启后保留上次输出并明确标记为已中断，成功回合自动进入待验收
- 面向个人使用的两种验收方式：用户直接验收，或发起 AI 验收
- 用户验收不要求额外验收人或说明；AI 不通过会自动退回执行
- 验收结论只能通过验收入口写入，状态变化与审计事件原子提交
- SQLite 本地任务库、离线缓存提示、旧 Demo 任务迁移和审计轨迹
- Electron 安全边界：context isolation、sandboxed preload、无 renderer Node 权限

## 环境要求

- macOS；Windows x64 仍处于未签名目录包适配与验收阶段
- Node.js 22 或更高版本
- 已安装并登录 Codex CLI 或 ChatGPT/Codex 桌面应用

## 本地开发

```bash
npm ci
npm test
npm run build
npm run pack
```

Windows x64 目录包使用 `npm.cmd run pack:win` 生成；运行控制、独立数据目录、备份恢复和未签名边界见 [Windows 目录版说明](docs/windows-portable.md)。`dist:win` 仅用于未来生成 NSIS 安装包，本阶段不运行。

Windows 真实 Codex 连接必须显式设置原生可执行文件 `CODEX_CLI_PATH` 和对应 `CODEX_HOME`。当前唯一固定支持版本为 `codex-cli 0.151.0-alpha.7.2`；其他版本会被预检拒绝。仅安装 Codex 桌面应用不等于独立 Workboard 已获得可用驱动或登录状态。

完整的真实 App Server 验收需要本机已登录 Codex：

```bash
npm run test:live
npm run test:create-thread
npm run test:flow
```

## 启动成品

Windows：按照 [Windows 目录版说明](docs/windows-portable.md) 使用受验证的 `workboard:start`、`workboard:status` 和 `workboard:stop`，并显式指定源码目录之外的数据与状态目录。当前目录包未签名、未安装，不代表正式发行。

macOS 双击：

`dist/mac-arm64/Codex Workboard.app`（Apple Silicon）或对应架构目录中的 `.app`

这是本地未签名的 1.0.0 正式功能版。若 macOS 首次阻止打开，可在 Finder 中右键应用并选择“打开”。它尚未做 Apple Developer ID 签名、公证和自动更新，因此不等同于可对外分发的商店版本。

生成用于 GitHub Release 的 DMG 和 ZIP：

```bash
npm run release:check
npm run dist:mac
```

发布产物仍为未签名版本；外部分发前建议配置 Apple Developer ID 签名与公证。

Codex Workboard 是社区项目，与 OpenAI 无隶属或官方背书关系。项目按 [MIT License](LICENSE) 发布。

---

## English

Author: new school

Codex Workboard is a local-first macOS desktop application currently being adapted to an unsigned Windows x64 directory build. Passing Windows source checks does not mean that the package has been generated, launched, or manually accepted.

### Features

- Three workflow stages: Planning, Execution, and Acceptance & Review
- A translucent blue desktop workspace with task metrics, a three-stage board, and a persistent acceptance panel
- Task creation with priorities, assignees, acceptance criteria, and project paths
- New tasks can select a project, model, reasoning effort, and speed tier; by default, Workboard creates and names a dedicated Codex conversation and sends the first task instruction immediately
- Tasks can instead link to an existing conversation or remain task-only records; cards support multi-select, batch stage changes, and individually audited batch acceptance
- Drag-and-drop workflow transitions and lane-specific substates
- Clickable Planning, Execution, and Acceptance & Review filters in the sidebar; selecting the current filter again restores the complete three-lane board
- Recoverable direct archiving from the task detail stage controls
- Per-lane ordering by the latest linked-conversation activity, with unlinked tasks placed last
- Explicit synchronization of all ten supported App Server source kinds across active and archived conversations
- A unified conversation catalog with automatic and manual classification, tags, notes, and conversion into tasks
- Deduplicated one-click conversion of every unlinked conversation into the three workflow stages; archive state, title actions, and review keywords determine the initial stage
- Read messages and continue conversations directly from the linked-conversation panel with shared model, reasoning, speed, and approval controls
- A live-execution panel with App Server models, model-supported speed tiers, reasoning effort, and approval presets for untrusted operations, on-request access, and full access
- New tasks use the same model, speed, reasoning, and approval controls; project selection shows business names and chooses each project's most active working directory
- Full access sends `approvalPolicy: never` and `sandboxPolicy: dangerFullAccess`; the UI warns and confirms before every launch, while later standard turns explicitly restore the workspace sandbox
- Protected operations display approval cards inside Workboard with decline, approve once, and allow for session actions; approval waits, completion, and failure trigger system notifications
- A notification center for pending approvals, blocked or rework tasks, acceptance work, and synchronization failures, with live counts and direct links to each handling surface
- Execution evidence is persisted to local SQLite; after an application restart, previous output remains visible and is marked interrupted, while successful turns move to pending acceptance
- Two acceptance modes for individual use: direct user acceptance or AI acceptance
- User acceptance requires no separate reviewer identity or note; failed AI acceptance returns the task to Execution
- Acceptance decisions can only be written through the acceptance controls, with state changes and audit events committed atomically
- Local SQLite task storage, stale-cache indicators, migration from the earlier demo database, and an audit trail
- Electron isolation with context isolation, a sandboxed preload, and no Node.js access in the renderer

### Requirements

- macOS; Windows x64 remains in unsigned directory-build adaptation and acceptance
- Node.js 22 or later
- An installed and authenticated Codex CLI or ChatGPT/Codex desktop application

### Local development

```bash
npm ci
npm test
npm run build
npm run pack
```

Use `npm.cmd run pack:win` for the Windows x64 directory build. See the [Windows portable guide](docs/windows-portable.md) for isolated data paths, verified start/status/stop control, backup and restore, and unsigned-build limitations. `dist:win` is reserved for a future NSIS build and is not part of directory-package acceptance.

On Windows, set an explicit native `CODEX_CLI_PATH` and the matching `CODEX_HOME`. The only currently pinned supported version is `codex-cli 0.151.0-alpha.7.2`; preflight rejects other versions. Installing the Codex desktop app alone does not prove that an independent Workboard process has a usable driver or authenticated home.

The complete live App Server checks require an authenticated local Codex installation:

```bash
npm run test:live
npm run test:create-thread
npm run test:flow
```

### Run the packaged application

On Windows, follow the [Windows portable guide](docs/windows-portable.md) and use the verified start, status, and stop commands with data and state directories outside the checkout. The current directory build is unsigned and uninstalled, and is not a formal release.

On macOS, open:

`dist/mac-arm64/Codex Workboard.app` on Apple Silicon, or the `.app` in the matching architecture directory.

Version 1.0.0 is currently distributed without Apple Developer ID signing, notarization, or automatic updates. If macOS blocks the first launch, right-click the application in Finder and choose **Open**.

Generate DMG and ZIP artifacts for a GitHub Release:

```bash
npm run release:check
npm run dist:mac
```

Configure Apple Developer ID signing and notarization before distributing the application to a wider audience.

Codex Workboard is an independent community project and is not affiliated with or endorsed by OpenAI. It is released under the [MIT License](LICENSE).
