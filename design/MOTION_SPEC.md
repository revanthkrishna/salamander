# Motion spec — enlarged sidebar view

Authoritative, complete version of the "motion-spec" sticky in `design/canvas/project/canvas.json`
(that note is 5000-char-truncated by the canvas and is split there into two stickies,
`motion-spec` + `motion-spec-2`, which point back here). Governs SALAMANDER_SPEC.md §D/§E
(the enlarged sidebar view that replaces the old centered modal). Values were recovered from
`design/canvas/project/EnlargedPrototype.dc.html`'s `renderVals()`/`slot()`/`listRect()`/`open()`/
`close()`/`go()`/`del()`/`edit()` — that file is the executable reference; where this doc and that
file ever disagree, re-derive from the file. The list dock-hover magnification (macOS-Dock-style,
sidebar note list) is out of scope here — it's already implemented in `src/dockMotion.ts` and is
only referenced briefly (§9).

Source: LottieFiles motion-design skill
(https://raw.githubusercontent.com/LottieFiles/motion-design-skill/main/skills/motion-design/SKILL.md).
Personality: **Corporate / Enterprise SaaS** — `director/context-adaptation.md`: 200–400ms duration
band, "Low" motion density, 0% overshoot. All values below are at 1x; the prototype exposes a
"slow (4x)" debug tweak (`this.ms(v)`) that scales every duration uniformly — do not build that
into shipped code, it's a design-review aid only.

**Status against the build (2026-10-12) — enlarged view 2.0.** `SALAMANDER_SPEC.md` §AH replaced
the single-note sheet with one scrolling page of every note on the site, so the *choreography*
below (§2–§9) is rewritten for it; the curves (§1), the durations, reduced motion (§12) and the
implementation rules (§13) are unchanged and still what `src/enlargedView.ts` (`T`, the
choreography), `src/cloneLayer.ts` (the shared-element clones), `src/flip.ts` and
`src/dockMotion.ts` implement. Geometry is no longer a fixed set of slots: it
is computed by `src/enlargedLayout.ts` (§4). Gone with the old sheet: the main slot, the peeks
and their arc, the x / ↑ / ↓ rail, the prev/next carousel and peek hover. Their earlier
description is in git history (this file before 2026-10-12).

## 1. Curves

| name | value | MD3 name | used for |
|---|---|---|---|
| `std` | `cubic-bezier(0.2, 0, 0, 1)` | Standard | every shared-element morph, the panel edge, entrances |
| `acc` | `cubic-bezier(0.3, 0, 1, 1)` | Accelerate | exits, fade-outs, the delete shrink |

Rule (`reference/timing-easing-tables.md`, directional easing): an element that exists in **both**
views starts and ends on-screen, so it always uses `std` — never `acc`, even mid-carousel. `acc` is
reserved for things leaving the screen or leaving existence (fades of list-only/enlarged-only chrome,
the deleted card's shrink). No bounce, no overshoot anywhere (Corporate: 0–3%; we use 0%).

## 2. Model: shared elements vs. fades

Elements that exist in **both** views never fade — they travel from their old rect to their new one
(FLIP: transform/scale, or an equivalent property-level tween — see §13):
1. the sidebar panel background
2. **every note whose list thumbnail is visible** in the list's scrollport — wholly or in part —
   list slot ↔ its place in the grid. One cut by the list's edge leaves (and lands) exactly as cut:
   its clone's frame is clipped by the hidden amount, easing to nothing (or from nothing) on the
   morph's own curve
3. the logo + wordmark, which ride the panel's left edge as it moves, at the docked size (never
   scaled), and move on the panel's own curve from the docked pose (16px in, centred in the 56px
   header) to centred in the 68px top bar and as far in: 6px down and 8px right (revised
   2026-10-13)

Everything that exists in only **one** view fades in place — no slide, no scale, no translate.

## 3. Fades-only vs. morphs — reference table

| | morphs (shared element, travels) | fades only (no movement) |
|---|---|---|
| **list-view-only** | — | close button, add/export row, "this page (n)", list items entirely out of the list's scrollport, every list note's text |
| **enlarged-view-only** | — | exit button, delete all (and its question), the top bar's rule, page headings, every note's "#n" + delete header and text area, notes of other pages (and scrolled-out ones) including their screenshots, the "note required" / failure lines |
| **shared (both views)** | panel bg, every visible list thumbnail ↔ its note's screenshot, logo+wordmark | number badge (on the clone; fades out as it leaves the list, back in as it lands on it) |
| **backdrop** | — | scrim (fade only, never travels) |

