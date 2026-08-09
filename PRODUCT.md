# Codex Taskboard Demo

## Register

- Product: local macOS desktop container
- Renderer platform: web UI inside Electron
- Delivery: standalone `.app`, not a browser preview and not a patch to the Codex application
- Primary user: an individual Codex power user coordinating several long-running tasks

## Purpose

Turn scattered Codex conversations into a task-driven workflow. Tasks are the durable source of truth; Codex conversations remain the execution record and can be read and continued from the task.

## Positioning

The board is a local coordination layer over the official Codex App Server protocol. It never edits Codex's internal databases or injects code into the installed Codex application.

## Core workflow

1. Capture a task in `计划中`, optionally as an idea.
2. Link it to an existing Codex conversation.
3. Move it to `执行`, assign an executor, and continue the linked conversation.
4. Move it to `验收和回顾` with explicit acceptance criteria.
5. An independent auditor accepts it, asks for rework, or closes it with a review note.

## Principles

- Task first: every execution should have a visible task and outcome.
- Traceable: task, conversation, state changes, and review notes stay linked.
- Independent acceptance: an executor cannot accept their own work.
- Local first: task metadata remains on this Mac.
- Recoverable: app failure must not corrupt or rewrite Codex conversation storage.
- Honest states: planning, running, blocked, rework, accepted, and closed are distinct.

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

