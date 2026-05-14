# Annotator Tech Design — Senior Engineer Critique #1

> **Author:** Senior engineer review (automated)  
> **Date:** 2026-05-14  
> **Design reviewed:** TECH_DESIGN.md v1.0  
> **Status:** Changes applied. See bottom of this file for full diff summary.

---

## Overall Assessment

Solid design. The architecture decisions are mostly correct — Shadow DOM for toolbar, on-demand injection, `chrome.storage.local`, esbuild, no `downloads` permission, idempotent own-write handling. The trade-offs section shows the author thought through the alternatives. This design is 85% ready to hand to a developer.

There are two genuine bugs that would have shipped broken behavior, a handful of implementation gaps that would have caused confusion or incorrect code, and one dead abstraction (`boundingBox` in storage) that should just be deleted. None of this requires redesigning anything. These are surgical fixes.

---

## Critical Bugs

### Bug 1: `beforeunload` cleanup kills reload persistence (§6.3)

**This is a logic error that directly contradicts itself in the same section.**

The design says:
1. `beforeunload` fires → content script calls `chrome.storage.local.remove('activeTab:' + myTabId)`
2. `chrome.tabs.onUpdated` fires with `status === 'complete'` → background checks `activeTab:{tabId}` → if present, re-injects

These two steps cannot coexist. `beforeunload` fires *before* the new page loads. By the time `onUpdated` fires with `status: 'complete'`, the key is already gone. The background finds nothing and does not re-inject. Reload persistence is silently broken.

The `beforeunload` handler should never touch `activeTab:{tabId}`. The key must persist through navigations. Only two things should clean it up: `chrome.tabs.onRemoved` (tab explicitly closed) and the startup stale-key sweep.

**Fix applied:** Removed `chrome.storage.local.remove(...)` from the `beforeunload` handler. `beforeunload` now only does in-page DOM cleanup (removes toolbar from page). The key lives until the tab is closed.

---

### Bug 2: `wasImported` state is untracked — confirmation dialogs #11 and #12 are indistinguishable (§8.1, §2.2)

The meta schema tracks `importedFilename: string | null`. When the user modifies annotations after import, `importedFilename` is cleared to null. At that point, the state is identical to "user created annotations from scratch, no import ever happened." There is no way to fire confirmation dialog #12 ("You have unsaved changes") vs. #11 ("This will replace your X annotations") correctly.

**Fix applied:** Added `wasImported: boolean` to the meta schema. Set to `true` at import time. Never reset on modification — only reset on delete-all or successful new import. Logic for confirmation selection:
- `wasImported && importedFilename === null` → case 12: "You have unsaved changes."
- Otherwise (annotations exist) → case 11: "This will replace your current X annotations."

---

## Important Gaps

### Gap 3: No manifest.json skeleton (§10.3)

The permissions are listed correctly in §10.3, but there is no manifest structure shown anywhere. This creates one significant footgun: `chrome.action.onClicked` **only fires if `action.default_popup` is absent from the manifest**. If a developer adds a popup for testing and forgets to remove it, `onClicked` never fires and the entire injection flow silently stops working. This will waste debugging hours.

