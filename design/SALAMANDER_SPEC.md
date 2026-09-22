# Salamander design language — implementation spec

Source of truth: the user's Design canvas (refined over several review rounds). This file is the
distilled, final version of it. Where this spec and the old v1 tokens in the code disagree, this spec wins.
All visible UI text stays lowercase (REQUIREMENTS §3.4). The design canvas lives at
https://claude.ai/artifact/LPBwdCTCqs6KPXkgi3gV3G (you do not need to open it).

## 1. Tokens

Two themes. Theme mode is `auto | light | dark` (auto = follow `prefers-color-scheme`), persisted in
`chrome.storage.local` under key `themeMode`, default `auto`, and applied live to every extension surface
(sidebar, add mode, modal) — including when the OS setting flips or another tab changes the stored mode.

| token        | light                  | dark                        | use |
|--------------|------------------------|-----------------------------|-----|
| bg           | #FFFCF5                | #14120D                     | sidebar background, panel grounds |
| surface      | #FFFFFF                | #1D1A13                     | cards, comment box, inputs, secondary buttons |
| raised       | #F6F1E4                | #2A261C                     | subtle fills |
| line         | #EAE3D2                | #3A3427                     | 1px borders, dividers |
| lineStrong   | #CFC5AE                | #56503F                     | hover borders |
| text         | #1A1712                | #FBF6EA                     | primary text |
| muted        | #6E6656                | #B3AA96                     | secondary text, placeholders, counter |
| accent       | #FEC800                | #FEC800                     | brand yellow fills (matches icons/logo-button.svg) |
| accentHover  | #FFD740                | #FFD740                     | primary hover |
| accentPress  | #E8B600                | #E8B600                     | primary press |
| onAccent     | #1A1712                | #1A1712                     | text/icons on yellow |
| accentIcon   | #E8B600                | #FEC800                     | a yellow icon on a neutral surface (the add-note glyph at rest) |
| accentInk    | #1A1712                | #FEC800                     | "save" text-button colour at rest (black in light, yellow in dark) |
| hover        | #F6F1E4                | #2A261C                     | ghost/secondary hover fill |
| press        | #ECE4D1                | #353024                     | ghost/secondary press fill |
| focus        | #1A1712                | #FBF6EA                     | focus ring colour |
| danger       | #B42318                | #FF7A6B                     | delete text, error text, counter ≥980 |
| dangerSoft   | #FDE7E4                | rgba(255,122,107,0.14)      | delete button fill, error banner |
| dangerHover  | #FBD2CC                | rgba(255,122,107,0.24)      | |
| dangerPress  | #F6BAB1                | rgba(255,122,107,0.34)      | |
| warn         | #8A5A00                | #F5C35B                     | warning banner text/icon |
| warnSoft     | #FFF1CC                | rgba(245,195,91,0.12)       | warning banner fill |
| scrim        | rgba(26,23,18,0.42)    | rgba(0,0,0,0.5)             | add-mode dimming outside the selection |
| backdrop     | rgba(20,18,13,0.55)    | rgba(0,0,0,0.65)            | modal backdrop |
| shadowPop    | 0 18px 40px rgba(0,0,0,0.28) | same                  | comment box, modal panel |
| shadowNote   | 0 10px 28px rgba(0,0,0,0.18), 0 0 0 1px {line} | same | hovered note text background |

Radii: sm 6 (badges, tags), md 10 (buttons, thumbnails, banners, note-hover bg, selection box), lg 14 (comment box, modal panel).
Rounded rectangles everywhere — never pill shapes.

Type (bundled, no network): display = Instrument Serif *italic* 400 (wordmark "salamander" 22px, modal title);
body = Instrument Sans 400/500/600/700 (13px default, 12px small, 12px/600 section headings);
mono = JetBrains Mono 400/500/600 (numbers: badges, counter). Always fall back to a system stack.

Icons: 1.8px stroke, round caps/joins, `currentColor`, 16px in 36px buttons (close: 18px in 32px).
plus: `M12 5v14M5 12h14` · export: `M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14` · import: `M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19h14`
close: `M6 6l12 12M18 6L6 18` · error: circle r9 + `M9 9l6 6M15 9l-6 6` · warning: circle r9 + `M12 7.5v5.5M12 16.5v.01`.
Theme toggle icons: sun / moon / half-circle (auto) in the same stroke style.

Logo: `icons/logo-button.svg` (yellow, 42×24 viewBox) in dark theme; a black copy
`icons/logo-button-black.svg` (same file, every `#FEC800` → `#1A1712`) in light theme. Shown at 35×20, no tile/background.

## 2. Interaction states (every interactive control)

States: regular · hover · press · focus-visible (keyboard) · disabled.
- focus ring (all controls unless noted): `box-shadow: 0 0 0 2px {bg}, 0 0 0 4px {focus}` — only on `:focus-visible`.
- press: the press fill, and NOTHING else — no scale, no movement, in any control on any surface.
  (A press scale moved the half of a two-half control that was not being pressed, and on the export
  group it slid the open menu out from under the pointer between mousedown and mouseup so the click
  landed on the panel instead of the menu item. Per-half scaling is no answer either: it tears the
  border the two halves share. `PRESS_SCALE_CSS` is retired from `src/theme.ts` so it cannot return.)
- disabled: `opacity: 0.4; cursor: default`, no hover/press.
- transitions: 120–160ms ease-out on background/border/colour.

| control | regular | hover | press | focus-visible |
|---|---|---|---|---|
| primary (add note) | accent fill, onAccent text, 600 | accentHover | accentPress | accent + ring |
| secondary (text/icon, e.g. export/import) | surface fill, 1px line border, text | hover fill, lineStrong border | press fill, lineStrong | ring |
| ghost (close, theme toggle) | transparent, muted | hover fill, text colour | press fill, text colour | ring, text colour |
| danger (modal delete) | dangerSoft fill, danger text 600 | dangerHover | dangerPress | ring |
| save (text button inside comment box) | transparent, accentInk, 700 | accent fill, onAccent | accentPress fill, onAccent | accent fill, onAccent + inset 2px focus ring |
| cancel (text button inside comment box) | transparent, muted, 500 | hover fill, text | press fill | inset ring |
| save disabled (empty note) | muted text, opacity .5 | — | — | — |

## 3. Components

