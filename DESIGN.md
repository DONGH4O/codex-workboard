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
- The right panel combines task properties, linked conversation, intelligent acceptance prompts, and independent audit actions.

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
- Review actions remain visible and require an auditor identity different from the executor.
- The create-task flow is a focused modal with title first and advanced fields progressively disclosed.
