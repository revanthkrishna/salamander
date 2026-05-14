# Requirements Issues — Critical Review

> Reviewed against: `REQUIREMENTS.md` (current HEAD as of review)
> Verdict: **✅ Requirements complete.** All issues resolved, closed, or deferred to technical design where appropriate.

---

## 🔴 Critical Issues

### C1 — ✅ RESOLVED — Storage mechanism is completely undefined

**Resolution:** §2 Storage section now defines persistence across browser restarts, local-to-device storage, 8MB minimum, and `chrome.storage.local` as the recommended candidate. Final choice deferred to technical design, which is appropriate.

---

### C2 — ✅ DEFERRED TO TECHNICAL DESIGN — No YAML schema defined anywhere

**Resolution:** The reqs doc intentionally leaves exact field names, nesting, and schema structure to technical design. §1.3.1 defines what data must be present; the YAML schema is an implementation decision, not a product requirement.

---

### C3 — ✅ DEFERRED TO TECHNICAL DESIGN — Extension architecture is absent

**Resolution:** Content script structure, service worker, and inter-component communication are implementation decisions that belong in the technical design doc, not the requirements. The reqs define the observable behavior (permissions, toolbar injection UX, tab sync, SPA navigation) — how it's wired up internally is out of scope here.

---

### C4 — ✅ RESOLVED — Cross-page state propagation model is undefined

**Resolution:** §2 Toolbar Activation & Persistence now defines all navigation scenarios: new tab requires extension icon click; full page reload re-activates the toolbar automatically; SPA navigation keeps the toolbar visible with annotation mode off and pins updated.

---

### C5 — ✅ RESOLVED — Version field mentioned but never defined

**Resolution:** §1.3.1 now includes "Extension version number (for forward compatibility — enables version mismatch detection on import)" as a required export field, making §5 #6 implementable.

---

### C6 — ✅ RESOLVED — "File version mismatch" is future-proofing without a version

**Resolution:** Covered by C5 resolution. Version field is now in the export spec; the extension can compare file version against its own format version.

---

## 🟡 Ambiguities & Gaps

### A1 — ✅ RESOLVED — "Active" is never formally defined

**Resolution:** Formally defined at the top of REQUIREMENTS.md: "The extension is considered active on a page when the floating toolbar is visible."

---

### A2 — ✅ RESOLVED — Edit UX is barely specified

**Resolution:** §3.2 now specifies the full popover: pre-filled text when opening an existing annotation, same "Add" button label for both create and edit, character counter always visible, ✕ or click-outside discards unsaved changes, Add button disabled when empty.

---

### A3 — ✅ RESOLVED — Empty annotation text not addressed

**Resolution:** §3.2 states the Add button is disabled when the text input is empty — blank annotations cannot be saved.

---

### A4 — ✅ RESOLVED — Popover overflow/positioning is unspecified

**Resolution:** §3.2 now specifies default position (bottom-right of the pin) with overflow fallback order: top-right → top-left → bottom-left.

---

### A5 — ✅ RESOLVED — "Closest visible edge" for pin anchoring is undefined

**Resolution:** §3.3 Pin Placement replaces the ambiguous language: pin appears at the exact click point, stored as (x, y) offset from the element's top-left corner, recalculated dynamically as `element top-left + stored offset` when the element moves.

---

### A6 — ✅ RESOLVED — Global pin numbering on import + additions is ambiguous

**Resolution:** §1.1 now explicitly states numbering always continues from the highest pin in storage, whether user-created or imported, with a concrete import example covering gap cases.

---

### A7 — ✅ RESOLVED — What is exported when annotations are from an import + local edits?

**Resolution:** Journey 2 step 10 updated — export is simply the current state; no provenance tracking. Fully consistent with §1.4 ("importing replaces state entirely").

---

### A8 — ✅ RESOLVED — Annotations on unvisited pages during export

**Resolution:** §1.4 explicitly states export includes ALL stored annotations, including those for unvisited pages. Round-trip fidelity is guaranteed.