### 3.1 Sidebar (docked right, resizable 100–300px — keep the existing resize/page-shrink machinery)
- Background `bg`, 1px `line` left border, no heavy shadow.
- Header row (56px, padding 0 10px 0 16px, gap 10): logo (35×20) · wordmark "salamander" (display italic 22px) grows · theme toggle (ghost 32px, cycles auto → light → dark, aria-label/title describe the *current* mode, e.g. "theme: auto") · close (ghost 32px).
- Action row (padding 4px 16px 16px, gap 8): primary "add note" button (36px tall, flex-grow, plus icon + label) · export and import as secondary icon buttons (36×36).
- Narrow widths: when the sidebar is too narrow for this (<~220px), the wordmark hides and "add note" becomes icon-only (keep aria-label "add feedback"/existing labels). At the 100px minimum everything must still be reachable without overflow (wrap the action row to a column if needed).
- Section heading: "this page (n)" — 12px / 600 / muted, plain text, n = item count. Shown only when there is at least one item; otherwise show the empty state instead.
- Empty state: centred muted 13px "no feedback on this page yet".
- Note list: padding 0 16px, gap 16. Each item = a real `<button>` (keep role/labels/keyboard behaviour the tests rely on):
  - thumbnail: full width, 100px tall, radius md, overflow hidden, background `raised`, screenshot `object-fit: contain` (never crop).
  - number badge on top-left of the thumbnail (8px inset): accent fill, onAccent, mono 11px/600, 20px tall, radius sm.
  - note text below (gap 8): 13px/1.4, clamped to 3 lines (`-webkit-line-clamp: 3`), padding 8px 10px, radius md, transparent background. Empty note → italic muted "no note".
  - NO card/box around the item (no box-inside-box).
  - hover/focus: dock magnification (section 4). The hovered item's note text gets `surface` background + `shadowNote`; the note background is never wider than the thumbnail. The thumbnail never gets a background.
  - focus-visible: ring around the thumbnail; the note gets the hover background.
- Notification banners (replace the black bar + countdown): inline banner under the action row, margin 0 16px 12px, radius md, padding 10px 12px, 12.5px/1.4, icon 16px + text. error = dangerSoft/danger, warning = warnSoft/warn. Keep `role="alert"`, the 8s auto-clear and all existing copy byte-exact. A subtle 2px progress line along the banner's bottom (same colour as text, 30% opacity) may replace the countdown bar.
- Resize handle: keep behaviour; restyle to a 1px `line` hairline that turns `accent` on hover/drag/focus.

### 3.2 Add mode
- Scrim outside the selection: `scrim` token.
- Selection box: radius md (10px), outline = a 2px line outside the box alternating 4px accent and 4px ink (see §Z; reads on light and dark pages). NO visible square handles.
- Resize from ANY edge or corner: invisible hit zones — edges ~10px thick straddling the outline, corners ~16×16 — with the right resize cursors (ns/ew/nwse/nesw). Keyboard-accessible alternative must not regress if one exists today. Selection box has no hover/press styling (cursor change only). Keep min size 20×20, viewport clamping, the existing click-to-place / drag-to-draw placement, and hideOverlayUI/showOverlayUI.
- Comment box (width 280, keep the below → above → right → left flip logic): radius lg, 1px `line` border, `surface` fill, `shadowPop`, overflow hidden, NO inner padding — the parts merge into one box:
  - textarea: full width, ~88px, padding 10px 12px, no border of its own; placeholder "what should change here?" in muted.
    - hover (pointer over the text area): only the text area's edge darkens — `box-shadow: inset 0 0 0 1px {lineStrong}` with top radius lg. The outer box never changes on hover.
    - focus: only the text area's edge turns yellow — `inset 0 0 0 1px {accent}`. No soft/secondary yellow ring anywhere.
  - footer bar: 36px, separated from the text area by one 1px `line` top border; NO vertical dividers between buttons. Left: character counter; right: "cancel" then "save" (flush, the save button's bottom-right corner follows the box radius).
  - counter: hidden at 0–900 chars, muted mono 11px at 901–979, danger 600 at 980–1000 (update the existing thresholds: warn at >900, danger at ≥980). Format "942/1000".
  - "ok" is renamed "save". Save is disabled while the trimmed note is empty.
  - while capturing (after save): textarea + buttons disabled, save label may read "saving…".

### 3.3 Enlarged modal
- Backdrop `backdrop` token over the page area only (keep the sidebar-width inset logic).
- Panel: `surface`, radius lg, 1px `line`, `shadowPop`, max-width stays.
- Header: "feedback #n" in display italic 20px, close as ghost 32px button (18px icon). No black header bar; separate with a 1px `line` bottom border.
- Screenshot area: `bg` fill, padding 12, image radius md.
- Note editor: same merged style as the comment box (text area + footer bar), autosave on blur/close is unchanged; footer right holds the danger "delete" button (36px, radius md) — or a danger text button flush in the bar; keep the inline error text ("couldn't save note. try again.") on the left in danger colour.

### 3.4 Theme toggle
Cycles auto → light → dark. Persisted (`themeMode`), synced across tabs via `chrome.storage.onChanged`, and applied to all three shadow hosts via a `data-theme="light|dark"` attribute (resolved from mode + `matchMedia('(prefers-color-scheme: dark)')`, listening for changes).

## 4. Dock magnification (note list)
Goal: feel like the macOS Dock — continuous, fluid, never steppy.
- Driven by pointer Y position over the list (not discrete hover index). For each item, compute distance d from the pointer to the item's vertical centre (in layout coordinates, NOT transformed ones, so it doesn't feed back on itself). Influence falls off smoothly (e.g. cosine/gaussian) over a radius of ~1.5–2 item heights; target scale = 1 + 0.12·f(d) (max 1.12 on the item under the pointer, ~1.03–1.05 on neighbours); target translateX = −22px·f(d) (grows out of the sidebar to the LEFT, transform-origin right centre, overlapping the page; the sidebar must not clip it — adjust overflow/z-index as needed).
- Animate every item toward its targets with a critically-damped spring (or frame-rate-independent exponential smoothing) in a single requestAnimationFrame loop that stops when everything is at rest. Pointer enter ramps in, pointer move re-targets continuously, pointer leave relaxes all items back to 1/0 smoothly.
- Neighbours must not visually collide badly: vertical growth is allowed to overlap; the hovered item is on top (z-index by influence).
- The hovered note's background (surface + shadowNote) fades in with influence (≥ ~0.6), never wider than the thumbnail.
- Keyboard focus applies the same magnification centred on the focused item (spring-animated).
- `prefers-reduced-motion: reduce` → no scaling/translation; only the note background appears on hover/focus.
- Transforms/opacity only (GPU friendly); no layout thrash inside the rAF loop (read layout once on enter/resize/scroll, cache it). Clean up listeners/rAF on teardown/re-render.

## 5. Fonts / assets
- Bundle Instrument Serif (400 italic + 400 regular), Instrument Sans (400–700, variable if available), JetBrains Mono (400–600) as latin-subset woff2 under `fonts/`, plus their OFL license text. Source them from the `@fontsource` / `@fontsource-variable` npm packages (install as devDependencies, copy the needed woff2 into `fonts/`), or from Google Fonts' static files.
- Shadow-DOM `@font-face` rules are ignored by Chrome, and host-page CSP (`font-src`) can block `chrome-extension://` URLs. So: from the content script, `fetch(chrome.runtime.getURL('fonts/…'))` → ArrayBuffer → `new FontFace('Salamander Sans', buffer, descriptors)` → `document.fonts.add(...)`. Use namespaced family names (`Salamander Serif`, `Salamander Sans`, `Salamander Mono`) so nothing leaks into or collides with the page. Load once, lazily, fail silently to the system stack.
- manifest `web_accessible_resources` must list the font files and `icons/logo-button-black.svg`.
- No network requests to any third party at runtime.

