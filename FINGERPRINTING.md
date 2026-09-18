# Fingerprinting

How the extension identifies the DOM element behind a captured feedback item, for a human or
coding agent reading the exported `feedback.md` later.

All code lives in `src/selectorBuilder.ts` (selector/xpath generation) and `src/contextCapture.ts`
(everything built on top of it — primary target, contained elements, area text, page metadata,
size governance). The on-disk shape lives in `src/types.ts` as `CapturedContext`.

## Why this is simpler than it used to be

v1 pinned a live element on the page and had to *re-find* it later — after reloads, re-renders,
and layout drift. That required a scoring/resolution system (candidate collection, context-signal
bonuses, heading-mismatch penalties) to pick the right lookalike out of several. See
`docs/v1-archive/FINGERPRINTING.md` for that system's full design.

v2 never re-locates anything. A screenshot is captured once and stored as a static image (§1.5 —
no live re-rendering). The selector/xpath captured alongside it exist purely to **explain** where
the element lives in source — for someone reading the export, not for code to resolve later. That
drops the entire resolution/scoring half of the system, and with it the "which lookalike is it"
context signals (`closestLabel`, `pageHeading`, `headingPath`, `sectionContext`, `siblingText`,
`domIndex`) that existed only to disambiguate structurally-identical candidates.

## Selector generation (`selectorBuilder.ts`)

Lifted from v1's `fingerprint.ts` essentially unchanged — these builders are mature and already
hardened against framework-generated hash IDs/classes.

### `buildCSSSelector` priority ladder

1. Any `data-*` attribute on the element itself with a stable value → `tag[data-*="val"]`
   (globally unique, or rooted as `body > …`).
2. Element's own `id` if it (a) passes `hasUsableId` (rejects framework-generated forms: `:r17:`,
   `radix-*`, `headlessui-*`, `mui-*`, `chakra-*`, `aria-*`, pure-numeric, UUIDs, long hex) and
   (b) `idHasDictionaryWord` (at least one `-`/`_`-separated segment ≥3 chars is a dictionary word).
3. Same element id without the dictionary check (legacy-style fallback).
4. Walk up to `<body>`, building the shortest uniquely-identifying path. At each node, `segmentFor`
   tries:
   - `tag[stable-attr="val"]` — `data-*` → `name` → `role` → relative/hash `href` on `<a>`.
     `aria-label` is intentionally excluded (too brittle/verbose as a structural selector part).
   - `tag.classname` — `getMeaningfulClass` strips CSS-module hash suffixes
     (`Button_primary_a8d3f` → `Button_primary`), rejects ALL-CAPS hashes, single/double-letter
     utilities, trailing-digit names, and Tailwind-style prefixes. Only used when unique among
     same-tag siblings.
   - `tag:nth-of-type(n)` — always emitted with an index, even for `n=1`, so the path stays
     deterministic when same-tag siblings are added later.
5. After each push, check whether `body > <path>` is already globally unique; if so, stop walking.

### `buildXPath` priority ladder

1. `data-*` → `//tag[@data-attr="value"]`.
2. Element's own dictionary-word id → `//*[@id="the-id"]`.
3. Positional path fallback (`buildPositionalXPath`) — walk up to `<html>`, emit `tag[n]` at each
   level, always with an index.

**Deviation from v1:** v1's `buildXPath` had a middle tier — a "heading-anchored" XPath
(`//h2[...]/following::button[...]`) anchored on the nearest preceding heading. That tier depended
on the heading-lookup helpers that belonged to the deleted resolution/scoring system, so it was
dropped rather than resurrecting that dependency for a single XPath tier. XPath is documented as a
"fallback identifier" only (§1.4A) — the primary explanatory value comes from the CSS selector, the
sanitised `outerHTML` snippet, and `contextCapture.ts`'s contained-elements/area-text, so the loss
is cosmetic.

## Context capture (`contextCapture.ts`)

New logic, built on top of the selectors above. Given a selection rectangle (page coordinates),
`captureContext()` produces:

- **Primary target** — the deepest single element found by walking down from `<body>`, at each
  level descending into the one child whose page-rect *fully contains* the selection rect. Stops
  (and returns the current node) as soon as no single child qualifies, or the qualifying child is
  an `<iframe>` (iframes are always treated as leaves — see below). This approximates "deepest
  common ancestor of everything inside the box" without needing `elementsFromPoint()` or a real
  layout engine.
- **Contained elements** — every descendant of the primary target (any depth) whose page-rect
  intersects the selection rect, scored (id > key attrs > direct text > semantic class) and capped
  at 15, ties broken by document order. Iframe subtrees are never walked into.
- **Area text** — the direct (non-subtree) text of the primary target plus every contained element,
  in document order, adjacent-duplicate-collapsed. A fast semantic summary, not a pixel-accurate
  text-range extraction.
- **Page metadata** — URL, normalised URL, title, viewport, DPR, the selection rect itself, and an
  ISO 8601 capture timestamp.
- **Size governance** — 2KB total budget (JSON-length proxy for bytes). If exceeded: shrink the
  primary target's `outerHTML` snippet first (already capped at 1KB, sanitised of `<script>`/
  `<style>` contents and base64 data-URIs), then — only if still over budget — trim the
  contained-elements list from its lowest-priority end. Always leaves a `"...[truncated]"` marker,
  never a silent cut.

Cross-origin **and** same-origin iframes are both treated the same way: tag/attrs (including `src`)
only, never descended into. §6 edge case 6 only requires this for cross-origin iframes; treating
both uniformly avoids a same-origin/cross-origin branch for a same-origin case v1 doesn't require
more thoroughness on.

## What `wordlist.ts` is for

`idHasDictionaryWord()` is the "is this id human-authored or a framework hash" heuristic — an id
like `checkout-total` passes because `checkout` and `total` are dictionary words; `radix-:r3:` and
`a1b2c3` don't. `wordlist.ts` is untouched from v1.
