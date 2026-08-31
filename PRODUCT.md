# Codex Workboard

## Register

- Product: local-first macOS desktop workboard, version 1.0
- Renderer platform: web UI inside Electron
- Delivery: standalone `.app`, not a browser preview and not a patch to the Codex application
- Primary user: an individual Codex power user coordinating several long-running tasks

## Purpose

Turn scattered Codex conversations into a task-driven workflow. Tasks are the durable source of truth; Codex conversations remain the execution record and can be read and continued from the task.

## Positioning

The board is a local coordination layer over the official Codex App Server protocol. It never edits Codex's internal databases or injects code into the installed Codex application.

## Core workflow

1. Capture a task with an explicit logical project. The selector shows one business project per item rather than every historical conversation folder; each project maps to its primary working directory. By default, create and name a dedicated Codex conversation, persist the selected model, reasoning effort, speed, and approval policy, send the task as the first turn, and expose it immediately on the board; linking an existing conversation or creating a task-only record are explicit alternatives.
2. Keep the generated or selected conversation linked to the task.
3. Move it to `执行`, assign an executor, and continue the linked conversation.
   Before launch, choose a model, model-supported speed tier, reasoning effort, and approval policy. During execution, follow the live plan, agent progress, command output, file changes, elapsed time, and approval requests inside Workboard.
   Full access is an explicit high-risk preset that disables approvals and the sandbox for that turn. It must show an inline warning, require confirmation on launch, persist in the execution snapshot, and never leak into a later standard turn.
4. Move it to `验收和回顾` with explicit acceptance criteria.
5. The user accepts it directly or launches AI acceptance; a failed acceptance returns the task to execution.

## Conversation catalog

- Enumerate every supported Codex App Server source kind, for both unarchived and archived tasks.
- Keep a local cache for resilience; visibly identify stale-cache mode when a live sync fails.
- Auto-classify new conversations by title, preview, project path, and source metadata.
- Preserve manual categories, tags, and notes across later syncs.
- Tombstone conversations missing from a successful full sync without deleting local metadata.

## Principles

- Task first: every execution should have a visible task and outcome.
- Traceable: task, conversation, state changes, and review notes stay linked.
- User authority: the sole user can accept their own work without entering a separate reviewer identity or note.
- Optional AI acceptance: Codex reviews linked evidence against explicit criteria; failure returns the task to execution.
- Local first: task metadata remains on this Mac.
- Recoverable: app failure must not corrupt or rewrite Codex conversation storage.
- Honest states: planning, running, blocked, rework, accepted, and closed are distinct.
- Live by default: task progress is observable without switching back to Codex; the Codex app remains a full-history and troubleshooting fallback.
- Direct conversation: the linked-conversation tab is a working chat surface with shared model, reasoning, and approval controls; active replies and approval waits remain visible beside message history.
- Conversation continuity: completion and rework never lock a non-terminal task's composer. A saved task or execution-snapshot thread ID is sufficient to continue; a temporarily missing directory summary may hide history, but must not block sending.
- Historical continuation: before every follow-up, resume the persisted thread through App Server. If and only if App Server confirms the thread no longer exists, create a named continuation thread, relink the task, retain an audit event, and submit the user's message there.
- Conversation by default: task creation starts a dedicated named Codex thread unless the user explicitly selects an existing thread or a task-only record.
- Real speed tiers: speed choices come from each model's App Server `serviceTiers`, and the selected `serviceTier` persists with execution evidence.
- Recoverable execution: interrupted sessions retain their last plan, output, and diff instead of pretending to still be live after restart.
- Direct manipulation: sidebar workflow rows filter the board by lane, and the task detail stage area includes a recoverable archive action.
- Batch operations: card checkboxes support selection across the visible board, governed bulk lane changes, and user batch acceptance for review-stage tasks with one audit event per task.
- Conversation-aware ordering: each lane can sort by the linked Codex conversation's latest update time, with unlinked tasks placed last.
- Actionable notifications: the top-bar bell is a pending-work center for approvals, execution risks, reviews, and sync failures; every task notification deep-links to its handling surface.
- Routine hygiene: daily maintenance syncs conversations, creates missing task cards, preserves manual classification, and archives only accepted or closed terminal tasks.

## Personality

Restrained, native, calm, and operational. It should feel closer to a macOS productivity tool than a promotional AI dashboard.

## Avoid

- Browser-preview delivery
- Fake thread data presented as real Codex data
- Direct reads or writes to private Codex SQLite/session files
- Decorative gradients, oversized cards, or playful agent mascots
- Color-only status communication
- Automatic acceptance by the executor

## Accessibility

- WCAG AA contrast for text and controls
- Full keyboard operation for creation, navigation, and review
- Visible focus states
- Status labels in text as well as color
- Reduced-motion friendly; no decorative animation
