# Fingerprinting

How the annotator re-locates the element behind a pin after the DOM has changed.

All code lives in `src/fingerprint.ts`. The on-disk shape lives in `src/types.ts` as the `Fingerprint` interface.

## Problem

A user pins an element today. Tomorrow they reopen the page; the DOM may have re-rendered, classes may have changed, the element may have moved, or several lookalikes may now exist (same button label on a different wizard step, same row in a re-sorted list). The pin needs to land on the right element — or refuse to land at all — rather than silently attaching to a lookalike.

## Two phases

1. **Capture** (`captureFingerprint`) — runs synchronously when the user clicks an element in annotation mode. Snapshots a bundle of signals.
2. **Resolve** (`resolveElement` / `resolvePageAnnotations`) — runs on page load. Collects candidates, scores them, picks the best one above a minimum threshold.

## Captured signals

### Structural — *how to find it*

| Field | Built by | What it is |
|---|---|---|
| `cssSelector` | `buildCSSSelector` | Stable selector, see priority ladder below |
| `xpath` | `buildXPath` | Stable XPath, see priority ladder below |
| `textSnippet` | inline | First 50 chars of `textContent`, trimmed |
| `tagName` | inline | Lowercase tag name |
| `rect` | inline | Bounding box at capture time. **Stored but not used at resolution** — `passesRectSanityCheck` is retained as dead code; visibility is enforced by `isVisible()` and disambiguation by scoring. |

#### `buildCSSSelector` priority ladder

1. Any `data-*` attribute on the element itself with a stable value → `tag[data-*="val"]` (globally unique, or rooted as `body > …`).
2. Element's own `id` if it (a) passes `hasUsableId` (rejects framework-generated forms: `:r17:`, `radix-*`, `headlessui-*`, `mui-*`, `chakra-*`, `aria-*`, pure-numeric, UUIDs, long hex) and (b) `idHasDictionaryWord` (at least one segment ≥3 chars in `WORD_LIST`).
3. Same element id without the dictionary check (legacy fallback).
4. Walk up to `<body>`, building the shortest uniquely-identifying path. At each node, `segmentFor` tries:
   - `tag[stable-attr="val"]` — `data-*` → `name` → `role` → relative/hash `href` on `<a>`. `aria-label` is intentionally excluded here (it lives in `closestLabel` only).
   - `tag.classname` — `getMeaningfulClass` strips CSS-module hash suffixes (`Button_primary_a8d3f` → `Button_primary`), rejects ALL-CAPS hashes, single/double-letter utilities, trailing-digit names, and Tailwind-style prefixes. Only used when unique among same-tag siblings.
   - `tag:nth-of-type(n)` — always emitted with an index, even for `n=1`, so the path is deterministic when same-tag siblings are added later.
5. After each push, check whether `body > <path>` is globally unique; if so, stop walking. Yields short, legible selectors and avoids the relative-selector false-positive class.

#### `buildXPath` priority ladder

1. `data-*` → `//tag[@data-attr="value"]`.
2. **Heading-anchored** → `//h2[normalize-space()="Section heading"]/following::button[normalize-space()="Save"][1]`. Prefers the sub-heading as the anchor over the page heading (tighter match). The XPath is verified to round-trip back to the exact target element before being accepted; falls back to the main heading if the sub-heading anchor doesn't verify.
3. Element's own dictionary-word id → `//*[@id="the-id"]`.
4. **Positional path** (`buildPositionalXPath`) — walk up to `<html>`, emit `tag[n]` at each level. Always emits the index, even for single siblings.

### Semantic context — *which one, if there are several*

These let resolution distinguish structurally-identical elements that appear in different sections / wizard steps / modal dialogs / data rows.

| Field | What it captures |
|---|---|
| `closestLabel` | First non-empty of: sub-heading → page heading → own `aria-label` (filtered: generic action words like "next", "save", "cancel" are skipped) → `aria-labelledby` → `aria-describedby` → nearest `<label>` ancestor or `role="label"` → `<label for="id">` association. Trimmed to 80 chars. |
| `pageHeading` | Nearest `h1`–`h4` or `role="heading"` that precedes the element in document order. Found by reverse-scanning **all** headings on the page and taking the last one before `el` (not by walking ancestors — wizard/tab layouts often put the step heading in a sibling container, not an ancestor). Trimmed to 80 chars. |
| `pageSubHeading` | Nearest heading between `pageHeading` and the element, at a **deeper** level than the page heading (e.g. when `pageHeading` is an `h2`, the sub-heading is the nearest `h3`/`h4` after it and before `el`). Bails when no page heading exists or the page heading is already `h4`. Trimmed to 80 chars. |
| `headingPath` | The **full ordered list** of `h1`–`h4` / `role="heading"` elements preceding the element in document order. Where `pageHeading` collapses the heading context to a single nearest value, this preserves the rest. Capped at the 10 most-recent entries; each trimmed to 80 chars. Excludes self and any heading that contains the target. |
| `sectionContext` | Nearest ancestor with `data-step` / `data-page` / `data-section` / `data-id` → `aria-label` on a sectioning tag (`SECTION` / `ARTICLE` / `ASIDE` / `FORM` / `DIALOG` / `MAIN` / `NAV` / `HEADER` / `FOOTER` / `DIV`) → `role="region"` / `dialog` / `form` / `tabpanel` / `tab`. Trimmed to 80 chars. |
| `siblingText` | `prev.textContent.trim()` + ` \| ` + `next.textContent.trim()`. Trimmed to 60 chars total. |
| `domIndex` | 0-based index of the element among all elements in the doc sharing the same `tagName` and same `textSnippet`. Disambiguates identical-looking items in lists / tables. |