## 6. Non-negotiables
- Keep all existing behaviour, message flows, storage, capture pipeline, keyboard isolation, page-resize machinery, accessibility labels/roles that tests rely on (update tests only where the UI intentionally changed, e.g. "ok" → "save").
- Keep the closed-shadow-root-per-surface pattern and z-index layering.
- `npm run build` and `npm test` must pass. TypeScript strict, match the repo's comment density and style.

---

# v2 — changes decided after the first implementation (2026-09-19)

These OVERRIDE the sections above where they conflict. The design canvas boards in
`design/canvas/project/` are the visual reference (States.dc.html, Scene.dc.html,
SalamanderModal.dc.html = enlarged view, EnlargedPrototype.dc.html = interactive motion prototype);
`canvas.json` → notes → "motion-spec" is the authoritative motion spec. The boards are NOT pixel
perfect — make sound styling decisions where they're rough, stay within the tokens.

## A. "add note" is a toggle (with lock)
- Off (not in add mode): secondary styling (surface fill, 1px line border, text colour, 500).
  Hover = accentHover fill, press = accentPress (no scale — §2). On (in add mode): accent fill, onAccent,
  600; hover/press same as off. Focus-visible: standard ring over the current fill. Disabled: .4 opacity.
  `aria-pressed` reflects on/off.
- Single click toggles add mode on/off (clicking while on exits add mode = cancel).
- Double-click → LOCKED: stays on; a small plain stroke padlock (~9–10px, currentColor, no circle/badge)
  sits at the bottom-right of the plus icon. While locked, after each successful capture the user is
  put straight back into add mode (placing state) without re-clicking. A single click on the button
  while locked exits lock AND add mode. Cancel inside the comment box while locked cancels that note
  only and stays in add mode (lock persists). Esc exits lock + add mode. Distinguish click vs
  double-click without making single clicks feel laggy (e.g. act on the first click immediately, and
  treat a second click within the dblclick window as "lock" instead of "toggle off").
- aria-label/title communicate state ("add note", "add note (on)", "add note (locked)").

## B. Note-in-list hover = "extension" pattern
- Thumbnail: radius md on ALL four corners in every state.
- On hover/focus (dock-magnified item), a background extension (surface fill, soft drop shadow,
  1px line border drawn INSIDE via inset shadow) appears BEHIND the thumbnail's bottom edge and wraps
  the note text: its top is tucked ~radius px up under the thumbnail, its bottom corners radius md,
  same width as the thumbnail so edges align exactly. The note text does not move between rest and
  hover (same gap/padding) — only the background appears. Fades with the dock influence as today.

## C. Comment box (add mode) = same "extension" pattern
- Text area is its own box: radius lg on all 4 corners, 1px border drawn inside (line), surface fill;
  hover → lineStrong border, focus → accent border (colour change only, no extra ring).
- Button bar is an extension tucked under the text area's bottom edge: same outer width (edges align),
  raised fill, bottom corners radius lg, top hidden under the text area, ~6px inner padding.
  Left: counter (hidden ≤900, muted 901–979, danger ≥980, "942/1000"). Right: ghost buttons with
  padding: "cancel" (muted; hover fill hover + text colour; press fill press) and "save"
  (accentInk bold at rest; accent fill + onAccent on hover/press/focus-visible; muted .5 disabled).
  Button radius sm, ~30px tall, padding 0 12px. No vertical dividers. shadowPop wraps the whole thing.

## D. Enlarged view — replaces the modal
Clicking a note no longer opens a centered modal. The SIDEBAR ITSELF expands:
- Panel grows leftward from its docked width to 75% of the viewport width (min sensible width;
  handle small viewports). The page is NOT re-laid out (no margin change) — the expanded panel overlays
  it; the remaining left 25% of the page is covered by the scrim token (no blur anywhere). Clicking
  the scrim collapses.
- Layout inside (see SalamanderModal.dc.html): header logo + wordmark top-left (rides the panel's left
  edge during the animation); a content column with: previous-note peek card (cut off by the panel's
  top edge, with its 2-line caption), "feedback #n" title (display italic ~28px) + "n / total" in mono
  muted, the large screenshot (raised fill, radius md, image contained, radius on image), the note
  editor (C's text area + extension bar, but the bar holds only a danger ghost "delete" on the LEFT and
  a transient muted "✓ saved" hint on the right), the next-note peek card (cut off by the bottom edge).
  To the right of the column: a rail of three 40×40 secondary icon buttons: x (exit), ↑ (previous),
  ↓ (next); ↑/↓ disabled at the ends.
- Peek cards: 75% of the main thumbnail's size, RIGHT edge flush with the rail's right edge; no number
  badge; hard-clipped by the panel edge (no gradients/masks/blur). Hover: top peek translateY(+7px),
  bottom peek translateY(-7px), nothing else. Click → go to that note.
- Autosave: no save button. Edits save automatically (debounced ~700ms after typing stops, and on
  blur / navigation / collapse). Show "✓ saved" briefly after a successful save; inline danger error
  text on failure ("couldn't save note. try again."). Delete: immediate (as today), then move to the
  next note (or previous if last); deleting the only note collapses back to the list.
- A note can never be empty: every screenshot must keep some text. If the trimmed note is empty, do
  NOT autosave the empty value (the last non-empty text stays stored), show an inline danger error in the
  editor bar ("a note can't be empty. add some text to continue.") with the text-area border in danger
  colour, and block leaving that note — prev/next (buttons, peeks, ↑/↓), collapse (x, Esc, scrim click)
  and sidebar close are refused until text is entered; keep focus in the text area. Deleting the whole
  note via "delete" is still allowed. The error clears as soon as non-whitespace text is typed.
- Keyboard: focus moves into the panel on open (x button); Esc collapses; ↑/↓ navigate when focus is
  not in the textarea; Tab order: rail, peeks, editor, delete. Keep keyboard isolation from the host
  page (src/keyboardIsolation.ts). Return focus to the note's list item on collapse.
- Everything must stay out of screenshots (the enlarged view can't coexist with add mode; entering add
  mode collapses it first).

## E. Enlarged view motion (authoritative detail: the "motion-spec" sticky in canvas.json)
- Shared-element model: elements that exist in both views MORPH from their old rect to their new one
  (FLIP with transform/scale; counter-scale or clip the image to avoid distortion; interpolate radius):
  the sidebar background (grows leftward / contracts rightward), the clicked note's thumbnail (list
  slot ↔ main slot), its list neighbours (list slots ↔ peek slots), logo+wordmark ride the panel edge.
- Everything that exists in only one view FADES in place (no slide/scale): list-only chrome and other
  list items; enlarged-only title, editor, rail, delete, "saved" hint, peek captions.
- Prev/next = a carousel of morphs (peek → main, main → opposite peek, far note fades into the vacated
  peek slot); title/editor content crossfades.
