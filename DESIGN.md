# Design Direction

## Scene

A macOS knowledge worker under neutral office light scans many parallel tasks without visual noise.

## Visual language

- Familiar three-pane desktop layout: navigation, board, contextual task/conversation panel.
- White canvas, quiet cool-gray navigation, hairline dividers, almost no shadows.
- Indigo-violet is a small navigational accent, not the visual subject.
- Amber communicates active execution; teal communicates independent review.
- System typeface and compact spacing keep the product dense but readable.

## Tokens

```css
--bg: oklch(1 0 0);
--surface: oklch(0.975 0.004 294);
--sidebar: oklch(0.965 0.006 294);
--ink: oklch(0.20 0.015 294);
--muted: oklch(0.48 0.012 294);
--line: oklch(0.90 0.006 294);
--primary: oklch(0.50 0.12 294);
--primary-soft: oklch(0.94 0.028 294);
--execution: oklch(0.68 0.14 74);
--execution-soft: oklch(0.96 0.035 80);
--review: oklch(0.56 0.10 174);
--review-soft: oklch(0.96 0.026 174);
--danger: oklch(0.56 0.18 27);
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