## 4. Geometry

Computed, not fixed (`src/enlargedLayout.ts`, design spec §AH): the panel is
`max(0.75·vw, min(560, vw), sidebarWidth)`; the content column is the scroller's width less 16px
each side; each note's screenshot is its selection's CSS size, never scaled up, scaled down to fit
the column or the visible height; columns of `clamp(shot, 267, column)` packed three to a row and
centred; the opening scroll position shows the last 40px of the row before the note's under the
top bar (for a page's first note, the previous page's last row, with the heading whole below it)
— the site's first row at the top; on a window too short for that and the note's text area, the text area wins (design spec
§AH, "Opening", revised 2026-10-13). A clone's
destination is its note's screenshot box in viewport coordinates at that scroll position (one
layout read of the content's origin per gesture).

- **hard clip only**: the stage clips at the panel's left edge (its animated width), the front
  layer (the clones) at the scroller's top edge too, so a clone lands exactly as clipped as the
  note it becomes. No gradients, masks, blur or `backdrop-filter` anywhere in this feature.

## 5. Expand (click a list note) — total ≈ 500ms

- **t0**: read the site (`GET_SITE_PAGES`, one queued round trip), lay it out, set the scroll
  position, measure the list rects of every visible thumbnail on this page (after scroll; the dock
  transform included). Hide those list thumbnails and their notes' real screenshots; place clones
  on the list rects. Focus the clicked note's text area (caret at the end); the list goes inert.
- **0–450ms, `std`**: panel grows leftward, width 300 → 75% of the viewport; the logo moves 6px down and
  8px right.
- **0–450ms, `std`, same curve**: every clone morphs list slot → its note's screenshot box.
  Identical curve and duration to the panel, so a clone never outruns the panel's left edge.
