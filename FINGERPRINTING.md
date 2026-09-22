# Fingerprinting

How the extension identifies the DOM element behind a captured feedback item, for a human or
coding agent reading the exported `feedback.md` later.

All code lives in `src/selectorBuilder.ts` (selector/xpath generation) and `src/contextCapture.ts`
(everything built on top of it — primary target, contained elements, area text, page metadata,
size governance). The on-disk shape is `CapturedContext` in `src/types.ts`; the exported shape is
the json record in `src/bundle/v2.ts` (REQUIREMENTS FR-CX, FR-EX-5).

## Why this is simpler than it used to be

v1 pinned a live element on the page and had to *re-find* it later — after reloads, re-renders,
and layout drift. That required a scoring/resolution system (candidate collection, context-signal
bonuses, heading-mismatch penalties) to pick the right lookalike out of several. See
`docs/v1-archive/FINGERPRINTING.md` for that system's full design.

The current extension never re-locates anything. A screenshot is captured once and stored as a
static image. The selector/xpath captured alongside it exist purely to **explain** where the
element lives in source — for someone reading the export, not for code to resolve later. That
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
dropped rather than resurrecting that dependency for a single XPath tier. XPath is a "fallback
identifier" only (FR-CX-1) — the primary explanatory value comes from the CSS selector, the
sanitised `outerHTML` snippet, and `contextCapture.ts`'s contained elements/area text, so the loss
is cosmetic.

## Context capture (`contextCapture.ts`)

Built on top of the selectors above. Given a selection rectangle (page coordinates),
`captureContext()` produces:

- **Primary target** — the deepest single element found by walking down from `<body>`, at each
  level descending into the one visible child whose page-rect *fully contains* the selection rect.
  Stops (and returns the current node) as soon as no single child qualifies, or the qualifying
  child is an `<iframe>` (iframes are always leaves — see below); `<script>`, `<style>`,
  `<template>` and `<noscript>` subtrees are never entered. This approximates "deepest common
  ancestor of everything inside the box" without `elementsFromPoint()` or a real layout engine, so
  it is testable in jsdom; it is document-order-biased for absolutely-positioned overlaps, which is
  acceptable for an "explain where this is" feature.
- **Contained elements** — every visible descendant of the primary target (any depth) whose
  page-rect intersects the selection rect, scored (id 3 > key attrs 2 = direct text 2 > semantic
  class 1) and capped at 15, ties broken by document order. Iframe subtrees are never walked into.
  Each entry: tag, id, classes split into `semantic` vs `generated` (ALL-CAPS hashes, trailing-digit
  hashes, CSS-module suffixes), key attributes (`data-*`, `aria-*`, `role`, `href`, `alt`, `name`,
  `type`, `placeholder`), direct text ≤100 chars.
- **Area text** — the direct (non-subtree) text of the primary target plus every contained element,
  in document order, adjacent-duplicate-collapsed, joined with spaces. A fast semantic summary, not
  a pixel-accurate text-range extraction.
- **Page metadata** — URL, normalised URL, title, viewport, DPR, the selection rect itself, and an
  ISO 8601 capture timestamp. (In the bundle only `page_title` is written from here; the rest are
  item-level fields and import rebuilds this block from them.)
- **Size governance** — 2KB total budget (JSON-length proxy for bytes). If exceeded: shrink the
  primary target's `outerHTML` snippet first (already capped at 1KB and sanitised of `<script>`/
  `<style>` bodies and base64 data-URIs) in ×0.7 steps, then — only if still over budget — trim the
  contained-elements list from its lowest-priority end, setting `containedElementsTruncated`.
  Always leaves a `"...[truncated]"` marker, never a silent cut.

Cross-origin **and** same-origin iframes are treated the same way: tag/attrs (including `src`)
only, never descended into. Treating both uniformly avoids a same-origin/cross-origin branch that
would throw in the cross-origin case anyway.

## What the export does on top

`src/bundle/v2.ts` derives `text` (the primary target's visible text: tags dropped, entities
decoded, whitespace collapsed) from the stored `html` snippet at export time, and caps the free
text in the record — `text` 120, `html` 300, `area_text` 200, each contained element's `text` and
attribute values 80 — ending a cut value in a single `…` (capture's `...[truncated]` marker is
swapped for the same ellipsis). Selectors, xpaths, ids, class names and URLs are never cut: a
shortened selector is a wrong one. On import, a snippet ending in `…` is read back as truncated.

## What `wordlist.ts` is for

`idHasDictionaryWord()` is the "is this id human-authored or a framework hash" heuristic — an id
like `checkout-total` passes because `checkout` and `total` are dictionary words; `radix-:r3:` and
`a1b2c3` don't. `wordlist.ts` is untouched from v1.
