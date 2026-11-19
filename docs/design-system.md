# Interview Runner design system

Status: runner screens and controls use the shared component catalogue and semantic roles. Calendar day targets are 44px tall but narrower than 44px in the Library sidebar: seven non-overlapping columns fit the available width so the whole week remains visible.

## Principles and research

Preserve the learner's place, choices and work. Keep controls predictable across coding, reading, recall and whiteboard drills; expose state in words as well as color. Prefer a small set of configurable primitives over screen-specific variations. Design for keyboard, screen readers and 320–360px as well as desktop.

### Evidence and application

- [Exercism online editor](https://exercism.org/docs/using/solving-exercises/using-the-online-editor) describes an editor beside instructions, with test results alongside and submission after passing. **Inference:** keep question, editor and result contexts close without hiding user-selected panels.
- [Codecademy accessibility](https://help.codecademy.com/hc/en-us/articles/360056641953-Accessibility-Guide) describes named pane regions, keyboard escape from the editor, and narrated checkpoint results; its [lessons and projects](https://help.codecademy.com/hc/en-us/articles/14298560842267-How-Lessons-and-Projects-Differ-in-Codecademy-s-Learning-Environment) distinguishes automatically checked lessons from manually checked projects. **Inference:** label workspace regions and distinguish automatic test results from learner-marked milestones.
- [Anki studying](https://docs.ankiweb.net/studying.html) presents a question before its answer and provides keyboard shortcuts. **Inference:** keep recall questions and deliberate hold-to-reveal; do not copy Anki's immediate reveal interaction.
- [Readwise Reader](https://docs.readwise.io/reader/docs) describes customizable reading, annotation and synced highlights. **Inference:** preserve reading measure, theme preferences and highlight recovery.
- [Primer empty states](https://primer.style/product/ui-patterns/empty-states/) recommends a concise explanation and useful next action; [Primer saving](https://primer.style/product/ui-patterns/saving/) recommends clear feedback and preserving data after failure. **Inference:** empty, error, saving and conflict are distinct states, not interchangeable placeholders.
- [Mantine colors](https://mantine.dev/theming/colors/) exposes indexed palette shades as CSS variables; [Primer ActionMenu](https://primer.style/product/components/action-menu/) supports actions from a button or icon button; [Radix Tooltip](https://www.radix-ui.com/primitives/docs/components/tooltip) opens on focus and hover. **Inference:** use semantic roles over palette values, direct Mantine menus, and named icon buttons with focusable tooltips.

### Additional independent research

- [LeetCode's question workspace](https://support.leetcode.com/hc/en-us/articles/360012016874-Start-your-Coding-Practice) describes separate Run and Submit actions, a question picker and a collapsible results console. [HackerRank's candidate IDE](https://candidatesupport.hackerrank.com/articles/9623161883) describes question navigation, explicit panel controls and distinct hidden test cases. **Inference:** distinguish run from submit, make result states legible, and preserve explicit panel choices.
- [Primer PageLayout](https://primer.style/product/components/page-layout/) documents controlled or persisted resizable panes and double-click reset; [Primer IconButton](https://primer.style/product/components/icon-button/) requires a name and recommends a tooltip. **Inference:** provide a controlled keyboard-operable separator and reusable labeled icon control. Do not copy the supplement's proposed automatic mobile collapse: it conflicts with this runner's user-choice invariant.
- [Educative's exercise widget](https://www.educative.io/courses/author-guide/7nQ59AoO5gw) describes per-test results and author-enabled solutions; [RemNote](https://help.remnote.com/en/articles/6022755-getting-started-with-spaced-repetition) describes reveal-then-rate recall. **Inference:** treat results and recall as distinct domain experiences. The supplement's generic immediate-reveal proposal is intentionally not adopted: this runner requires deliberate hold-to-reveal.
- [Atlassian color guidance](https://atlassian.design/foundations/color) separates semantic roles from focus/selection and calls for non-color cues; [Radix color aliasing](https://www.radix-ui.com/colors/docs/overview/aliasing) recommends semantic aliases. **Inference:** use light/dark role tokens and keep selection distinct from focus.

The supplement did not verify LeetCode timer placement, persistence on LeetCode or HackerRank, Brilliant's interactive layout or Kindle's exact toolbar; do not treat these as requirements.

## Tokens

Roles are backed by Mantine 7 palette variables in `src/ui/tokens.css`; component styles consume roles, not shade numbers. Ratios below are WCAG contrast ratios calculated from Mantine's default palette; text requires 4.5:1 and control/focus boundaries 3:1. Canvas/surface and raised/hover are hierarchy, not guaranteed control boundaries. The gray.4 border is decorative on light surfaces and must not be the only indication of an interactive control. Use a stronger control boundary or text/icon cue. Focus must contrast against its adjacent surface, including when offset from a filled control.

| Role | Light | Dark | Text contrast light / dark |
| --- | --- | --- | --- |
| canvas | white | dark.9 | text 15.43 / 16.56 |
| surface | gray.0 | dark.7 | secondary text 7.76 / 9.37 |
| raised / hover | gray.1 / gray.2 | dark.6 / dark.4 | — |
| border | gray.4 | dark.2 | 1.42 on gray.0 / 4.04 on dark.7; light is decorative only |
| text / secondary | gray.9 / gray.7 | gray.1 / dark.0 | see canvas / surface |
| accent, link, focus | blue.9 | blue.3 | 6.09 on white / 7.90 on dark.7 |
| primary button | white on blue.8 | gray.9 on blue.3 | 5.02 / 7.85 |
| selected background / foreground | blue.0 / blue.9 | blue.9 / blue.0 | 5.48 / 5.48 |
| success | gray.9 on green.0 | green.3 on dark.4 | 14.37 / 6.81 |
| warning / highlight | gray.9 on yellow.1 | yellow.3 on dark.4 | 13.83 / 7.71 |
| danger | red.9 on red.0 | red.3 on dark.4 | 5.10 / 5.46 |
| info | blue.9 on blue.0 | blue.3 on dark.4 | 5.48 / 5.11 |

Highlight also needs an underline or other non-color cue. Manrope is the UI font, JetBrains Mono the code font. Body sizes are 12/14/16/18/20px; headings are 28/20/16/14px, expressed in rem. Primary UI copy is at least 14px; 12px is for metadata. Reading measure is 46rem. Spacing xs/sm/md/lg/xl is .25/.5/1/1.5/2rem. Radius is 4px small, 8px default, 12px emphasized panel, and full pill. Panels are flat and bordered; overlay surfaces use `--ir-shadow-overlay`: a semantic border ring and Mantine shadow-md in light, shadow-lg in dark. The ring keeps popover and menu edges visible against dark surfaces.

Selection uses `--ir-color-selected-bg` and `--ir-color-selected-fg`, distinct from focus. Selected Library rows, lessons and palette options also have a left bar and/or weight cue; selected controls keep a contrasting focus ring.

Layer tokens: base 0, sticky 100, floating controls 200, popover 300, modal 400, tooltip 500, drag/resize overlay 600. Coverage rail, resize overlays, Library drag preview, map controls, popovers and tooltips use these roles. Local numeric layers remain for the split separator, category and row controls/insertion guides, Library resize handle and map frame; they order elements within their own component rather than competing with global overlays. Whiteboard controls use local layers 1/4/5 over Excalidraw, whose own stacking belongs to the third party. Map menus/popovers change portal behavior in fullscreen; Mantine portals and the native diagram dialog's top layer remain separate stacking contexts. A token alone cannot overcome a parent stacking context. Motion is 150ms standard, 200ms panel, ease-out; remove nonessential transitions under reduced motion. A visible 2px focus ring with offset is shared across controls.

## Component catalogue

All shared controls live in `src/ui` and accept native props/ref as applicable. Open `/design-system` directly or use “Open design system gallery” in the command palette to inspect them without leaving the current workspace. Mantine remains direct for Group, Popover, Alert, Modal and Menu; do not add generic wrappers or a Toolbar, CountBadge or PopoverShell.

| Component | API / variants | Use / do not use | Why |
| --- | --- | --- | --- |
| Button | primary, secondary, subtle, accent, danger; sm/md; loading, disabled, left/right icons | Named action; accent is a filled contextual action distinct from adjacent tools, not an ordinary default | Consistent action hierarchy; both sizes have 44px target |
| IconButton | required label and icon; primary, secondary, subtle, accent; optional tooltipPosition and tooltipWithinPortal for native dialogs, tooltipDisabled while a related overlay is open | Compact named action; accent distinguishes a contextual action from adjacent tools | 44px target, accessible name, hover/focus tooltip; one button usable as a menu target |
| StatusBadge | visible text; neutral, success, warning, danger, info; sm/md; rich responsive text requires an accessible label | Short non-interactive state or count; not an action | State is explicit in text, not color alone |
| Panel | label or labelledBy; padding none/sm/md; optional scrollable; region, complementary, group or article role | Bounded region, reading article or question group; not an overlay | Flat, named work surface; scrollable panels are keyboard-focusable by default |
| PanelHeader | title, headingLevel, actions, optional expanded/onToggle/controlsId and accessible toggle label | Region heading and optional explicit toggle; not navigation | Shared structure without changing panel visibility |
| EmptyState | title, description, one optional action; compact/panel | Empty or first-run content; not an error | Explain a useful next step |
| SaveStatus | saving, saved, local-only, error, conflict; text and optional recovery actions | Present status and choices; not persistence logic | Polite status without silently losing local work |
| SplitPane | controlled value/onChange, min/max and resetValue, valueSide first/second, label, optional controlsId, two children, orientation and explicit visiblePane for existing tab layouts | User-resizable workspace; not automatic collapse | Keyboard and pointer resizing; stable children preserve iframe state |
| WorkspaceHeader | title, headingLevel, leading/titleActions, optional context, timer and action slots, optional slot classNames | Workspace identity and actions; not application navigation | Responsive wrapping |
| TimerDisplay | remaining in milliseconds, running/paused/expired state, accessible label, optional actions and controlled announcement | Countdown in workspace header; not a per-second live region | Preserve countdown appearance and announce discrete milestones only |

`HoldForHint`/`MilestoneHint` remain domain components. Preserve the existing deliberate pointer and keyboard hold; do not add an immediate reveal path.

### Choosing a button

Use at most one **primary** action per local context: the principal next step (for example, Save or Start attempt). Use **secondary** for ordinary alternatives (Cancel, Load latest, Keep mine), **subtle** for low-emphasis contextual actions (Copy or Close review), **accent** for a filled contextual action that must stand apart from adjacent tools (Highlights), and **danger** for destructive actions or confirmations. Accent uses the high-contrast primary foreground and the stronger filled primary role, reversing the primary hover colors; it is not an ordinary default. Both Reset chapter and Reset coverage use danger and ask for confirmation; never imply that reset is reversible if it is not.

### Form controls

Use Mantine TextInput, Select, Checkbox and Switch directly with theme defaults. Give each a visible label or an `aria-label`, accessible error text, a visible focus ring and a minimum 44px interactive height; keep input text and placeholders legible against their surfaces. Group related controls and describe constraints before submission.

## Workspace layout

Use WorkspaceHeader as the header bar, SplitPane for persistent adjacent regions, Panel/PanelHeader for question, milestones and results, and Mantine Group for toolbars. Sticky drill and map headers match the page surface in both themes and have balanced vertical padding; their opaque background prevents scrolling content from showing through. Header buttons, status choices and badges keep their natural width and do not wrap or truncate their contents; wrap whole metadata and action groups when space is insufficient. WorkspaceHeader titles normally wrap on narrow screens; desktop drill headers may ellipsize after allowing roughly 12rem, and drill titles at 24rem or less also ellipsize, retaining their full accessible name. At desktop, show adjacent panes with independent scrolling and a keyboard-operable divider. At 360px (and 320px), wrap header actions and timer without clipping, preserve scroll access and stack or tab content only where existing behavior requires it. **Never auto-collapse or alter the user's open Library sidebar, lessons, chapters or question panel.** Keep the milestones panel, hold-for-hint and header countdown. Layout changes must not remount the coding iframe.

Map highlight snippets use an indented, token-bordered quote treatment. Their overlaid subtle delete IconButton retains its 44px target and an excerpt-specific accessible name; reserve space so text does not run beneath it.

## State and accessibility

- Loading: identify the region and announce meaningful progress without repeating rapid updates.
- Empty: explain what is absent and offer at most one useful action. First-run: explain purpose and how to start, without implying failure.
- Error: use Mantine Alert with specific plain-language cause and recovery where possible; preserve work. Stale results: explain which revision they describe and offer a fresh run.
- Saving: show saving/saved/local-only truthfully. Conflict: preserve local work and offer explicit choices, never an implicit overwrite. Announce state changes politely, not every timer tick.
- Controls need 44×44px targets, clear accessible names, keyboard support and a visible 2px focus ring. Icon button tooltips appear on focus as well as hover and are not the only accessible label. Maintain text ≥4.5:1 and control/focus contrast ≥3:1; do not rely on color alone. Honor `prefers-reduced-motion`.

Example copy and recovery: “Loading workspace…” while starting; “Tests have not run since this drill changed” with **Run tests** for stale results; “Could not save. Your work is still local” with **Retry** after a save failure; “Changed elsewhere” with **Load latest** and **Keep mine** for a conflict. For a destructive confirmation, say what will be reset and offer **Cancel** and a clearly named danger action. Preserve local work until the user explicitly chooses otherwise.

## Enforcement and change process

Use `src/ui` components and `--ir-*` roles for new UI. `npm run lint` retains seed lint and enforces UI restrictions; the pre-commit hook runs it. The import ratchet in `tools/ui-lint/eslint.config.mjs` is empty. `scripts/check-ui-css.mjs` checks CSS files and is shared by the JSX inline-style and embedded-style rules; it counts justified literals: light/dark syntax highlighting, fixed print colors, and the two-color coverage viewport marker (which must contrast with every rail color), plus the translucent native diagram-dialog backdrop and the atlas image's light backing. SVG geometry and third-party styling require explicit review. Do not prohibit Mantine Tooltip outside icon buttons merely because it has other legitimate uses.

The coverage rail's four deliberately distinct attention colors still reference Mantine palette shades directly; their 3:1 contrast is tested separately. Some authored cheatsheet/diagram integration styles and legacy fallback declarations also retain Mantine theme variables; print overrides must stay independent of the screen theme. These are not new shared control roles.

Exceptions: narrow calendar days are 44px tall but may be narrower to keep all seven non-overlapping targets visible; print and syntax colors, the coverage viewport marker and atlas image backing, and the translucent native dialog backdrop use the counted literals above; Excalidraw owns its third-party internal stacking. Document and justify any new exception here before adding it to an enforcement allowlist.

The lint workspace pins the JavaScript TypeScript 6 compiler required by `typescript-eslint`; the runner uses TypeScript 7. A separate root `ts-api-utils` version prevents npm from hoisting the lint workspace's TypeScript-6-dependent version against TypeScript 7. Install from the root with `npm ci`; do not use `--legacy-peer-deps`. The Containerfile's manifest-only install needs only runtime/build tools, not the lint workspace.

Prefer extending an existing component's props before introducing a component or variant. A new component or variant requires its justification and usage/non-usage here, a gallery entry, focused tests and responsive/keyboard/accessibility verification in light and dark themes. Keep the gallery representative of the actual implementation; do not make a gallery example an excuse to duplicate a primitive.
