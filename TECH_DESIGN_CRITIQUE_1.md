# TECH_DESIGN_CRITIQUE_1.md — Senior Engineer Review

> **Date:** 2026-05-14  
> **Reviewer:** Senior Engineer (AI review pass)  
> **Document reviewed:** `TECH_DESIGN.md` v1.0 Draft  
> **Requirements reviewed:** `REQUIREMENTS.md`

---

## Overall Assessment

The design is solid in structure and covers the happy path well. Architecture choices are sound (MV3, `chrome.storage.local`, Shadow DOM for toolbar, on-demand injection). The YAML schema is clean and normative. The import pipeline logic is thorough.

However, there are **several implementation-blocking gaps** — particularly around tab ID acquisition, storage concurrency, missing UI sections (popover, annotation mode mechanics), and SPA navigation edge cases. If an engineer starts building from this document, they will hit these gaps and either make a bad decision or block.

Issues are categorized: **Critical** (blocks implementation or silently produces wrong behavior), **Significant** (causes bugs or implementation confusion), **Minor** (polish, potential future pain).

---

## Critical Issues

### C1: Content script cannot self-identify its tab ID

**Location:** §2.6, §6.1, §6.3

The design says the content script "registers its tab ID in `activeTabIds`." But content scripts in MV3 have no reliable way to get their own tab ID. `chrome.tabs.getCurrent()` is unreliable in content scripts and returns `undefined` when called from a background-injected script. The content script needs this ID to manage `activeTabIds`.

**Fix:** The background knows the tab ID at injection time. It must pass the tab ID to the content script — either as part of the `{ type: "ACTIVATE", tabId }` message (for icon-click injection), or by having the background respond to the PING with `{ alive: true, tabId }`. The content script stores this locally as `let myTabId`.

The design has been updated to reflect this.

---

### C2: `activeTabIds` shared array has a read-modify-write race condition

**Location:** §2.2, §2.6, §6.3

Multiple tabs doing `get("activeTabIds")` → mutate → `set("activeTabIds")` concurrently will clobber each other. `chrome.storage.local` is not transactional. Tab A and Tab B can both read `[1, 2]`, Tab A writes `[1, 2, 3]`, Tab B writes `[1, 2, 4]` — and Tab A's entry is lost.

**Fix:** Replace the shared array with per-tab keys: `activeTab:{tabId}: true`. Each tab owns its own key and never touches other tabs' keys. No read-modify-write pattern needed. Background checks `chrome.storage.local.get('activeTab:' + tabId)`. The design has been updated throughout.

---

### C3: Pin numbering race condition is undocumented

**Location:** §2.5

Two tabs annotating simultaneously: both read `nextPinNumber: 5`, both write pin #5, and one clobbers the other. The design accepts "last write wins" for storage conflicts generally, but the pin number collision is silent — the user ends up with duplicate pin numbers in their data. The design doesn't mention this and doesn't document it as a known limitation.

This is not worth a complex fix (CRDTs, etc.) for v1, but it must be documented so implementers don't be surprised.

**Fix:** Document this in §2.5 and §7.3 as a known v1 limitation. The design has been updated with an explicit callout.

---

### C4: `suppressNextChange` flag is fragile and should be removed

**Location:** §7.4

The boolean + `setTimeout(..., 100)` approach for own-write deduplication has multiple failure modes:

1. Two writes within 100ms: the second write resets the flag before the first `onChanged` fires
2. The `onChanged` callback can fire immediately in the same event loop tick, before `suppressNextChange = true` is evaluated in some edge cases
3. The 100ms window is arbitrary and network-unrelated — there's no principled basis for it

The entire mechanism is unnecessary. The `refreshPinsFromStorage` diff logic described in §7.2 is already idempotent: "Pins in both → update note (no re-render needed unless offset changed)." Applying an own-write update is a no-op re-render. Just remove `suppressNextChange` entirely and always process `onChanged`.