- **0–200ms, `std`**: scrim fades in. **0–150ms, `acc`**: the list fades out.
- **150ms delay + 200ms, `std`**: the clones' badges fade out.
- **from 150ms, 200ms each, `std`**: the grid fades in a band at a time — a heading, or a row of
  notes (header, screenshot unless it is a clone's, text area) — top down from the opening
  position, 50ms apart, capped at two steps (Grid Cards, Corporate stagger; the last fade ends by
  450ms). What is off screen is simply there.
- **300ms delay + 200ms, `std`**: the exit button, delete all and the top bar's rule fade in
  (and a top-bar notice, if any).
- **at 500ms**: the clones are swapped for the real screenshots (pixel-identical boxes) and the
  list thumbnails restored. The scroller holds still until then.

## 6. Collapse (exit, Esc, scrim, toolbar icon) — ≈ 75% of the duration

- **t0**: flush every pending edit; repaint the (still hidden) list if the view changed this
  page's notes; centre it on the note focus returns to; measure the visible list rects once.
- **0–340ms, `std`**: panel contracts back to the docked width; the logo moves back up 6px and left 8px. Every
  note **on screen in the panel** that has a visible thumbnail in the list gets a clone at its
  current box, which morphs into that thumbnail, its badge fading back in (150ms `std`). Clones
  still in flight (a collapse mid-open) reverse from where they are.
- **0–120ms, `acc`**: the grid (the whole scroller), the exit button, delete all, the top bar's
  rule and anything without a thumbnail fade out. After a confirmed **delete all** nothing has a
  thumbnail any more (the list is repainted empty at t0), so every note fades and none morphs.
- **150ms delay + 150ms, `acc`**: scrim fades out. **150ms delay + 200ms, `std`**: the list fades
  back in.
- **at 360ms**: the clones are removed and the list thumbnails restored; focus returns to the list
  item of the last note focused on this page, else the one opened.

## 7. (Prev / next — removed)

There is no carousel any more: the whole site is one scrolling page (design spec §AH). ↑/↓ scroll
it (64px), PageUp/PageDown page it (less the 80px peek), Home/End go to the ends — `smooth`, or
instant under reduced motion. Focus moved to a note (Tab, the empty-note lock) scrolls just enough
to show it whole.

## 8. Delete

- **0–180ms, `acc`**: the note shrinks to `scale(0.95)` around its own centre and fades to 0; a
  page's last note fades its heading with it. DELETE_ITEM runs alongside.
- **at 180ms** (and the reply in), the note is removed from the model:
  - **notes remain**: the later notes on its page renumber; the site is laid out again and every
    heading and every part of every note (header, screenshot, text area — separately, since a note
    can change rows and its row's band height can change) travels from where it is on screen to
    its new place: **400ms `std`**, transform-only FLIP — those on or within 200px of the screen,
    before or after; the rest (most of a long site) take their new place at once, unseen. If the content's height change made the
    browser clamp the scroll position, the clamp is folded into the start offsets so nothing jumps.
    Focus moves to the next note's delete.
  - **that was the site's last note**: run §6 straight back to the (empty) list.
- A second delete mid-move retargets every part from its live position (the analytic record of
  each move, §13). A delete during the expand retargets the clones in flight and pushes the
  expand's end back.
- Deleting is always allowed, even while the empty-note lock (§11) holds the view open.

## 9. (Peek hover — removed)

The peeks are ordinary content now — the previous row's bottom, cut off by the scroller's top
edge — so they have no hover of their own.

## 10. Autosave (no "✓ saved" hint)

- The hint is gone (design spec v5 §R): a successful save says nothing. Every note autosaves on its
  **own** 700ms debounce (§AH: all notes are editable at once), and each blur, a collapse and a
  page unload force an **immediate** save of every pending change.
- Failure: "couldn't save note. try again." fades in under that note's text area over **200ms,
  `std`** (§11's entrance), no movement, and stays until the next save succeeds or the note is
  edited again.

## 11. Empty-note error (blocked navigation)

Triggered when the user tries to close the view (exit, Esc, scrim click, toolbar icon, sidebar
close) while any note's trimmed draft is empty — and, since §AH, shown as soon as a note is emptied (SALAMANDER_SPEC §D: "a note can never be empty").
Based on `patterns/state-feedback.md`'s **Inline Validation** recipe (border → red, text feedback,
optional shake), scaled down to Corporate/"Low" intensity and made **non-spatial** per the design
call already made for this feature (no slide-down, unlike that recipe's generic "error text slides
down + fades in"):

- **textarea border**: transitions directly to `danger` colour over **150ms, `std`** (colour-only —
  reuses the exact border-colour transition already used for the textarea's hover/focus states, just
  targeting the danger token instead of `lineStrong`/`accent`).
- **inline error text** ("note required", §AH) appears directly under the emptied text area, in
  the row gap, reserving no space — the same line a save failure uses. Fades in over **200ms,
  `std`**, no movement. Delete stays reachable (§8 — delete is exempt from the block).
- **optional micro-shake**: a single tiny horizontal shake on the textarea, **±4px, 2 cycles,
  ease-in-out, 200ms total** — a toned-down dose of the skill's Error Shake recipe (±10–15px,
  2–3 cycles, 300–400ms total; "no overshoot: errors feel firm"). Fire it once, on the **first**
  blocked attempt while transitioning into the error state — do not re-shake on every repeated
  blocked click while the error is already showing (that reads as nagging, not firm); emptying the
  note again re-arms it. **Never** runs
  under `prefers-reduced-motion: reduce`, full stop, independent of whether the border/text fades
  also get reduced-motion treatment (they don't need to — they're already opacity/colour only).
- Focus moves to the first empty note (scrolled into view, §7); the error text's `aria-live="polite"` region carries
  it to screen readers, same pattern as the existing add-mode/list notification banners.
- **Clears** as soon as non-whitespace text is typed: border fades back to its normal state over
  150ms `std`; error text fades out over **120ms, `acc`** (exit ≈ 65–75% of the 200ms entrance, per
  the entrance/exit asymmetry rule).

## 11a. Delete all ↔ its question (the top bar, 2026-10-13)

The top bar's **delete all** and the question it turns into ("confirm?", "yes, delete all",
"cancel") are two faces of **one box** — the exit button's 36px secondary box (fill, 1px border,
radius md), which is the same for both, so only its **width** morphs. Modelled on the "more
options" menu's morph into its question (`actionMenu.ts`, `MENU_MORPH_MS`), so the two feel the
same:

- **0–200ms, `std`**: the box's width, from what it is on screen to the arriving face's natural
  width, **anchored on its right edge** (it sits left of the exit button; the tools row is
  right-aligned). The box clips (with the focus ring's 4px of room), and the arriving face is laid
  out at its final width, pinned right, so the box uncovers it rather than reflowing it.
- **0–90ms, `acc`**: the leaving face fades out (it is out of the flow and inert at once).
- **80ms delay + 120ms, `std`**: the arriving face fades in — out, then in, ending with the morph.
- **Going back** (cancel, Esc, a press elsewhere, Tab away, a failed delete) is the same, reversed.
  **Interruptible** (§13): a reversal mid-morph starts from the live width and the live opacities.
- **After yes** the view closes as in §6; the box fades out with the rest of the top bar.
- **Focus** moves to cancel as the question arrives, and back to the button for cancel and Esc.
  The button's focus ring is drawn by the box, so it follows the morph.
- **Reduced motion** (§12): no width morph; the faces crossfade in 100ms.

## 12. Reduced motion (`prefers-reduced-motion: reduce`)

Governing rule (kept from the existing spec): **no spatial motion** — layout/position changes
happen instantly; only crossfades remain, at roughly halved durations.

- **Expand**: ~160ms vs. ~500ms. The panel width and the logo jump; no clone is made; only opacity
  animates — scrim 100ms, list out 75ms, the whole grid and the exit button in over 125ms.
- **Collapse**: ~200ms vs. ~360ms, same halving pattern; the panel snaps back at 75ms.
- **Delete**: the note fades out over 75ms `acc`, then the rows re-pack instantly. No part ever
  visibly travels. Scrolling (keys, focus) is instant rather than smooth.
- **Dock hover** (list, `src/dockMotion.ts`): magnification transforms are fully off; only the note
  background still fades in on hover/focus.
- **Save failure / empty-note error**: unaffected — both are already opacity/colour-only, which
  reduced motion permits — **except** the empty-note error's optional micro-shake, which is always
  suppressed regardless of any other reduced-motion branching.

## 13. Implementation notes

**FLIP with real DOM, in the closed shadow root.** All of this runs inside the sidebar's existing
closed shadow root (SALAMANDER_SPEC §6). Shared elements are real DOM nodes, not a virtual overlay
framework. Recipe per morphing card: **First** — measure the source rect
(`getBoundingClientRect()` on the real list item) once, before hiding it. **Last** — compute the
destination rect arithmetically (the layout's box for the note plus the content's origin, read once
per gesture — §4). **Invert** — position/size the floating clone at Last, then apply a transform that
maps it back onto First (`translate(dx, dy) scale(sx, sy)`). **Play** — clear that transform (or
transition it to identity) and let the declared CSS transition/WAAPI animation carry it from First
to Last. Key clones by note id so identity is stable across pre → opening → open → closing (a card
must never jump between two DOM nodes mid-flight — mirrors the prototype's `cards = notes.map(...)`,
which never re-keys on filtered index).

**Measure once.** `getBoundingClientRect()` is called exactly once per gesture, at t0, for whichever
source rects the gesture needs (destination rects are pure math and never need a DOM read). Never
re-measure inside a rAF loop or on every re-render — same rule `src/dockMotion.ts` already follows
(layout read only on enter/resize/scroll, the animation loop only writes).

**Screenshot distortion — counter-scale or clip.** The inner screenshot (`object-fit: contain`)
sits in three differently-proportioned frames (267×100 → 720×380 → 540×285). Scaling the whole card
as one transform makes the image's letterboxing swim against the frame edges mid-morph. Two valid
fixes: (a) **counter-scale** — animate the frame via transform, and drive the inner image's own
width/height/border-radius directly (as `shotT` already does in the prototype) rather than scaling
it, so it always matches its own computed `shot()` box; (b) **clip** — fix the image at intrinsic
size and animate a `clip-path`/overflow window instead. (b) only works cleanly when source and
destination aspect ratios are close; list slot (2.67:1) vs. peek (1.89:1) are not, so prefer (a) for
any morph whose destination aspect differs materially from its source.

**Border-radius interpolation.** Animate `border-radius` as its own px property alongside
width/height (as the prototype's `shotT` does) rather than letting it ride a `transform: scale()` —
a scaled radius renders too large/small relative to the shrunk/grown box unless you divide the
target radius by the current scale factor at every instant. Simplest correct approach: don't scale
radius at all, tween it directly.

**Panel: width vs. clip-path/translateX.** The reference animates `width` 300→1080, which is
simplest and matches the sidebar's existing resize machinery (§3.1), but width is a layout property
— every frame reflows the shadow root's subtree, which can jank against a busy host page. Trade-off:
`clip-path: inset(...)` (or a translateX reveal) is compositor-only and avoids layout, but the panel
element then permanently occupies 1080px of the DOM (needing pointer-events management on the
clipped portion), and every internal `right`-anchored offset (rail, peeks, cards — all measured from
the panel's *right* edge per `slot()`) already reads correctly against the final width regardless of
which technique is used, since nothing internal is left-anchored. Ship width first (matches the
reference and existing code); switch to clip-path only if real-page profiling shows jank.

**Web Animations API vs. CSS transitions.** Plain CSS transitions (rebuilding a `transition` string
per render, as the prototype does) are fine for fades — simple start/end interpolation, no need to
inspect progress. Prefer WAAPI (`element.animate()`) for the shared-element morphs specifically:
an `Animation` exposes `.currentTime`/`.finished` (a promise) and `.updatePlaybackRate()`/`.reverse()`
for interruption (below); re-targeting a live CSS transition mid-flight needs a reflow-forcing
restart hack to get the same effect.

**Interruptibility.** (Written for the old carousel; §AH has no prev/next, and the rule now
applies to deletes, which retarget every part from its live position — option (a) — and to a
collapse mid-open, which reverses the clones in flight.) The reference guards prev/next and delete with a single `busy` flag that
silently drops a second input — acceptable as a floor, not the ship target, since a fast double-tap
of ↓ (or keyboard repeat) will otherwise feel unresponsive. In order of preference: (a) **retarget**
— on a second ↓ while a carousel morph is in flight, read the live animation's current rect as the
new First and re-run FLIP straight to the next-next destination, skipping the intermediate resting
frame (mirrors the Dock's own continuous re-targeting in `dockMotion.ts`); (b) **queue** — keep
`busy` blocking new input, but hold a 1-deep queue (coalescing repeats of the same direction) and
run it the instant the current gesture settles, rather than dropping it. (a) is the better UX, (b)
is the minimum bar. Delete arriving mid-morph should always cancel-and-restart from the live rect
(same mechanics as (a)) rather than being blocked — delete is a destructive, impatient action.
Entering add mode while the enlarged view is open (§D: incompatible, add mode collapses it first)
is a **cancel-then-run**, not a queue: kill the in-flight animation immediately to its resting closed
state (no half-collapse frame), then start add mode clean — the two can never coexist in a
screenshot anyway (below).

**Cleanup / teardown.** Every timer/rAF/WAAPI-Animation created for a gesture must be
cancelled on: unmount, page navigation away, tab visibility loss mid-animation, and — critically —
whenever a new gesture pre-empts the current one (open→close→open in quick succession). A stale
timer firing after its animation was superseded will stomp state (e.g. resurrecting a stale "saved"
hint, or clearing `busy` too early). Pattern: one owning object per active gesture with a single
`cancel()` that tears down every timer/animation/listener it created, called unconditionally before
the next gesture starts (mirrors `dockMotion.ts`'s teardown discipline). Remove temporary morph-clone
DOM nodes and restore the real list thumbnails' `visibility` inside that same `cancel()` path, not
only on the happy-path "finished" callback, or an interrupted gesture leaves an orphaned clone layer.

**Nothing may appear in a screenshot.** The capture pipeline (`capture.ts`/`contextCapture.ts`) must
hide the sidebar's entire shadow root — list, morph-clone layer, and enlarged panel alike — before
capturing the page, the same way add mode already does via `hideOverlayUI()`/`showOverlayUI()`
(`src/addMode.ts`, §3.2). Don't special-case "hide the enlarged view" as a separate flag from "hide
the list" — gate capture on "is this shadow root anything other than resting", since a morph-clone
mid-animation is exactly the transient DOM a narrower check would miss, and the enlarged view and
add mode are mutually exclusive by design (§D) so there's never a need to hide "just one."