- Curves: std cubic-bezier(.2,0,0,1) for morphs, acc cubic-bezier(.3,0,1,1) for exits/fade-outs; no
  overshoot. Expand ~450ms, collapse ~340ms, prev/next ~400ms; fades 120–200ms with small stagger.
- prefers-reduced-motion: no spatial motion — layout changes instantly, crossfades only, halved durations.
- Neighbour scrolled out of view → it fades into its peek slot instead of morphing.

## F. Default selection size — done (267×100, the thumbnail box at the default sidebar width).

---

# v3 — the add-mode / action-row revamp (2026-09-20)

These OVERRIDE v2 §A where they conflict. Visual reference: `design/canvas/project/States.dc.html`
(rows "add note · off", "add note · on", "add note · keep on", "export, import") and `Scene.dc.html`.
Boards are not pixel perfect; the numbers below are the authority. Everything stays inside the tokens
of §1 — no new colours. All visible text stays lowercase.

## A2. "add note" is an icon-only button with an attached "keep on" switch

Replaces v2 §A's plus icon, text label and hidden double-click lock as the *primary* affordance.

**The group.** The button and its switch live in one `inline-flex` group, `height: 36px`,
`border-radius: md (10px)`, `overflow: hidden`, `box-sizing: border-box`. The GROUP carries the
fill and the border; the two buttons inside are transparent and borderless. Group states:

| state | border | background | colour |
|---|---|---|---|
| off, regular | 1px line | surface | text |
| off, hover | 1px lineStrong | hover | text |
| off, press | 1px lineStrong | press | text |
| on (add mode active) | none | accent | onAccent |
| on, hover | none | accentHover | onAccent |
| on, press | none | accentPress | onAccent |
| disabled | 1px line | surface, `.4` opacity | text |

Off hover/press use the SECONDARY fills (hover/press), never yellow — yellow means "add mode is on".
Focus-visible: the standard ring around the group, drawn on whichever half has focus is wrong — put
the ring on the group (`:focus-within`-style via the focused child) so it always wraps the whole
rounded group.

**The button half.** `width: 36px; height: 100%`, transparent, no border, centred icon. Icon =
comment bubble, 17×17, `viewBox="0 0 24 24"`, `fill:none`, `stroke: currentColor`, `stroke-width: 1.8`,
round caps/joins, path `M20 14a2 2 0 0 1-2 2H8.5L4 19.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z`.
No visible label. `aria-label` and `title` = "add note" / "add note (on)" / "add note (kept on)".
`aria-pressed` reflects add mode on/off. The button never changes size in any state — nothing
wraps, shrinks or reflows on hover (`flex-shrink: 0`, `white-space: nowrap`).

**The switch half.** `role="switch"`, `aria-checked`, `aria-label`/`title` = "keep add mode on".
`height: 100%; padding: 0 10px`, `border-left: 1px solid line`, `flex-shrink: 0`.
Track `28×16`, `border-radius: 8px`; knob `12×12` circle, `top: 2px`, `left: 2px` off / `left: 14px` on.

| switch | segment background | segment inner hairline | track | knob |
|---|---|---|---|---|
| off | surface | `inset 0 0 0 1px line` | lineStrong | surface |
| on | accent | none (border-left becomes `rgba(26,23,18,0.25)`) | onAccent | surface |

The segment stays NEUTRAL while the switch is off even when the button half is yellow — it only goes
yellow when the switch itself is on. Knob slides 150ms std easing; instant under reduced motion.

**Reveal.** The switch is hidden at rest and revealed on hover or keyboard focus anywhere in the
group; once ON it is always visible, in every state, even when add mode is off. Reveal = width
(0 → auto) + opacity, ~160ms std easing, reduced motion → instant. While hidden it must be
`visibility: hidden` / not tabbable so Tab doesn't land on an invisible control. Below
`NARROW_WIDTH_BREAKPOINT` the hover reveal is suppressed (the row has no spare width) — the switch
is then shown only when it is on.

**Behaviour.**
- Button click: toggles add mode on/off, exactly as today (§A). Clicking while on = cancel/exit.
- Switch on: add mode stays on after each successful capture (what "locked" meant in v2) — the user
  is put straight back into the placing state without clicking again. Turning the switch on while
  add mode is OFF also starts add mode immediately (assumption: it reads as "start, and keep going").
- Switch off while add mode is on: add mode stays on for the current note only.
- Button click while the switch is on: exits add mode AND turns the switch off (one click to stop
  everything, as the v2 "click while locked" rule).
- Cancel inside the comment box while the switch is on: cancels that note only, stays in add mode.
- Esc: exits add mode and turns the switch off.
- The switch does not persist — it resets to off per page session, like the old lock.
- The v2 gestures still work and simply drive the switch: double-click on the button, shift+click,
  and shift+Enter all turn the switch ON (and add mode on). They are now alternates, not the only path.
- Third state gone: there is no padlock glyph any more. `setAddButtonState('off' | 'on' | 'locked')`
  keeps its three values — 'locked' now paints button-on + switch-on.

## C2. export + chevron menu (replaces the separate import button)

The action row's right-hand side is ONE group: `position: relative; inline-flex; height: 36px;`
`border-radius: md`, `overflow: visible`, 1px line border, surface fill — same hover/press/focus/
disabled treatment as the secondary button it replaces (hover: lineStrong + hover fill; press:
lineStrong + press fill, no scale — §2).

- export half: `width: 36px`, transparent, `border-radius: 9px 0 0 9px`, 16px export icon
  (`M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14`), `aria-label`/`title` "export feedback".
- chevron half: `width: 22px`, transparent, `border-left: 1px solid line`,
  `border-radius: 0 9px 9px 0`, colour muted, 12px chevron at `stroke-width: 2`,
  `M6 9l6 6 6-6` closed / `M6 15l6-6 6 6` open. `aria-label`/`title` "more actions",
  `aria-haspopup="menu"`, `aria-expanded`. Open state also takes the hover fill.
- menu: `role="menu"`, `position: absolute; top: 42px; right: 0; min-width: 132px; padding: 4px;`
  `border-radius: md`, 1px line, surface fill, shadowPop, `z-index` above the row.
  Items: `role="menuitem"`, 32px tall, `padding: 0 12px`, `border-radius: sm`, 13px/500,
  `gap: 8px`, 16px leading icon, `white-space: nowrap`; hover/focus fill = hover, press = press.
  One item today: "import" with the import icon (`M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19h14`), which
  opens the existing native file picker.
- The menu closes on: item activation, Esc (focus returns to the chevron), outside pointerdown,
  the sidebar closing, and entering add mode. Open via keyboard focuses the first item; Up/Down
  move between items; Tab closes it. Fade/scale in 120ms, out 90ms; reduced motion → instant.

## G. Add-mode preview: the selection rect follows the cursor

While add mode is in the `placing` phase and nothing has been drawn yet:
- A PREVIEW of the selection rect follows the pointer — the same default box the click would
  produce (267×100, `computeDefaultBox`, clamped to the same bounds), so what you see is what you get.
  It uses the real box visuals (the dashed outline + scrim hole) so the page under it is
  readable, but it is marked as preview (`data-preview="true"`), has NO resize zones and no comment box.
