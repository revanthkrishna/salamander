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

**Status against the build (2026-09-22).** The choreography, curves and durations below are what
`src/enlargedView.ts` (`T`), `src/flip.ts` and `src/dockMotion.ts` implement. Later sections of
`SALAMANDER_SPEC.md` removed some of the *elements* this document names; where a step below
mentions one, it is now a no-op:
- the theme toggle (§AA — dark only), the "n / total" counter (v4 §M) and the peek captions
  (v5 §R) no longer exist, so they neither fade nor travel;
- the editor's extension bar, the "✓ saved" hint (§10) and the delete button in that bar are
  gone (v5 §R): delete is an icon button in the title bar, and a save failure or the empty-note
  error is plain left-aligned text under the textarea, not a slot in a bar. §10's debounce (700ms)
  and immediate-flush rules still apply exactly; only the confirmation was removed;
- geometry (§4) is the 1440px prototype's. The build derives it live (`computeEnlargedGeometry`):
  the block is centred in the sheet, the rail (36px buttons) is 20px off the *viewport's* right
  edge, and each peek is its own note at 0.75 of its own natural size on the §R arc, not 75% of
  the main slot;
- the shake in §11 runs once, on the first blocked attempt only.

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
(FLIP: transform/scale, or an equivalent property-level tween — see §10):
1. the sidebar panel background
2. the clicked note's thumbnail (list slot ↔ main slot)
3. the thumbnails of its immediate list neighbours (list slot ↔ peek slot)
4. the logo + wordmark, which ride the panel's left edge as it moves

Everything that exists in only **one** view fades in place — no slide, no scale, no translate.

## 3. Fades-only vs. morphs — reference table

| | morphs (shared element, travels) | fades only (no movement) |
|---|---|---|
| **list-view-only** | — | theme + close buttons, add/export/import row, "this page (n)", every *other* list item (not the 3 shared notes), the list note-text of the 3 shared notes |
| **enlarged-view-only** | — | rail (x, ↑, ↓), "feedback #n" / "n / total", note editor (textarea + bar), delete button, "✓ saved" hint, empty-note error, peek captions (2-line, fade only — they never travel even though their card does) |
| **shared (both views)** | panel bg, clicked thumbnail, ≤2 neighbour thumbnails, logo+wordmark | number badge (visible in list, **fades to 0 opacity** as its card settles into main or either peek — never present at rest on main/peeks) |
| **backdrop** | — | scrim (fade only, never travels) |

Edge case: if a neighbour's list slot is scrolled out of view when you open a note, it is **not**
morphed (no rect to FLIP from) — it fades into its peek slot instead (200ms `std`, 150ms delay).

## 4. Geometry

1440px reference viewport; panel = 75% = 1080px.

- **list slot**: 267×100, radius 10. Item pitch 194 (100 thumb + 8 gap + 70 note), list header
  offset 138 (56 header + 56 action row + 26 heading).