---

### A9 — ✅ RESOLVED — No storage quota handling

**Resolution:** Explicitly out of scope for v1. No special behavior required.

---

### A10 — ✅ RESOLVED — No file size limit on import

**Resolution:** 8MB import cap added as error case #13 in §5.

---

### A11 — ✅ RESOLVED — Multi-tab same-domain behavior

**Resolution:** §2 Multi-Tab Behavior section added. All active tabs sync via `chrome.storage.onChanged`; last-write-wins for concurrent edits.

---

### A12 — ✅ RESOLVED — URL normalization incomplete

**Resolution:** §6 edge cases #14–17 cover trailing slashes, case sensitivity, www prefix, and port numbers.

---

### A13 — ✅ RESOLVED — Domain matching for subdomains

**Resolution:** www prefix is normalized away (same domain); all other subdomains are distinct. See §6 #16.

---

## 🟠 Contradictions

### X1 — ✅ RESOLVED — Silent failure vs. warning for unresolved elements

**Resolution:** §3.4 Import Resolution Alerts defines per-page alerts below the filename: some unresolved → 🟡 yellow; all unresolved → 🔴 red; none targeted or all resolved → no alert. Updates on every page navigation.

---

### X2 — ✅ RESOLVED — Annotation mode auto-activation on import

**Resolution:** §1.4 and §3.1 now explicitly state auto-enter on import (current page only). Journey 2 step 8 ("entering annotation mode on each page") refers to pages visited after the import page, where manual activation is required — not a contradiction.

---

### X3 — ✅ RESOLVED — Error classification: Confirmations labeled as Errors

**Resolution:** §5 defines two distinct patterns: inline error/warning messages (above toolbar) and confirmation dialogs (blocking modal). Cases #11 and #12 reclassified as 💬 Confirmation dialogs, matching the Delete All pattern in §1.5.

---

### X4 — ✅ RESOLVED — "Replaces current state entirely" vs. merged export

**Resolution:** Journey 2 step 10 updated: export dumps current unified state; no provenance tracking. Fully consistent with §1.4.

---

### X5 — ✅ RESOLVED — Pins visible rule vs. Journey 2 import flow

**Resolution:** Auto-enter annotation mode on import is intentional. Added explicitly to §1.4 and §3.1.

---

## 🔵 UX / Logic Problems

### U1 — ✅ RESOLVED (by design) — Auto-entering annotation mode on import suppresses all native clicks

**Resolution:** Intentional for v1. User exits annotation mode via Exit button when they want to navigate.

---

### U2 — ✅ OUT OF SCOPE (v1) — No read-only view mode exists

**Resolution:** No view mode in v1. Annotations are only visible in annotation mode. Accepted limitation.

---

### U3 — ✅ RESOLVED — Silent success on import with no matching current-page pins is confusing

**Resolution:** §3.4 alert system disambiguates all states: no filename shown means import failed; filename with no alert means import succeeded but this page has no annotations in the file; red/yellow alert means annotations exist for this page but couldn't be placed.

---

### U4 — ✅ RESOLVED (by design) — Global pin numbering has no user-visible purpose

**Resolution:** Global continuous numbering is intentional — pin numbers serve as a cross-domain reference system ("see pin 12").

---

### U5 — ✅ OUT OF SCOPE (v1) — No undo

**Resolution:** Deletion requires a confirmation dialog (§3.2). Permanent deletion by design; no undo for v1.

---

### U6 — ✅ RESOLVED — Domain mismatch error has no override

**Resolution:** www normalization (A12/A13) eliminates the frustrating case — `www.example.com` and `example.com` are treated as the same domain.

---

### U7 — ✅ RESOLVED (by design) — No indication of how many annotations were loaded

**Resolution:** No import success count shown by design. Partial/no resolution surfaces via §3.4 page-level alerts; otherwise import succeeded.

---

## ⚪ Missing Edge Cases