- It appears on the first pointer move inside the viewport (fade in ~120ms), hides when the pointer
  leaves the viewport or a drag starts, and is gone for good once a rect is placed (click or drag).
  Position updates 1:1 with the pointer — no spring, no lag. Keep it in the existing rAF/mousemove
  path; do not add a second animation loop.
- A tooltip follows the cursor while the preview is showing and ONLY until a rect is placed:
  text "click or drag to select", 12px body, surface fill, 1px line border, radius md, `padding: 6px 10px`,
  shadowNote, `pointer-events: none`, offset ~(+16, +20) from the cursor and flipped/clamped so it
  never leaves the viewport. It fades with the preview.
- Everything here must stay out of screenshots — it lives in the same overlay `hideOverlayUI()` hides,
  and it is never present during capture (nothing is drawn once a rect exists).

## H. The sidebar is "on hold" during add mode

While add mode is active (on or kept on, placing or editing):
- The note list takes no pointer or keyboard interaction: no hover effect, no dock magnification
  (detach/disable the dock motion handle rather than fighting it), no click to open the enlarged
  view, list items not tabbable. The list is dimmed to ~`.5` opacity so the state is legible.
- The export + chevron group is disabled (and its menu closed).
- The "add note" button, its switch, the theme toggle and the close button stay enabled — the user
  must always be able to stop, change theme, or close.
- Leaving add mode by any path restores everything (dock motion re-attached, opacity, tabindex).

---

# v4 — styling fixes (2026-09-20)

OVERRIDE the sections above where they conflict. Tokens from §1 only; no new colours; all visible
text lowercase. Where a number is not given, match the surrounding code and keep it defensible.

## I. Add-note group micro states (settled by Q&A; already implemented)

Recorded so the next reader knows these were decisions, not accidents:
- The FILL lands on the half under the pointer; the OUTLINE reacts as one. A hover or press
  anywhere lights every border in the control — both halves of the add group, and the export
  group's divider as well as its box — because lighting only the hovered half leaves the control
  half-outlined (worst on the switch, which is bordered on three sides). Nothing scales (§2).
- The reveal is immediate (160ms), the collapse is delayed by a 250ms grace period so a diagonal
  path back onto the switch never loses it. Under reduced motion the grace stays, the animation goes.
- The focus ring hugs the focused half, so it says which half Enter will hit; the group is
  `overflow: visible` to let it out, and each half rounds its own fill.
- The switch knob slides and the track crossfades over 150ms on the standard curve. The icon does
  not react to add mode turning on — the fill change carries it. The "stop" affordance while kept on
  is the tooltip only.
- Hover-less pointers (`@media (hover: none)`) always show the switch. No width breakpoint
  suppresses the reveal; the action row wraps instead.
- The add button keeps all four corners rounded in every state — the switch reads as an extension
  emerging from behind it, never as the right half of a split pill.
- Switch ON = MERGED: the divider goes transparent (never removed — the group must be exactly as
  wide merged as split), hover/press/focus return to the whole group, it is one tab stop, and a
  click on either half means "stop" (exits add mode and clears the switch together).

## J. The fixed top section is one bordered block

The divider currently sitting between the header (logo + theme + close) and the action row moves to
the BOTTOM of the action row. The header and the action row then read as one fixed block above the
scrolling note list, with a single 1px line under the whole thing. No divider anywhere inside it.

## K. Export + chevron group: hover and press are per half

Same rule as §I's add group: only the half under the pointer takes the hover/press fill, the whole
outline (the box AND the divider between the halves) lights with it, and the open-menu state keeps
its own treatment on the chevron half. Nothing scales on press — §2.

## L. Note in the list

- **Padding.** The note text's padding is not uniform today — visibly more above than below, worst
  in the hover state where the extension background makes the edges legible. Make the text's inset
  identical on all four sides, in BOTH rest and hover, and make the extension background's bottom
  edge sit the same distance below the last line as its top sits below the thumbnail. Nothing may
  move between rest and hover (v2 §B) — only the background appears.
- **Delete on hover.** On hover or keyboard focus of a list item, a small icon button appears at the
  TOP-RIGHT of the thumbnail: trash glyph, ~24px, in the §1 icon stroke style. Resting look: surface
  fill, 1px line border, muted icon; hover: dangerSoft fill with danger icon; press: dangerPress;
  focus-visible: the standard ring. It fades in with the same timing as the note extension.
  - It CANNOT be a child of the list item's `<button class="thumbnail">` — nested buttons are
    invalid HTML and break activation. It is a sibling inside `<li class="thumbnail-item">`,
    absolutely positioned over the thumbnail's top-right corner.
  - It must not trigger the item's "open" activation: stop propagation, and keep it out of the
    thumbnail's own hit area.
  - It deletes immediately, with no confirmation, exactly like the enlarged view's delete — same
    DELETE_ITEM path, same error message on failure (`couldn't delete item. try again.`).
  - Keyboard: reachable by Tab after its own list item; visible whenever it has focus.
  - It rides the dock magnification with its item (it is inside the transformed `<li>`), and must
    not disturb dockMotion's hit testing.

## M. Enlarged view

- **Title clipped.** "feedback #12" is cut off at its end. Find the real cause (it is a layout
  constraint, not a font metric — `.xp-title` is `pointer-events: none` by design, which is not the
  bug) and fix it so the title renders in full at every panel width.
- **Counter gone.** Remove the "1/20" counter (`.xp-count`) entirely — element, CSS and tests.
  The rail's prev/next already communicate position.
- **Delete moves up.** The delete control leaves the editor's footer extension and becomes an icon
  button (trash glyph) in the header bar that carries the title, at that bar's right end. Same
  danger treatment as §L's list delete. Same behaviour and callbacks as today — only its place and
  its presentation change.
- **The image is shown at its own size.** No card, no container fill, no border, no letterboxing:
  the `<img>` alone.
  - Natural size = the selection's original CSS size, i.e. `item.selectionRect.width/height` (the
    stored PNG is at `item.dpr`, so its pixel dimensions are NOT the display size).
  - Clamp: never scale UP past that size; scale down proportionally to fit
    `max-width` = the panel's content width less the rails and padding, and
    `max-height` = the viewport less the header bar, the editor and their margins. Keep a sensible
    `min-width` (~240px) so a tiny selection still leaves a usable header and editor.
  - The header bar above and the editor below match the image's RENDERED width exactly, so the
    three read as one column. The column is sized by the image, not the other way round.
  - The prev/next rail buttons and the close button must NOT move when the image changes size:
    position them against the panel and centre them vertically, independent of the column.
  - The FLIP morph from the list thumbnail into this image (v2 §D/§E) must keep working, including
    the interruptible prev/next carousel — verify, do not assume.

## N. "click or drag to select" shows once per session

The §G tooltip is a first-run hint, not a permanent label: it appears with the preview, and then
hides for good after ~5s. Once hidden it does not come back for the rest of the page session,
including in later add-mode sessions. The preview rect itself is unaffected and keeps following the
cursor. The timer is not persisted (a fresh page load shows it again).