**Fix:** Remove `suppressNextChange` from the design. Add a note that `refreshPinsFromStorage` must be idempotent to handle own-write events safely.

---

### C5: No implementation section for annotation mode hover and click interception

**Location:** Missing entirely

The requirements specify that annotation mode suppresses all native clicks (§3.1), highlights hovered elements (§3.1), and that scrolling still works. None of this is described technically. An implementer reading this design doesn't know:

- Whether to use `capture: true` or `bubble` phase for click interception
- How to avoid highlighting annotator's own UI elements (pins, toolbar, popover)
- How to avoid highlighting iframes
- Whether to use `mouseover`/`mouseout` or `mouseenter`/`mouseleave`
- What happens to hover state when a popover is open

A new section has been added: **§6.6 Annotation Mode — Hover & Click Implementation**.

---

### C6: No implementation section for the popover

**Location:** Missing entirely

The popover is the central UI element for creating and editing annotations. The design references it extensively (state machine in §6.5, requirements §3.2) but provides zero implementation guidance on:

- DOM structure of the popover
- How it's positioned relative to the pin (the 4-corner overflow algorithm mentioned in §11.9 is described in prose, not code)
- Click-outside detection (important: must not conflict with annotation mode's click interception)
- Character counter updates
- Focus management (textarea should focus on open)
- Delete confirmation dialog implementation
- Whether it uses Shadow DOM or plain DOM

A new section has been added: **§6.7 Popover Implementation**.

---

### C7: SPA navigation missing `hashchange` event

**Location:** §6.4

The design handles `pushState`/`replaceState` monkey-patching and `popstate`. But hash-based routing (`#/home`, `#/about`) — used by older React Router v5, Vue Router hash mode, and many legacy SPAs — triggers `hashchange`, not `pushState`. A SPA using hash routing will navigate without the content script noticing, leaving stale pins from the old page visible.

**Fix:** Add `window.addEventListener('hashchange', handleUrlChange)`. Updated in §6.4.

---

## Significant Issues

### S1: Closed Shadow DOM reference not stored

**Location:** §5.5

`attachShadow({ mode: 'closed' })` returns the shadow root at creation time. After that, `element.shadowRoot` is `null` — external code can't access it. The design says to use `mode: 'closed'` but doesn't explicitly say to store the returned shadow root. An implementer who writes `host.attachShadow({ mode: 'closed' })` without storing the return value has an inaccessible shadow root.

**Fix:** Explicitly note: `const toolbarShadow = host.attachShadow({ mode: 'closed' })`. Store `toolbarShadow` in the module scope for all subsequent toolbar DOM operations. Updated in §5.5.

---

### S2: File input not reset after import attempt

**Location:** §8.1

After a failed import, if the user tries to upload the same file (e.g., after fixing the file), the `<input type="file">` `change` event won't fire — the browser sees the value as unchanged. The input must be reset to `''` after every import attempt (success or failure) to allow re-selection.

**Fix:** Add `input.value = ''` as the last step in the import pipeline (after success or error display). Added to §8.1.

---

### S3: Schema validation doesn't check types or fingerprint sub-fields

**Location:** §8.4

The current `validateSchema` only checks for key presence with `!ann.field` checks. Problems:

- `!ann.note` is `true` for empty string `""`. An imported annotation with `note: ""` would be incorrectly rejected as malformed. The correct check is `typeof ann.note !== 'string'`.
- `pin_number` is not checked to be a positive integer. A file with `pin_number: "foo"` would pass.
- `fingerprint` sub-fields (`css_selector`, `xpath`, `text_snippet`, `tag_name`) are not validated to be strings. A `fingerprint: {}` would pass schema validation and fail silently during resolution.
- `offset.x`/`offset.y` are not validated to be numbers.

**Fix:** Validate types explicitly. Updated `validateSchema` in §8.4.

---

### S4: Error notification timer can be cancelled by a later error

**Location:** §8.6

The 8-second auto-clear timeout is set on each error display. If a new error fires before the first clears, two timers are running. The first timer fires and clears the newer error message. The notification area needs to clear any existing timer before setting a new one.

**Fix:** Use a single `let notifTimer = null` in the notification module. Before setting a new timer, call `clearTimeout(notifTimer)`. Updated in §8.6.

---

### S5: Fixed-position pins unnecessarily updated on scroll

**Location:** §5.6

The throttled `reposition` function iterates all active pins on scroll. Fixed-position pins don't scroll — updating them on every scroll event is wasted work (potentially 60x/second if the user is scrolling fast with many pins).

**Fix:** Skip `updatePinPosition` for `isFixed === true` pins inside the scroll listener. Only update them on resize (where viewport geometry actually changes). Updated in §5.6.

---

### S6: `boundingBox` in Fingerprint is stored internally but not exported — undocumented asymmetry

**Location:** §2.2, §3.1

The internal `Fingerprint` interface includes `boundingBox`. The YAML schema (§3) does not include it. This is a correct decision (bounding box is a hint used for future resolution, not needed for export), but the asymmetry is not mentioned anywhere. An implementer building the export serializer might include it by mistake, and someone reviewing the storage format vs. YAML schema will be confused.

**Fix:** Add an explicit note in §2.2 and §3.2 that `boundingBox` is internal-only and intentionally omitted from the export format.

---

## Minor Issues

### M1: `CURRENT_VERSION` constant is referenced but never defined

The code snippets in §8.3, §8.4, §8.5, and §9.1 reference `CURRENT_VERSION` and `CURRENT_EXPORT_VERSION` but neither constant is defined anywhere in the design. Easy fix but a real gap for implementers.

**Fix:** Define in §3.4: `const CURRENT_EXPORT_VERSION = 1;`. This is the only version constant needed (internal storage schema version is independent and handled separately).

---

### M2: Stale `activeTab:{tabId}` keys not cleaned up on background restart

After a browser or extension restart, previously stored `activeTab:{tabId}` keys may reference tabs that no longer exist. The background should call `chrome.tabs.query({})` on startup and remove stale `activeTab:*` keys for tabs not in the result. This prevents phantom re-injections.

**Note:** Added as an implementation note in §6.3.

---

### M3: `history.replaceState` patching can affect more than navigation

`history.replaceState` is used by SPAs for URL cleanup (e.g., removing auth tokens from the URL bar) without actual navigation intent. Calling `handleUrlChange` on every `replaceState` could trigger unnecessary pin re-renders. In practice, the URL comparison in `handleUrlChange` ("if URL changed from last known URL") already prevents redundant work — but this is worth documenting.

**No change needed** — the design's URL comparison guard handles this correctly. Just noting it's intentionally covered.

---

### M4: YAML `sortKeys: false` — field order depends on JS object insertion order

With `sortKeys: false`, field order in the YAML output matches the JS object's property order. If the doc object is built in a different order than the schema example in §3.1, the YAML output won't match. Not a functional issue, but readability suffers. The export serializer should build the annotation objects in schema order.

**Fix:** Added a note in §9.3 that the doc object must be built in schema-documented field order.

---

## Summary Table

| # | Issue | Severity | Fixed in TD? |
|---|-------|----------|--------------|
| C1 | Content script can't self-identify tab ID | Critical | ✅ |
| C2 | `activeTabIds` shared array race condition | Critical | ✅ |
| C3 | Pin number collision under concurrent tabs | Critical | ✅ (documented) |
| C4 | `suppressNextChange` fragile flag | Critical | ✅ (removed) |
| C5 | Missing annotation mode implementation | Critical | ✅ (new §6.6) |
| C6 | Missing popover implementation | Critical | ✅ (new §6.7) |
| C7 | `hashchange` missing from SPA detection | Critical | ✅ |
| S1 | Closed shadow root ref not stored | Significant | ✅ |
| S2 | File input not reset after import | Significant | ✅ |
| S3 | Shallow schema validation, wrong note check | Significant | ✅ |
| S4 | Error notification timer not reset | Significant | ✅ |
| S5 | Fixed pins repositioned on scroll | Significant | ✅ |
| S6 | `boundingBox` asymmetry undocumented | Significant | ✅ |
| M1 | `CURRENT_VERSION` undefined | Minor | ✅ |
| M2 | Stale tab keys not cleaned on restart | Minor | ✅ (noted) |
| M3 | `replaceState` over-triggering | Minor | No change needed |
| M4 | YAML field order not guaranteed | Minor | ✅ |

---

## Changes Made

All changes made to `TECH_DESIGN.md`:

1. **§1.3 Message table** — Added `tabId` to `ACTIVATE` message payload. Added PING response returns `tabId`. Added explanation of how content script acquires its tab ID.

2. **§2.2 Storage Schema** — Replaced `activeTabIds: Array<number>` with `activeTab:{tabId}: boolean` per-tab key pattern. Added note that `boundingBox` in Fingerprint is internal-only and not exported.

3. **§2.5 Pin Number Management** — Added explicit documentation of the known concurrent-tab pin number collision limitation.

4. **§2.6 Tab Activation State** — Rewrote to use per-tab key pattern (`activeTab:{tabId}`) instead of shared array. Explained race-condition rationale.

5. **§3.2 Field Reference** — Added note that `boundingBox` is intentionally absent from the export schema.

6. **§3.4 Versioning Strategy** — Added `const CURRENT_EXPORT_VERSION = 1` constant definition.

7. **§5.5 Toolbar Style Isolation** — Added explicit note that the shadow root returned by `attachShadow({ mode: 'closed' })` must be stored in module scope for subsequent DOM operations.

8. **§5.6 Scroll and Resize Behaviour** — Updated `reposition` to skip fixed-position pins during scroll events; only recalculate them on resize.

9. **§6.1 Injection Flow** — Updated step 4/5 to show `tabId` passed in ACTIVATE message. Updated PING response to include tabId.

10. **§6.3 Full Page Reload Persistence** — Rewrote `tabs.onUpdated` and `tabs.onRemoved` handlers to use `activeTab:{tabId}` key. Added note about background startup cleanup of stale keys.

11. **§6.4 SPA Navigation Detection** — Added `window.addEventListener('hashchange', handleUrlChange)` as a third detection mechanism.

12. **§7.4 Own-Write Deduplication** — Removed `suppressNextChange` mechanism entirely. Replaced with explanation that `refreshPinsFromStorage` must be idempotent and own-write `onChanged` events are handled correctly by the existing diff logic.

13. **§8.1 Import Pipeline** — Added "reset file input" as final step in the pipeline (after success or error).

14. **§8.4 Schema Validation** — Rewrote `validateSchema` to check types explicitly: `typeof ann.note !== 'string'`, integer check for `pin_number`, string checks for fingerprint sub-fields, number checks for `offset.x/y`.

15. **§8.6 Error Display** — Added `let notifTimer = null` with `clearTimeout` before each new notification to prevent old timers from clearing newer messages.

16. **§9.3 YAML Serialisation** — Added note that doc object must be built in schema-documented field order when `sortKeys: false`.

17. **New §6.6 Annotation Mode — Hover & Click Implementation** — Added full section covering: capturing-phase click interception, `mouseover`/`mouseout` hover highlight with self-exclusion guard, highlight CSS injection, annotation click dispatch (pin click vs. new annotation).

18. **New §6.7 Popover Implementation** — Added full section covering: Shadow DOM structure, position calculation with 4-corner fallback, click-outside detection interaction with annotation mode, focus management, character counter, delete confirmation flow.
