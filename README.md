# Codex Workboard

作者：new school

一个本地优先的 macOS 桌面工作台，用任务看板组织本机 Codex 对话。它通过官方 `codex app-server` 读取和继续对话，不修改 Codex 应用，也不直接访问 Codex 的内部数据库。

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
- 受保护操作直接在 Workboard 显示审批卡，可批准一次、在本次会话允许或拒绝；审批、完成和失败会触发 macOS 通知
- 右上角通知中心汇总等待审批、阻塞/返工、待验收和同步异常；数量实时更新，点击通知直接进入对应处理位置
- 执行证据持久化到本地 SQLite；应用重启后保留上次输出并明确标记为已中断，成功回合自动进入待验收
- 面向个人使用的两种验收方式：用户直接验收，或发起 AI 验收
- 用户验收不要求额外验收人或说明；AI 不通过会自动退回执行
- 验收结论只能通过验收入口写入，状态变化与审计事件原子提交
- SQLite 本地任务库、离线缓存提示、旧 Demo 任务迁移和审计轨迹
- Electron 安全边界：context isolation、sandboxed preload、无 renderer Node 权限

## 环境要求

- macOS
- Node.js 22 或更高版本
- 已安装并登录 Codex CLI 或 ChatGPT/Codex 桌面应用

## 本地开发

```bash
npm ci
npm test
npm run build
npm run pack
```

完整的真实 App Server 验收需要本机已登录 Codex：

```bash
npm run test:live
npm run test:create-thread
npm run test:flow
```

## 启动成品

双击：

`dist/mac-arm64/Codex Workboard.app`（Apple Silicon）或对应架构目录中的 `.app`

这是本地未签名的 1.0.0 正式功能版。若 macOS 首次阻止打开，可在 Finder 中右键应用并选择“打开”。它尚未做 Apple Developer ID 签名、公证和自动更新，因此不等同于可对外分发的商店版本。

生成用于 GitHub Release 的 DMG 和 ZIP：

```bash
npm run release:check
npm run dist:mac
```

发布产物仍为未签名版本；外部分发前建议配置 Apple Developer ID 签名与公证。

日常使用时不需要回到 Codex 预览执行过程；只有需要查看完整历史或深度排障时，才从“关联对话”打开 Codex。

## 边界

当前版本是在独立 macOS 窗口中承载 Codex 任务工作流，并通过 App Server 接入对话能力。它不会把“任务看板”按钮注入官方 Codex 的侧栏；那一步依赖官方扩展入口，或需要承担每次升级后重新适配的非官方注入风险。

Codex Workboard 是社区项目，与 OpenAI 无隶属或官方背书关系。项目按 [MIT License](LICENSE) 发布。