## O. The comment box's footer extension gets the note's border

v2 §C's button bar currently has no border of its own. Give it the same treatment as the note's
hover extension in v2 §B: a 1px `line` border drawn INSIDE via an inset shadow, so its edges align
exactly with the text area above it rather than bleeding half a pixel past them.

## P. The switch's own colours (both themes)

Two faults to fix in `.add-switch-track` / `.add-switch-knob`:

1. **Off reads as disabled.** The track is `lineStrong` — a hairline colour, too close to the
   surface to look like a live control. The off track becomes `muted`, which carries real contrast
   against the segment in both themes.
2. **On goes black in dark theme.** The knob is `surface` and the on-track is `onAccent`. `onAccent`
   is the same dark ink in BOTH themes, but `surface` is near-black in dark — so a dark knob lands
   on a dark track and the whole control reads as one black blob. (The off state has the same fault
   in dark theme, for the same reason.)

The fix, which holds in both themes because each pair inverts together or is theme-independent:

| state | segment | track | knob |
|---|---|---|---|
| off | surface (+ inset line hairline) | `muted` | `surface` |
| on  | accent | `onAccent` | `accent` |

Off: `muted` and `surface` invert together, so the knob always contrasts with its track. On: the
track is dark ink and the knob is the brand yellow in both themes, reading as a yellow knob sitting
in a lit slot on the yellow segment. Check both themes after the change — this is exactly the class
of bug that only shows up when you actually look at dark mode.

---

# v5 — the enlarged view's arc, and two add-group fixes (2026-09-20)

OVERRIDES v4 §M where they conflict. Tokens from §1 only; all visible text lowercase.

## Q. The add-note group: no straight divider, and a stricter reveal

1. **The divider goes.** The switch's `border-left` is removed entirely. The switch tucks BEHIND the
   add button's rounded right edge, so the button's own rounded silhouette is the separation and the
   switch reads as an extension sliding out from behind it. The switch keeps a border on its other
   three sides (top, right, bottom) only.
   The fault this fixes: the button's hover fill is correctly rounded on all four corners, but the
   straight full-height divider ran alongside that curve, so the junction read squared-off even
   though the fill was round. Two edges disagreeing.
   The group must stay exactly as wide as it is today in both the collapsed and revealed states —
   compensate for the removed 1px wherever it was counted (`ADD_SWITCH_WIDTH_PX`, the merged
   transparent-divider trick, the resting-width test that asserts 38px).
2. **Reveal on hover, keyboard focus, or on — nothing else.** Today the reveal also fires on
   `.add-group:focus-within`, and a mouse click focuses the button in Chrome, so the switch stays out
   from the click until focus leaves — which is why it lingers through add mode until the user
   clicks the page to draw a rect. Use `:has(:focus-visible)` so only keyboard focus counts.

## R. The enlarged view's sheet: a centred block and an arc of peeks

**The block.** The focused note is its title bar + image + textarea. That whole block is centred in
the sheet, horizontally AND vertically. Its centre is the anchor for everything below.

**The rail.** The prev/next buttons and the close button move to the VIEWPORT's right edge with a
~20px margin, vertically centred, still independent of the image's size. The block's max width must
leave room for that rail column on BOTH sides, so a wide image never collides with it and the
centring stays symmetric.

**No bar under the textarea.** `.xp-bar` goes, with its fill and its inset border. There is no
"saved" confirmation at all. A save failure (and the empty-note error) shows as plain LEFT-ALIGNED
text directly under the textarea, with no bar, no background, and no space reserved when idle.

**The peeks.**
- Each peek is its OWN note at its own natural size × `PEEK_SCALE = 0.75`, clamped the same way the
  main image is and then scaled. It is a preview of the note you are about to open, so navigating to
  it grows it to its true size — a zoom-out/zoom-in. This REPLACES v4 §M's "0.75 × the main image",
  which made every peek a copy of the focused note's proportions instead of a preview of its own.
- Only ~20px of the thumbnail shows past the sheet's top and bottom edges. No caption text, no
  container background, no frame fill — the image edge alone.
- **The arc.** The centres of the focused block and both peeks lie on one circle whose centre is off
  to the RIGHT, with the focused block's centre as the circle's leftmost point. So each peek is
  pushed right of the focused block, symmetrically above and below.

  Let `by` be the block's centre y, `bx` its centre x, `H` the sheet height, and `P = 60` the
  intended horizontal push at a reference vertical distance `D = H / 2`:

      R = (D² + P²) / (2P)                      // circle radius, constant per sheet size
      push(dy) = R − sqrt(R² − dy²)              // clamped to R when |dy| ≥ R
      peekCentre = (bx + push(dy), by ± dy)

  `dy` comes from the 20px rule and is computed per peek from ITS OWN height, so two peeks of
  different sizes get different pushes — correct, since they sit on the same circle:

      prev: centreY = 20 − peekH/2               (above the sheet; dy = by − centreY)
      next: centreY = H − 20 + peekH/2           (below the sheet; dy = centreY − by)

  Guard the `sqrt` against a negative radicand.

**Image narrower than the column's minimum.** Centre it within the column; the title bar and the
textarea keep the full column width.

**The morph.** The FLIP expand/collapse and the prev/next carousel must stay continuous across all
of this: a peek now morphs from (0.75 scale, on the arc, mostly off-screen) to (natural size,
centred), and the list thumbnail → main morph still has to land correctly. Verify, don't assume.

## S. One trash icon

The enlarged view's delete and the note list's delete use the SAME glyph — the list's. Remove the
other one rather than leaving two trash paths in the codebase.

## T. The page does not scroll while the enlarged view is open

Scrolling with the enlarged view open currently scrolls the host page behind the scrim, so the
content slides around underneath. Lock it for as long as the view is open: the wheel, touch
scrolling, and the keyboard (space, page up/down, home/end, arrows) must all leave the page where
it is.

Constraints, in order of importance:
- **No layout shift.** `overflow: hidden` on the host's root is the obvious move, but on a page with
  a scrollbar it changes the content width, which shifts the page-shrink machinery the docked
  sidebar depends on and moves the rects the FLIP morph measures mid-flight. Prefer suppressing the
  scroll at the event level (capture-phase `wheel` / `touchmove` with `{ passive: false }`, plus the
  keys above) so nothing about the page's layout changes. If you do take the `overflow` route,
  prove the width does not change and say how.
- The enlarged view's OWN scrollable areas keep working — the note textarea above all.
- The lock is released on EVERY exit path: collapse, Esc, the exit button, the sidebar closing, SPA
  navigation, entering add mode, and the extension being torn down. A leaked lock leaves the user's
  page unscrollable, which is the worst failure mode here — make it structurally impossible rather
  than remembering each caller.

## U. The exit button is a collapse-panel icon