## Resolution

```
resolveElement(fingerprint)
  ├─ collect candidates via 3 independent strategies → Set<Element>
  │   1. document.querySelectorAll(cssSelector)
  │   2. document.evaluate(xpath, …)            ← ORDERED_NODE_ITERATOR_TYPE
  │   3. all elements matching tagName whose snippet === textSnippet
  ├─ for each candidate: scoreCandidate(…)
  └─ return best if best ≥ MINIMUM_SCORE (40), else null
```

### Scoring (`scoreCandidate`)

**Visibility gate.** `isVisible()` checks `offsetWidth`/`offsetHeight`, computed `display` / `visibility` / `opacity`. Non-`HTMLElement` (SVG, etc.) is assumed visible. Failures return `-1000`, effectively disqualifying the candidate.

**Structural base score** — one of:

| Match type | Points |
|---|---|
| Unique CSS selector match | 60 |
| XPath match | 50 |
| Text+tag match, unique in doc | 40 |
| Text+tag match, non-unique | 20 |
| Non-unique CSS selector match | 30 |
| No structural match (shouldn't happen — gracefully returns -1000) | — |

**Context bonus / mismatch penalty** — via `scoreContext`, applied additively on top of the base score:

```
stored empty                        →   0     (signal not captured, no opinion)
stored non-empty + current matches  →  +bonus (confidence boost)
stored non-empty + current empty    →   0     (element not yet rendered, defer)
stored non-empty + current differs  →  −penalty (wrong context)
```

| Signal | +bonus | −penalty |
|---|---|---|
| `closestLabel` | 20 | 15 |
| `pageHeading` | 15 | **80** |
| `pageSubHeading` | 15 | 60 |
| `sectionContext` | 15 | 25 |
| `siblingText` | 10 | 10 |
| `domIndex` (match only) | 10 | 0 |

`headingPath` is scored separately by `scoreHeadingPath` (set-based, not single-value) and stacks additively with the row-by-row signals above:

| `headingPath` outcome | Contribution |
|---|---|
| stored ∩ current (common headings) | **+5 each, capped at +25** |
| stored-but-missing-from-current | **−7 each, capped at −50** |
| current-but-not-in-stored (extras) | **−5 each, capped at −30** |

Stored empty → returns 0 (no opinion), preserving the same backward-compat convention used everywhere else. The asymmetry between missing (−5) and extra (−3) is intentional: a stored heading we can't find on the candidate is the stronger mismatch signal (likely wrong section); an unexpected extra heading is weaker evidence (could just reflect page evolution since capture).

### Why heading mismatch is the heaviest penalty

The same button label ("Save", "Next", "Continue") repeats across wizard steps, tabs, and dialogs. Without a heavy heading-mismatch penalty, the resolver would happily attach a step-2 pin to the step-5 "Save" button because the structural signals all match. -80 ensures that even a unique CSS selector match (+60) cannot overpower a heading mismatch — i.e., wrong-section beats right-structure by design.

## Design choices worth knowing

- **Wide-net + score beats single strategy.** Multiple strategies finding the same element reinforces it (dedup'd via `Set`); near-misses get filtered by context penalties.
- **Stored-empty means "no opinion", not "mismatch."** Imported / legacy fingerprints lacking the optional context fields aren't penalised. All semantic-context fields are optional on the `Fingerprint` type for this reason.
- **`rect` is captured but unused at resolution.** The visibility gate + scoring system covers what the bounding-box check used to. `passesRectSanityCheck` is retained as dead code for possible future use.
- **The fingerprint type stays storage-stable.** `FingerprintWithRect` is a local extension only — the public `Fingerprint` interface in `types.ts` is kept stable for storage / YAML import-export compatibility.
- **Path-building always emits indices.** `:nth-of-type(n)` and `tag[n]` are emitted even when `n=1`, so paths don't silently re-anchor when same-tag siblings appear later.
- **`aria-label` is split across two signals.** Used in `closestLabel` only — never in the CSS selector (`getStableAttrSegment` deliberately excludes it). This avoids embedding human-readable label text in the structural selector, where it tends to be brittle.
- **`headingPath` and `pageHeading` coexist instead of one replacing the other.** They answer different questions: `pageHeading` is fast and gives a single high-confidence signal (-80 mismatch); `headingPath` is set-based, more permissive (+5/−5/−3), and catches cases where the nearest heading happens to collide across contexts (e.g. a stepper sidebar that puts the same heading at the end of every step's preceding-headings list). The XPath is intentionally **not** chained across the full path — chaining many headings would fail on any single drift, so we use `headingPath` for scoring only and keep the single-heading-anchored XPath for lookup.