The manifest also needs to show `"background": { "service_worker": "background.js" }` and the deliberate absence of a `content_scripts` entry (on-demand injection is the entire point, but it won't be obvious to every developer).

**Fix applied:** Added manifest.json skeleton to §10.3.

---

### Gap 4: `boundingBox` stored in `chrome.storage.local` but never used anywhere (§2.2)

The `Fingerprint` interface includes a `boundingBox` field. The design itself says: "hint only — not used for resolution; intentionally OMITTED from YAML export." Looking at every code path:
- Pin rendering (§5.4): uses `element.getBoundingClientRect()` live at render time
- Resolution (§4.4): does not use `boundingBox`
- Export (§9.3): omits it

This field is pure dead weight in storage. Every annotation wastes ~40 bytes on stale position data that is never read after it's written. The comment "intentionally OMITTED from YAML export" implies the author knew it was useless but kept it anyway with no rationale.

**Fix applied:** Removed `boundingBox` from the `Fingerprint` storage interface. It is captured live via `getBoundingClientRect()` wherever needed. Updated concrete storage example accordingly.

---

### Gap 5: CSS class instability detection regex is wrong in both directions (§4.2)

The pattern `/[a-z]{1,3}_[a-z0-9]{4,}/` is supposed to detect "generated/hashed" class names. It fails in both directions:

**False negatives (misses real generated classes):**
- CSS Modules: `_3mHRe`, `Button__container--active_3mHRe` (starts with `_`, contains `--`)
- Numeric-only: `c123456`

**False positives (incorrectly flags stable classes):**
- Tailwind utilities: `bg-blue-500`, `text-sm`, `flex-1` — these are stable, meaningful selectors

The approach of detecting "generated" classes by regex is fundamentally fragile. There is no regex that reliably distinguishes "Tailwind class written by a human" from "CSS Module hash emitted by a build tool." They look too similar.

**Fix applied:** Removed the class instability detection entirely. Step 3 of the CSS selector algorithm now falls directly to `tagName:nth-of-type(n)` when no ID or `data-*` is present. Classes may be included in the selector *alongside* `nth-of-type` for readability, but they are not relied upon for uniqueness. Structural selectors are more reliable on the pages that matter — especially SPAs.

---

### Gap 6: `chrome.storage.session` not considered for tab activation state (§2.6)

The design uses `chrome.storage.local` for `activeTab:{tabId}` keys. `storage.local` is persistent — keys survive browser restarts, creating the stale-key problem that the startup cleanup sweep is designed to handle.

`chrome.storage.session` (Chrome 102+, MV3 only) is session-scoped and automatically cleared on browser restart. It is the correct storage tier for ephemeral UI state like "is toolbar active on this tab." Using it would eliminate the stale-key problem entirely — and remove the need for the `chrome.runtime.onStartup` cleanup sweep.

The design doesn't mention this at all. It's in the trade-offs section where it belongs.

**Fix applied:** Added §11.10 covering this trade-off. Added a note in §2.6 recommending `chrome.storage.session` and noting the Chrome 102+ floor. The current implementation still works correctly (after the `beforeunload` fix), but session storage is the cleaner long-term approach.

---

## Minor Issues

### Minor 1: Z-index table references a non-existent "hover overlay" (§5.3)

The z-index table lists "Annotator hover overlay" at `INT_MAX`. There is no hover overlay element — hover highlighting is done by adding a CSS class (`annotator-highlighted`) to page elements. No overlay div is created. This confused row implies there's a transparent overlay that needs to be above everything, which is not the implementation.

**Fix applied:** Removed the "hover overlay" row. Hover highlight works via CSS class injection, not a z-indexed overlay element.

---

### Minor 2: Popover not closed on SPA URL change (§6.4)

`handleUrlChange()` clears rendered pins and updates toolbar state, but there's no mention of the popover. If a user has the popover open and the SPA navigates, the popover stays on screen with no backing annotation. 

**Fix applied:** Added `closePopover(false)` as the first step in `handleUrlChange()`.

---

### Minor 3: `chrome.tabs.sendMessage` after `executeScript` should handle failures (§6.1)

The `executeScript` callback fires after the script has fully executed synchronously, so the content script's listener IS registered — no race condition here. However, `sendMessage` can fail if the tab navigated between inject and callback (rare but possible). The code should wrap the `sendMessage` call or check `chrome.runtime.lastError`.

**Fix applied:** Added `chrome.runtime.lastError` check in §6.1 code example.

---

## What Is NOT Over-Engineered

The trade-offs section is well-reasoned. All of these are correct calls:
- Shadow DOM for toolbar, plain DOM for pins ✅
- `chrome.storage.local` over IndexedDB ✅
- On-demand injection over `content_scripts` in manifest ✅
- No MutationObserver ✅
- No Popper.js/Floating UI ✅
- No `downloads` permission ✅
- esbuild ✅
- Idempotent own-write handling instead of suppression ✅

The only mild case: per-annotation `created_at` in the export schema. Requirements only specify a file-level timestamp. Per-annotation timestamps add complexity to serialization/validation without a clear v1 use case. It's harmless — kept — but worth noting as a "nice to have" that wasn't required.

---

## Changes Made to TECH_DESIGN.md

| Section | Change | Reason |
|---------|--------|--------|
| §2.2 Fingerprint interface | Removed `boundingBox` | Never read after storage write |
| §2.2 Meta schema | Added `wasImported: boolean` | Enables correct confirmation dialog selection (bug fix) |
| §2.2 Concrete example | Updated to reflect both changes above | Consistency |
| §2.6 Tab Activation | Added note recommending `chrome.storage.session` | Better-fit storage tier |
| §4.2 CSS Selector | Removed class instability regex; classes excluded from uniqueness test | Regex was wrong in both directions |
| §5.3 Z-index table | Removed "hover overlay" row | Non-existent element |
| §6.1 Injection flow | Added `lastError` check on `sendMessage` | Defensive error handling |
| §6.3 Full Page Reload | Fixed `beforeunload` handler — no longer removes `activeTab` key | Bug: was breaking reload persistence |
| §6.4 SPA Navigation | Added `closePopover(false)` as first step of `handleUrlChange` | Open popover would orphan on navigation |
| §8.1 Import pipeline | Added `wasImported = true` to store step | Required for bug fix #2 |
| §10.3 Permissions | Added manifest.json skeleton with default_popup footgun warning | Developer onboarding gap |
| §11 Trade-offs | Added §11.10: chrome.storage.session for tab activation | Was missing from alternatives |