`.xp-exit` drops the × for a "collapse the panel to the right" glyph, in §1's icon language
(1.8px stroke, round caps/joins, `currentColor`, 24×24 viewBox): a rounded rectangle outline with a
vertical divider about three-quarters of the way across, and a chevron pointing RIGHT inside the
larger left-hand area — i.e. `rect x=3 y=4 w=18 h=16 rx=2.5`, `M15.5 4v16`, `M8 9.5l3 2.5-3 2.5`,
adjusted as needed to sit correctly at the rendered size.

The `aria-label` and `title` are unchanged — it still exits the enlarged view, and the text is what
carries that to assistive tech.

## V. The sidebar's minimum width fits the action row

`SIDEBAR_MIN_WIDTH` stops being an arbitrary 100 and becomes exactly the width the action row needs
with the switch REVEALED, so the export + chevron group never wraps to a second line at any width
the user can drag to:

    SIDEBAR_MIN_WIDTH = PANEL_BORDER_PX
                      + ACTION_ROW_PAD_X * 2          // left + right margin
                      + ADD_GROUP_PX + ADD_SWITCH_WIDTH_PX   // add button + its switch, revealed
                      + ACTION_ROW_GAP                // the gap between the two groups
                      + EXPORT_GROUP_PX               // export + chevron

Derive it from those constants — never hardcode the total, since §Q changes the switch's width.

Consequences to handle, not to leave lying around:
- `COMPACT_WIDTH_BREAKPOINT` is the same sum with the switch COLLAPSED, so it is now below the
  minimum width and can never match. Remove the compact layout (`.is-compact`, its padding override,
  its wrap behaviour and the breakpoint itself) rather than leaving unreachable layout code to rot.
  `NARROW_WIDTH_BREAKPOINT` (220) still sits above the new minimum and stays.
- A persisted width from before this change can be below the new minimum: clamp on load, not just
  while dragging.
- The action row no longer needs to wrap at all. `actionRowFits()` and anything that existed to
  handle the wrap should go the same way if nothing else uses them.

### Q.1 clarification — each half draws its own border (2026-09-21)

§Q above was read as "the group keeps its single border and the switch simply drops its left edge".
That is not it, and it produced the wrong shape. The correct structure:

- The GROUP paints nothing: no fill, no border. It is layout only. (It keeps its radius solely so
  the merged state's focus ring takes the shape of the whole control.)
- The ADD BUTTON draws a complete border — all four sides, all four corners rounded — and an OPAQUE
  fill, in every state. It is a finished rounded button in its own right.
- The SWITCH draws a border on its top, right and bottom only, with its right corners rounded and
  its left corners square.
- The switch's box is pulled LEFT by exactly one corner radius (`margin-left: -10px`, with its width
  grown by the same 10px so the group's width is unchanged). The button sits above it (`z-index: 1`,
  opaque fill), so all that shows of the overlap is the two crescents either side of the button's
  rounded right corners — which the switch's fill and hover fill therefore fill completely.

Why the tuck is required: butting a square-cornered segment against a ROUNDED right edge leaves a
crescent gap at each corner. The outer border breaks into pieces there, and the segment's hover
highlight looks clipped where the curve falls away. Reaching one radius back closes both.

The collapsed state must zero the segment's border-width AND its negative margin: under the global
`box-sizing: border-box` a `width: 0` box cannot shrink below its own border, so a leftover 1px
would re-create the stray hairline and the 39px group.

## X. Button sizes (2026-09-21)

Three sizes, and no others:

| px | used by |
|---|---|
| 28 | the note's hover delete — it sits on a thumbnail, where 32 crowded the image |
| 32 | close, theme toggle, the enlarged view's delete, the rail's prev/next/exit |
| 36 | the action row: the add-note group and the export + chevron group |

