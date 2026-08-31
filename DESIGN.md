# Design Direction

## Scene

A macOS knowledge worker scans many parallel Codex tasks in a bright, cool-blue operations cockpit. The visual reference is an airy enterprise task manager with summary metrics, a central workflow, and a persistent intelligence panel.

## Visual language

- Familiar three-pane desktop layout: navigation, board, contextual task/conversation panel.
- Icy blue-gray canvas with cyan, mint, and violet light fields behind translucent white hierarchy surfaces.
- Purposeful glass: 46–76% translucent fills, 14–32 px backdrop blur, subtle saturation, bright inset edge highlights, hairline dividers, and compact shadows only where elevation communicates layering.
- Clear blue is the primary action and navigation accent.
- Cyan communicates planning, mint communicates active execution, violet communicates accepted work, and coral communicates blockers or rework.
- System typeface and compact spacing keep the product dense but readable.
- Top metrics answer workload health at a glance; they are operational summaries, not decorative cards.
- The right panel has three stable layers: task properties, live execution, and linked conversation. Live execution uses semantic status, compact controls, approval cards, plan steps, terminal output, and file diffs without changing the established icy-glass shell.
- The new-task project control lists logical business projects, not raw historical working folders. A secondary line exposes the mapped working directory so the user can verify where Codex will start.

## Tokens

```css
--bg: oklch(1 0 0);
--surface: oklch(0.974 0.012 238);
--sidebar: oklch(0.958 0.018 238);
--ink: oklch(0.24 0.025 246);
--muted: oklch(0.51 0.025 246);
--line: oklch(0.89 0.018 238);
--primary: oklch(0.61 0.18 253);
--primary-soft: oklch(0.94 0.038 246);
--execution: oklch(0.72 0.14 165);
--execution-soft: oklch(0.95 0.045 165);
--review: oklch(0.62 0.15 294);
--review-soft: oklch(0.95 0.035 294);
--danger: oklch(0.56 0.18 27);
--glass: oklch(1 0 0 / .58);
--glass-strong: oklch(1 0 0 / .76);
--glass-line: oklch(1 0 0 / .72);
```

## Geometry

- Sidebar: 236 px
- Board columns: minimum 286 px, equal width
- Context panel: 380 px when open
- Page padding: 20 px
- Grid gap: 12 px
- Control height: 32–36 px
- Card radius: 10 px
- Control radius: 8 px
- Borders: 1 px

## Interaction

- Dragging changes only the main lane; governed substatus is derived by the state machine.
- Clicking a card opens its task details and linked Codex conversation in the right panel.
- A running or approval-blocked task opens directly on `实时执行`; model and reasoning controls lock during the active turn, while approval choices remain explicit and keyboard reachable.
- A newly created conversation exposes the same approval presets as later turns. JSON-RPC request id `0` is valid and must remain actionable.
- Selecting `完全访问权限` reveals a compact coral warning directly below the controls; launch requires a native confirmation dialog, while ordinary policies restore the workspace sandbox explicitly.
- Review actions remain visible and offer two clear modes: direct user confirmation or optional AI acceptance with automatic rework routing.
- The linked-conversation tab keeps message history scrollable and anchors a direct-reply composer with model, reasoning, and approval controls; live replies appear inline while deeper execution evidence stays one tab away.
- A missing conversation-directory summary is represented as `对话待同步`, not `未关联`. The composer remains available from the durable thread ID after completion or rework; only an active turn, terminal task, or truly absent thread ID disables it.
- Submission errors use user-facing Chinese copy rather than Electron IPC wrappers. Automatic continuation recovery is reported as a success with an explicit note that a new continuation conversation was created.
- The create-task flow is a focused modal with title first. Project selection is explicit. `新建会话` is the default, while `关联已有` and `仅创建任务` remain explicit alternatives; model, reasoning effort, and supported speed tier appear whenever a conversation is used.
- Task cards stay clean by default. An explicit `多选` mode reveals native checkboxes and a compact governed action bar for select-all, clearing, three-stage migration, and review-only batch acceptance; completing an action exits the mode.
- The bell opens a compact, keyboard-dismissable pending-work menu. Its count reflects unresolved items rather than unread history, and each row opens the relevant task or retries synchronization.