### E1 — ✅ RESOLVED — Trailing slash URL normalization
Trailing slash is stripped; treated as same URL. See §6 #14.

### E2 — ✅ RESOLVED — Case-sensitive URLs
Path is case-sensitive; hostname is lowercased. See §6 #15.

### E3 — ✅ RESOLVED — Extension icon clicked while toolbar already visible
Toolbar stays open. No toggle, no duplicate injection. See §6 #18.

### E4 — ✅ OUT OF SCOPE — Content scripts don't run on chrome:// or extension pages
Chrome system pages are not annotatable. No handling needed.

### E5 — ✅ RESOLVED — Annotating a page behind auth
Standard red page-level alert fires if elements can't be resolved. See §6 #19.

### E6 — ✅ RESOLVED — Fixed-position elements
Pin position must use `getBoundingClientRect()` (viewport-relative) for fixed elements. See §6 #20.

### E7 — ✅ ACCEPTED (v1) — Element removed from DOM after annotation (non-SPA case)
Silent-skip + page-level alert handles it. Accepted v1 limitation.

### E8 — ✅ RESOLVED — Large imports
8MB file size cap added as error case #13 in §5.

### E9 — ✅ RESOLVED — YAML file character encoding
UTF-8 required for export and import. See §6 #21.

### E10 — ✅ RESOLVED — Duplicate pin numbers in imported file
File rejected with red error above toolbar. See §5 #14.

### E11 — ✅ RESOLVED — Annotating a page, then the page URL changes (SPA client-side routing)
Extension must listen for URL changes and update displayed pins. Covered by §2 Toolbar Activation & Persistence (SPA navigation behavior).

### E12 — ✅ RESOLVED (by design) — Undo / accidental deletion
Confirmation dialog required before deletion (§3.2). No undo for v1.

### E13 — ✅ OUT OF SCOPE (v1) — Extension update while annotations are stored
Extremely rare edge case. Ignored for v1.

---

## 💡 Recommendations

### R1 — OPEN — Define the YAML schema explicitly with a code block

§1.3.1 now lists required fields by name (version, domain, pin number, URL, selector, XPath, text snippet, tag, note, offset) but defers field names and nesting to technical design. A normative YAML example would make import validation (#4) testable and prevent schema divergence across implementations.

---

### R2 — ✅ RESOLVED — Define the storage strategy in §2

**Resolution:** §2 Storage section added with persistence requirements and `chrome.storage.local` as the recommended mechanism.

---

### R3 — ✅ DECLINED (by design) — Replace auto-annotation-mode on import with a view mode

**Resolution:** Auto-enter annotation mode on import is intentional for v1. No view mode. See U1/U2.

---

### R4 — ✅ DECLINED (by design) — Add a summary message on successful import

**Resolution:** No success count shown by design. Per-page resolution alerts in §3.4 surface what matters. See U7.

---

### R5 — ✅ RESOLVED — Resolve the silent-vs-warned contradiction (X1)

**Resolution:** See X1 resolution. Per-page alerts with red/yellow styling in §3.4.

---

### R6 — ✅ RESOLVED — Define URL normalization completely

**Resolution:** §6 edge cases #14–17 define full normalization rules.

---

### R7 — ✅ RESOLVED — Add a version field to the export spec

**Resolution:** See C5 resolution. Version field now in §1.3.1.

---

### R8 — OPEN — Clarify extension architecture in a new §0 or §8

§2 Permissions now covers the permission model and toolbar injection approach. Content script details, background service worker presence/absence, and cross-component messaging remain unspecified. A builder still has to invent the architecture for tab sync, reload persistence, and SPA URL detection.

---

### R9 — ✅ RESOLVED — Specify the edit UX fully

**Resolution:** See A2 resolution. §3.2 fully specifies the edit flow.

---

### R10 — ✅ RESOLVED — Decide on global vs. per-page pin numbering

**Resolution:** Global continuous numbering confirmed in §1.1 with explicit rules and examples.