Icons stay 16px in all three (17px for the add button's comment glyph, 18px for close).

## Y. The add-note group's labels (2026-09-21)

The TOOLTIP says what a click will do now; the ACCESSIBLE NAME does not change.

| state | button tooltip | switch tooltip |
|---|---|---|
| off | add note | keep adding notes |
| on (switch off) | cancel note | keep adding notes |
| on + switch on (merged) | stop adding notes | stop adding notes |

Merged, the two halves are one button and deliberately share one sentence.

The names stay fixed — `add note` on the button, `keep add mode on` on the switch — because
`aria-pressed` and `aria-checked` are what announce the state. A name that changed with the state
would have it said twice, in two vocabularies.

"add mode" stays out of the visible copy: it is a term from this spec and the code, and appears
nowhere else in the UI.


## Z. The selection outline (2026-09-21)

A 2px line drawn just OUTSIDE the selection box, alternating 4px accent and 4px ink along its
length, following the box's rounded corners. There is no keyline: every other 4px of the line is
already ink, which gives the contrast on a light page that a keyline used to, and a keyline beside
it read as a second, undashed line. The `keyline` token is removed with it.

It is an SVG stroke, not a CSS border or outline: CSS `dashed`/`dotted` derive their dash length
from the line's thickness and give no control over it, and `border-image` with a repeating gradient
ignores `border-radius`. Two rects on the same path at the same width — ink underneath, accent dashed
4/4 on top — so the accent's gaps are ink rather than holes and the line is exactly 2px.

## AA. Dark only (2026-09-21)

OVERRIDES §1's light/dark/auto modes, §3.4 (the theme toggle) and every "in both themes" check in
this document. The extension ships in the **dark theme only**: there is no switcher, and nothing
follows the OS or browser appearance setting.

The light token table is **kept**, unused, in `src/theme.ts` (`LIGHT_THEME`) together with the
black logo asset, so a light theme can come back without re-deriving a palette — emit it under a
selector in `getThemeCSS()` again and give the user a way to choose. Its values remain in §1's
table for the same reason.

What went with the switcher, and is in git history if a light theme returns: the persisted
`themeMode` preference and its cross-tab sync, following `prefers-color-scheme`, the `data-theme`
attribute on each shadow host, and the gate that held the sidebar invisible until the saved mode had
loaded (with one theme there is nothing to wait for, so the panel now shows immediately).

---

# AB. Drawing on the selection (2026-09-21)

A pencil for drawing on the selected region before a note is saved. Every decision below was made by
the user; where a detail was left open it is marked **(impl)** and is the implementer's call, to be
reported back.

## When and where the pencil works

- Only in add mode's **editing** phase: after the selection rect has been placed, and until the note
  is saved or cancelled. Never while placing, never while the capture is running, and **never in the
  enlarged view** — drawings are view-only there.
- Only **inside the selection rect**. The rect's edge resize zones keep their resize cursors and
  keep resizing; the pencil is the interior. Outside the rect the cursor is the normal arrow.
- The cursor inside the rect is a **pencil** (a custom SVG cursor in the §1 icon style, hotspot at
  the pencil's tip, with a system-cursor fallback).

## The stroke

- **2px wide**, round caps and joins, drawn as the pointer moves (use coalesced pointer events so a
  fast stroke stays smooth).
- Colours — three, stored as their HEX on each stroke (so a later palette change can never recolour a
  saved drawing):
  | name | hex | note |
  |---|---|---|
  | yellow (default) | `#E8B600` | the palette's deeper yellow |
  | black | `#1A1712` | the palette's ink |
  | red | `#E5484D` | a vivid annotation red — NOT `danger`, which reads as pink on a screenshot |
- **The chosen colour is remembered until the browser closes** — across reloads, pages and sites —
  and resets to yellow in a fresh browser session. `chrome.storage.session`. **(impl)** content
  scripts only get `storage.session` if the service worker grants it via `setAccessLevel`; check how
  this codebase already reaches session storage and follow that.

## Resizing after drawing

Strokes are **pinned to the page**, not to the rect. Resizing the rect never moves them: shrinking
crops any stroke that now falls outside it, and growing reveals more page around them. Practically,
while editing, the drawing layer lives in the same viewport coordinates as the box and is clipped to
the box's current rect — so a resize only changes the clip.

## Undo and erase

- **Cmd+Z / Ctrl+Z undoes the last stroke.** Inside the note's textarea those keys keep their own
  meaning (undoing typed text), so stroke-undo applies when focus is not in the textarea. Starting a
  stroke therefore moves focus off the textarea (to the drawing surface), and clicking back into the
  textarea returns it. Stays inside add mode's existing keyboard isolation, so the page never sees
  the keystroke.
- **Erase all** removes every stroke on this selection. Disabled while there is nothing drawn.

## The comment box's bottom bar

Left side, in this order: a **pencil icon button**, then the **three colour swatches**. Right side:
the character counter (moved here from the left), then cancel and save.

- The pencil button tells people the swatches belong to the pencil, and is also a menu button: it
  opens a small menu (same treatment as the export group's chevron menu, §C2) holding **erase all**.
  28px (the small-small size, §X). `aria-haspopup="menu"`, `aria-expanded`, a label such as
  "drawing options". Esc closes the menu and returns focus to the button.
- The swatches are a **radio group** ("pencil colour"), each a small circle in its colour with a
  clear selected state that reads in the dark theme — including for the black swatch, which needs a
  visible edge on a dark surface. Arrow keys move between them, as a radio group should.

## Storage — kept separately, on top of the screenshot

The screenshot itself is saved **untouched**; the drawing is its own layer on the item.

- `FeedbackItem.drawing?: { width, height, strokes: { color: string; points: [x, y][] }[] }`, with
  `width`/`height` = the final selection's CSS-pixel size and points in that selection's own
  coordinates (origin = its top-left), cropped to it. Optional: items without a drawing omit it, and
  existing items need no migration. Stored inline on the item record.
- Nothing of the drawing layer may appear in the captured screenshot — it is part of the overlay that
  `hideOverlayUI()` hides for the capture, exactly like the outline. The saved image is clean.

## Where a drawing is shown

- **The note list thumbnail**: the strokes over the thumbnail image, fitted exactly the way the image
  is (the image is `object-fit: contain`; an SVG with `viewBox="0 0 width height"` and the matching
  `preserveAspectRatio` lines up with it).
- **The enlarged view**: over the main image and the peeks, inside `.xp-card-media` (the wrapper that
  exists for exactly this), view-only. It must ride the FLIP morphs and the carousel with the image.
- **Export: the drawn image only.** At export the strokes are painted onto the exported PNG, at the
  image's real pixel size (the PNG is at the capture's dpr, so strokes scale with it). No separate
  drawing data goes in the bundle, and the bundle format does not change — an item without a drawing
  exports byte-for-byte as it does today (the frozen v1 fixture must still pass). Re-importing such a
  bundle brings the drawing back **flattened into the image**; that is accepted.

---

# AC. The export's feedback.md (2026-09-21)

REPLACES the v1 bundle format entirely. The extension is unpublished, so there is **no backward
compatibility**: the v1 codec, its frozen fixture and the YAML dependency (`js-yaml`, used only to
read v1) are removed. A bundle in any other format is rejected on import with a clear error.

One file. `feedback.md` is both the human/agent-readable export and the thing import reads back —
there is no separate data file. Screenshots stay in the zip at `screenshots/{id}.png`, with any
drawing painted on (§AB).

**Every fixed label and piece of fixed text is lowercase.** User content (notes, URLs, page text) is
written exactly as captured.

## The file

````markdown
<!-- salamander-feedback-format: 2 -->
salamander 1.1.0\
**date exported:** 2026-09-21 21:40 utc-05:00\
**website:** example.com

## page "https://example.com/pricing"

### feedback 1

![feedback 1 — marked up by the reviewer](screenshots/1.png)

**note:** the "start trial" cta is misaligned on mobile

<details>
<summary>element data</summary>

```json
{
  "text": "start trial",
  "selector": "section.plans > div:nth-of-type(2) > a.btn",
  ...
}
```

</details>
````

## Rules

- **Line 1** is the HTML comment `<!-- salamander-feedback-format: 2 -->` — invisible when rendered;
  it is how import recognises the format. The extension version is a separate thing.
- **Header**, three lines joined by trailing `\` so they render as separate lines, not one run-on
  paragraph: `salamander {manifest version}`, `**date exported:** {local time} utc{±hh:mm}` as
  `YYYY-MM-DD HH:MM utc-05:00`, and `**website:** {domain}`. Nothing else at the top — no title, no
  summary, no index.
- **Pages**: `## page "{normalised url}"` — the address notes are grouped by. Notes on one page can
  have different full URLs (query strings, fragments); each note's exact URL is in its JSON.
  Pages in the order they were first captured; notes in capture order within a page.
- **Each note**: `### feedback {id}`, a blank line, the screenshot, a blank line,
  `**note:** {text}`, a blank line, the details block.
  - Screenshot alt text: `feedback {id}`, or `feedback {id} — marked up by the reviewer` when the
    note has a drawing. Invisible to someone looking at the image; for an agent reading the text
    it is the only way to know the marks aren't part of the page.
  - The note is written as-is, no surrounding quotes. A multi-paragraph note keeps its paragraphs.
    An empty note is `**note:** (none)`.
  - `<details>` with `<summary>element data</summary>`, a blank line (GitHub needs it to render the
    fenced block inside), a ```json fence, a blank line, `</details>`.
- **The JSON is the complete record** and is what import reads — the visible note line is for
  people and is ignored on import. Pretty-printed, 2-space indent. Fields an agent needs to find
  the element come first:
  1. `text` — the primary target's visible text
  2. `selector` — its CSS selector
  3. `xpath`
  4. `html` — the outer-HTML snippet (and `html_truncated` when it was cut)
  5. `page_url` — this note's exact URL
  6. `note` — the full note text
  7. then `id`, `normalised_url`, `page_title`, `created_at`, `selection_rect`, `viewport`, `dpr`,
     `contained_elements` (with its truncated flag when set), `area_text`
  No field appears twice: the v1 `page_meta` block, which repeated url, normalised url, viewport,
  dpr, selection rect and capture time, is gone — only `page_title` survives from it. Keep
  snake_case names.
- Import rebuilds each item from its JSON plus `screenshots/{id}.png`, exactly: a round trip
  (export, wipe, import) must reproduce every stored field except the drawing, which comes back
  flattened into the image as §AB already accepts.