- **main slot**: 720×380, radius 10, screenshot inset (padding) 28.
- **peek slots**: 540×285 — **exactly 75% of the main slot** in both dimensions, same radius 10.
  Right edge flush with the right edge of the x/↑/↓ rail (`slot('prev'|'next').right = 149px`, same
  as the rail's own right inset). The prev (top) peek sits above the title and is hard-cut by the
  panel's top edge (`top: -201px`); the next (bottom) peek sits below the editor and is hard-cut by
  the bottom edge (`top: 762px`, panel height 900px).
- **no number badge on peeks, and none on the main slot either** — the badge belongs to the list
  only. It is present (opacity 1) whenever a card is in list-slot geometry and fades to opacity 0
  by the time the card settles into main or peek geometry (§3, §5, §7 badge timings). There is no
  state in which a badge is visible on an enlarged-view card.
- **hard clip only**: the panel has `overflow: hidden`. No gradients, masks, blur or
  `backdrop-filter` anywhere in this feature.

## 5. Expand (click a list note) — total ≈ 500ms

- **t0**: capture the list rects of the clicked note and its visible prev/next (after scroll;
  include the dock-magnified transform if the item was hovered — `hovId`). Hide the real list
  thumbnails (`visibility: hidden`) and place floating clones exactly on top of them.
- **0–450ms, `std`**: panel grows leftward, width 300 → 1080 (duration table: page transition
  400–600ms → Corporate "slow" end ≈ 450; distance scaling: full-screen ≈ 1.8–2x of a 250ms base).
- **0–450ms, `std`, same curve**: the clicked thumbnail morphs list slot → main slot; prev/next
  morph list slot → peek slot. Identical curve+duration to the panel so a card never outruns the
  panel's left edge.
- **0–200ms, `std`**: scrim fades in (multi-element: Modal-with-Content, backdrop first).
- **0–150ms, `acc`**: list-only elements fade out (entrance-exit: Dissolve Exit, no scale).
- **150ms delay + 200ms, `std`**: badges fade out (settling into main/peek — see §4).
- **250ms delay + 200ms, `std`**: peek captions fade in.
- **200/250/300ms delay, 200ms each, `std`**: title / editor / rail fade in, in that reading order
  (multi-element: List Items, Corporate 50ms stagger; total stagger 100ms).
- **at the end**: focus moves to the exit (x) button.

## 6. Collapse (x, Esc, or scrim click) — the exact reverse, ≈ 75% of the duration

(entrance-exit rule: exits are 65–75% of the matching entrance.)

- **t0**: scroll the (still-hidden) list so the current note is centred; recompute its list rect and
  its neighbours' list rects against that scroll position.
- **0–120ms, `acc`**: title, editor, rail and peek captions fade out.
- **0–340ms, `std`**: panel contracts rightward 1080 → 300 while the main card shrinks back into its
  list slot and the peeks shrink into theirs (same curve/duration as the panel).
- **150ms delay + 150ms, `acc`**: scrim fades out.
- **150ms delay + 200ms, `std`**: list-only elements fade back in (100–150ms overlap with the
  contraction — entrance-exit continuity, not sequenced end-to-end).
- **at the end**: swap the clones back for the real list thumbnails (pixel-identical, no visible
  pop) and restore `visibility`. Focus returns to the list item.

## 7. Prev / Next (↑/↓, rail buttons, or click on a peek) — a carousel of morphs, 400ms, `std`

- **next** (`go(1)`): the next peek grows into the main slot; the main shrinks into the (now vacated)
  prev peek slot; the old prev peek fades out in place (150ms, `acc`); the note *after* next fades
  into the vacated next-peek slot (200ms, `std`, 200ms delay). "prev" (`go(-1)`) is the exact mirror.
- Title/editor content crossfades, not morphs: old content fades out over 120ms `acc`, swaps, new
  content fades in over 180ms `std` (multi-element: Tab Switch — old fades first at ~150ms mark
  logically, new starts ~100ms in). Rail and panel stay perfectly still.
- 400ms matches "shared-element morph (400ms)" in multi-element: Page Transition. **Input is
  blocked** (`busy`) until the whole gesture settles, ~400–600ms depending on interruption handling
  (see §11 for why that's a minimum bar, not the final design).

## 8. Delete

- **0–180ms, `acc`**: the main card (the one being deleted) shrinks to `scale(0.95)` and fades to 0
  opacity. Title and editor fade out over the same window (they share the enlarged-only fade-out
  path used by prev/next's crossfade-out, 120ms `acc`, inside the 180ms window).
- **at 180ms**, the note is actually removed from the data model. Two outcomes:
  - **notes remain**: the index snaps to `min(oldIndex, newLength − 1)` — i.e. the note that was
    "next" becomes the new main (normal case), or, if the *last* note in the list was the one
    deleted, the note that was the prev peek becomes the new main instead (mirrors a "prev" move).
    This re-triggers the exact §7 carousel geometry (400ms `std` rect morph for main/peeks, the
    note-after-next/prev fading into the vacated far peek at 200ms `std` + 200ms delay), while
    title/editor for the new current note crossfade back in over 180ms `std` (they were already
    faded out from the 0–180ms step, so this is a fade-*in*, not a second fade-out). Total gesture
    ≈ 580ms; input stays blocked until 600ms.
  - **that was the only remaining note**: skip the carousel entirely — there is no note left to
    become the new main. Run the §6 Collapse sequence directly (panel contracts 1080 → 300 over
    340ms `std`, scrim/list fades as in §6) straight back to the list view, which now shows the
    empty state ("no feedback on this page yet"). The rail/editor fade-out from the 0–180ms delete
    step and Collapse's own 0–120ms fade-out target the same already-hidden elements, so this never
    double-animates — Collapse's fade-out step is simply a no-op on elements already at 0 opacity.
- Deleting is always allowed even while the empty-note error (§10) is blocking navigation — delete
  is the one action §D exempts from the "note can never be empty" lock.

## 9. Peek hover (open view only)

- Hovering (pointer only — see below) a peek card moves **only that card**, by transform, nothing
  else on the panel changes:
  - **prev (top) peek** → `translateY(+7px)` (down, toward the title — reads as "pulling closer").
  - **next (bottom) peek** → `translateY(−7px)` (up, toward the editor).
- No scale, no shadow, no border change, no opacity change from the hover itself — transform only.
- Timing: **enter 90ms, leave 180ms**, both `std`. This is intentionally tighter than the general
  120–180ms button/toggle band (`timing-easing-tables.md`) because it's a single-property
  GPU-composited transform with nothing else competing for attention.
- Keyboard focus on a peek shows the standard focus ring (`0 0 0 2px {bg}, 0 0 0 4px {focus}`) but
  does **not** trigger the ±7px lift — focus is a state indicator, hover is a gesture; conflating
  them would make the ring feel like it's "reaching" for the pointer on every keyboard move.
- Reduced motion: the lift never happens (pointer or keyboard); only the focus ring remains as a
  state cue. Clicking/activating a peek still navigates instantly regardless.

## 10. Autosave feedback ("✓ saved" hint)

- Typing updates the stored draft immediately (no visual debounce on the data) — the debounce only
  gates the **confirmation hint**, so nothing is ever silently lost if the tab closes mid-debounce
  (the last non-empty text is always the one in memory).
- **700ms** after the last keystroke with no further typing: the "✓ saved" hint (check icon + label
  "saved", right side of the editor's extension bar, `role="status" aria-live="polite"`) fades in
  over **150ms, `std`**.
- It stays visible for **1400ms**, then fades out over **300ms, `acc`** (state-feedback.md's success
  confirmation shape kept low-intensity for Corporate: opacity only, no scale-pop/particles/bounce —
  those belong to the Playful preset this codebase doesn't use).
- Blur, prev/next navigation, and collapse each force an **immediate** save of any pending unsaved
  change (skip the 700ms debounce — the user has already signalled intent by leaving) before their
  own transition starts, so the hint's fade-in is never clipped mid-flight by an outgoing crossfade.
  Practically: if there's a dirty draft, run the save synchronously, then start §6/§7/§8's timeline
  on the next frame.
- Failure: replace the hint in the same slot with the inline danger error text ("couldn't save
  note. try again.") — same 150ms `std` fade-in — and leave it visible (no auto-hide) until the next
  save attempt succeeds or the user edits again.

## 11. Empty-note error (blocked navigation)

Triggered when the user tries to leave a note (prev/next buttons, peeks, ↑/↓, x, Esc, scrim click,
sidebar close) while the trimmed draft is empty (SALAMANDER_SPEC §D: "a note can never be empty").
Based on `patterns/state-feedback.md`'s **Inline Validation** recipe (border → red, text feedback,
optional shake), scaled down to Corporate/"Low" intensity and made **non-spatial** per the design
call already made for this feature (no slide-down, unlike that recipe's generic "error text slides
down + fades in"):

- **textarea border**: transitions directly to `danger` colour over **150ms, `std`** (colour-only —
  reuses the exact border-colour transition already used for the textarea's hover/focus states, just
  targeting the danger token instead of `lineStrong`/`accent`).
- **inline error text** ("a note can't be empty. add some text to continue.") appears in the editor
  bar's left slot — replacing the delete button? No: it takes the **same slot the "✓ saved" hint /
  save-failure text uses** (right side), since delete must stay reachable (§8 — delete is exempt from
  the block). Fades in over **200ms, `std`**, no movement.
- **optional micro-shake**: a single tiny horizontal shake on the textarea, **±4px, 2 cycles,
  ease-in-out, 200ms total** — a toned-down dose of the skill's Error Shake recipe (±10–15px,
  2–3 cycles, 300–400ms total; "no overshoot: errors feel firm"). Fire it once, on the **first**
  blocked attempt while transitioning into the error state — do not re-shake on every repeated
  blocked click while the error is already showing (that reads as nagging, not firm). **Never** runs
  under `prefers-reduced-motion: reduce`, full stop, independent of whether the border/text fades
  also get reduced-motion treatment (they don't need to — they're already opacity/colour only).
- Focus stays in (or returns to) the textarea; the error text's `aria-live="polite"` region carries
  it to screen readers, same pattern as the existing add-mode/list notification banners.
- **Clears** as soon as non-whitespace text is typed: border fades back to its normal state over
  150ms `std`; error text fades out over **120ms, `acc`** (exit ≈ 65–75% of the 200ms entrance, per
  the entrance/exit asymmetry rule).

## 12. Reduced motion (`prefers-reduced-motion: reduce`)

Governing rule (kept from the existing spec): **no spatial motion** — layout/position changes
happen instantly; only crossfades remain, at roughly halved durations.

- **Expand**: total collapses to ~184ms (34ms trigger delay + 150ms fade window) vs. ~484ms normal.
  Panel width and every card's rect jump instantly (`transition: none` on the geometric properties);
  only opacity animates — scrim, list-fade-out, title/editor/rail-fade-in, badge and caption fades
  all keep running but at their `rd`-branched shorter durations (e.g. scrim 100ms not 200ms,
  list-only fade-out 75ms not 150ms, title/editor/rail-in 125ms not 200ms).
- **Collapse**: ~200ms vs. ~360ms, same halving pattern.
- **Prev/Next and Delete's carousel step**: replaced by fade-out (75ms `acc`) → instant index swap →
  fade-in, ~220ms total block, instead of the 400/580ms morph carousel. No card ever visibly travels.
- **Peek hover**: the ±7px lift never happens, under pointer or keyboard, full stop (§9).
- **Dock hover** (list, §9 reference / `src/dockMotion.ts`): magnification transforms are fully off;
  only the note background still fades in on hover/focus.
- **Autosave hint / empty-note error**: unaffected — both are already opacity/colour-only, which
  reduced motion permits — **except** the empty-note error's optional micro-shake, which is always
  suppressed regardless of any other reduced-motion branching.

## 13. Implementation notes

**FLIP with real DOM, in the closed shadow root.** All of this runs inside the sidebar's existing
closed shadow root (SALAMANDER_SPEC §6). Shared elements are real DOM nodes, not a virtual overlay
framework. Recipe per morphing card: **First** — measure the source rect
(`getBoundingClientRect()` on the real list item) once, before hiding it. **Last** — compute the
destination rect arithmetically (`slot('main'|'prev'|'next')`, no DOM read needed — it's fixed
geometry, §4). **Invert** — position/size the floating clone at Last, then apply a transform that
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

**Interruptibility.** The reference guards prev/next and delete with a single `busy` flag that
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
