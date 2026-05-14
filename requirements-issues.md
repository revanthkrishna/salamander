# Requirements Issues — Critical Review

> Reviewed against: `REQUIREMENTS.md` (current HEAD as of review)
> Verdict: **Not ready to build.** Multiple critical gaps will force builders to make core architectural decisions that belong in the spec. Several contradictions will produce inconsistent implementations. The UX contains at least one flow that is actively hostile to users.

---

## 🔴 Critical Issues

### C1 — Storage mechanism is completely undefined

**Section:** §1.1 ("Annotations persist across page reloads (within the same session/browser)")

The spec says annotations persist but never says *how*. `chrome.storage.local`? `localStorage`? `IndexedDB`? These choices have wildly different size limits (5MB vs 10MB vs effectively unlimited), scoping rules, security posture, and cross-tab sync behavior. A builder will pick one. Another builder will pick another. They'll be incompatible. This is a foundational architecture decision being left entirely to chance.

**Additionally:** the phrase "within the same session/browser" directly contradicts the product's purpose. If annotations disappear when Chrome is closed, the entire export/import workflow is largely pointless. Does it persist across browser restarts or not? The parenthetical is ambiguous enough to justify either interpretation.

**Impact if unresolved:** Every other persistence-dependent requirement (Journey navigation, cross-tab behavior, import state) is undefined. Builders will guess wrong.

---

### C2 — No YAML schema defined anywhere

**Section:** §1.3 (Export), §5 #4 (Import validation)

§1.3 lists fields that appear in the export ("website domain, per-page URL, element fingerprint, annotation text, pin number") but never shows the actual YAML structure. No nesting. No field names. No types. No required vs. optional. 

§5 #4 says the error for wrong schema is "missing required fields" — but required fields are never enumerated anywhere in the document.

**Impact if unresolved:** Every import/export implementation will invent its own schema. Import validation error #4 is untestable. Round-trip compatibility between two independently-built instances is impossible to guarantee.

---

### C3 — Extension architecture is absent

**Section:** §4 Journey 1 steps 2–4

The spec describes user-facing behavior but never addresses the Chrome extension architecture:

- Is the toolbar injected by a content script? If so, when — on all pages or only on demand?
- Step 3 says "if the extension hasn't been granted permission to run on this page, it prompts for it." Chrome permissions don't work this way by default. Is this `activeTab`? Host permissions? A permission request flow? How does the prompt appear?
- Is there a background service worker? How does it communicate with the content script?
- Does clicking the extension icon open a popup, or does it inject a content script, or does it send a message to an already-injected content script?

**Impact if unresolved:** The permission model alone could require a complete rebuild. An `activeTab`-based approach vs. broad host permissions has totally different UX, security, and store approval implications. Builders will have to invent the architecture and it may not match the user journeys described.

---

### C4 — Cross-page state propagation model is undefined

**Section:** §4 Journey 1 step 10 ("The toolbar reappears")

Journey 1 describes the user navigating from page A to page B within the same domain, with the toolbar "reappearing." This requires either:
1. The content script auto-injects on every page load within the domain, OR
2. The user activates the extension again on each page, OR
3. There is a persistent background worker that re-injects the toolbar

None of these are specified. Journey 2 step 8 implies the toolbar/pins are not auto-active on navigation ("entering annotation mode on each page reveals the imported pins") but it's not clear how the user re-enters annotation mode — is the toolbar always there, or do they need to re-click the extension icon on each page?

**Impact if unresolved:** The navigation model is the most common user action. If it's wrong, every multi-page journey is broken.

---

### C5 — Version field mentioned but never defined

**Section:** §5 #6 ("File version mismatch")

Error case #6 references a version field in the file. The export spec (§1.3) does not include a version field in the list of exported data. There is no versioning scheme, no version number, no format string, nothing.

**Impact if unresolved:** Version mismatch detection is impossible to implement. This error case is dead code.

---

### C6 — "File version mismatch" is future-proofing without a version

Related to C5. Implementing "this file was created with a newer version" detection requires a version field in the export AND a mechanism for the extension to know its own format version. Neither exists. This creates a false sense of security — the spec claims forward compatibility is handled, but nothing in the spec enables it.

---

## 🟡 Ambiguities & Gaps

### A1 — "Active" is never formally defined

**Section:** §3.3 ("A floating toolbar appears... when the extension is active")

The term "active" appears throughout but is never defined. Does "active" mean: the user has clicked the extension icon at least once this session? The user is in annotation mode? The toolbar is visible? This ambiguity will cause different parts of the extension to use different mental models for what "active" means.

---

### A2 — Edit UX is barely specified

**Section:** §1.5, §3.1

"User can edit an individual annotation" appears twice. The only UX detail is §3.1: "Clicking an existing pin in annotation mode shows the annotation text and options to edit or delete." There is no description of the edit flow:

- Does clicking "edit" open the same popover pre-filled with the current text?
- Is the character counter shown during edit?
- Is there a "Save" vs "Add" button label distinction?
- What happens if the user opens the edit popover and clicks cancel — is the annotation unchanged?
- Can the user clear all text and save (effectively an empty annotation)?

---

### A3 — Empty annotation text not addressed

**Section:** §3.1, §1.1

The max is 400 chars, but there's no minimum. Can a user save an annotation with 0 characters? The "Add" button behavior on empty text is unspecified. This will produce a blank pin, which is useless.

---

### A4 — Popover overflow/positioning is unspecified

**Section:** §3.1 ("popover anchored near the click point")

"Near the click point" is not a specification. If the user clicks an element in the bottom-right corner of the viewport, where does the popover go? No overflow rules, no preferred position, no fallback positioning logic. Builders will implement this differently across every device resolution.

---

### A5 — "Closest visible edge" for pin anchoring is undefined

**Section:** §3.2 ("Pins are anchored to the annotated element (top-left corner or closest visible edge)")

These two options are contradictory within the same sentence. Is it always top-left, or is it "closest visible edge"? Under what conditions does it switch? What does "visible edge" mean for partially off-screen elements? No algorithm is provided.

---

### A6 — Global pin numbering on import + additions is ambiguous

**Section:** §1.1, §1.4

§1.1 says "numbering continues from the highest used number." When importing a file with pins 1–20, and the user adds a new annotation, does it become pin 21? The spec implies yes based on the deletion rule, but this is never explicitly stated for the import case. What if the file being imported was already edited by the sharer (so it has gaps: 1, 2, 4, 7)? The highest used number rule should cover this, but it's not stated.

---

### A7 — What is exported when annotations are from an import + local edits?

**Section:** §4 Journey 2 step 10 ("export the full annotation set (original + changes)")

"Original + changes" implies the original file's data is preserved and merged with local edits. But §1.4 says "importing a new file replaces the current state entirely." If it truly replaces state, what exactly is "original" — is it the loaded state, or is there a separate original-file snapshot? This phrasing suggests the extension should track provenance of annotations, which is never specified.

---

### A8 — ✅ RESOLVED — Annotations on unvisited pages during export

**Section:** §1.3, §1.4, §4 Journey 2 step 10

**Resolution:** Yes — export includes ALL stored annotations, including those for unvisited pages. §1.4 updated to explicitly state this. Round-trip fidelity is guaranteed.

---

### A9 — ✅ RESOLVED — No storage quota handling

**Section:** §2 (Non-Functional Requirements)

**Resolution:** Storage quota handling is explicitly out of scope for v1. No special behavior required.

---

### A10 — ✅ RESOLVED — No file size limit on import

**Section:** §1.4, §5 (Import Error Handling)

**Resolution:** Import file size capped at 8MB. Error case #13 added to §5.

---

### A11 — ✅ RESOLVED — Multi-tab same-domain behavior

**Section:** §1.1

**Resolution:** Yes — tab 2 reflects changes made on tab 1. All active tabs on the same domain stay in sync via `chrome.storage.onChanged`. Last-write-wins for concurrent edits (no merge needed in v1). New "Multi-Tab Behavior" section added to §2.

---

### A12 — ✅ RESOLVED — URL normalization incomplete

**Section:** §6 edge case #7, #8

**Resolution:** All four cases now covered in §6 edge cases #14–17:
- Trailing slashes: stripped (same URL)
- Case sensitivity: path is case-sensitive; scheme + hostname lowercased
- www prefix: stripped (treated as same domain); other subdomains are distinct
- Port numbers: ignored in v1

---

### A13 — ✅ RESOLVED — Domain matching for subdomains

**Section:** §5 #5 (Domain mismatch error)

**Resolution:** www prefix is normalized away (www.example.com = example.com). All other subdomains (app.figma.com, aws.amazon.com, etc.) are treated as distinct domains. Covered by edge case #16 in §6.

---

## 🟠 Contradictions

### X1 — ✅ RESOLVED — Silent failure vs. warning for unresolved elements

**Resolution:** Page-level alerts shown **below the filename** in the toolbar. Per-annotation failures are silent; the page-level count surfaces the impact.
- **Some** pins couldn't be placed → 🟡 yellow alert below filename: "X of Y annotations couldn't be placed on this page."
- **All** pins couldn't be placed (when file has annotations for this page) → 🔴 red alert below filename: "None of the annotations could be placed on this page."
- Alert updates automatically on every page navigation.
- §1.2, §3.4, §5 #8/#9, and §6 #13 all updated to reflect this.

---

### X2 — Annotation mode auto-activation on import

**Section:** §4 Journey 2 step 7 vs. step 8

Step 7: "Extension enters annotation mode automatically" after import.
Step 8: "User can browse the site — **entering annotation mode** on each page reveals the imported pins."

Step 7 says annotation mode is auto-entered. Step 8 says the user enters annotation mode (implying it's not automatic). These are in direct conflict. Which is it? Auto-active on import page only, then manual on subsequent pages? Or always manual? The spec says both.

---

### X3 — ✅ RESOLVED — Error classification: Confirmations labeled as Errors

**Resolution:** §5 now explicitly defines two distinct patterns: inline error/warning messages (above toolbar) and confirmation dialogs (blocking modal). #11 and #12 reclassified as 💬 Confirmation dialogs — same modal pattern as Delete All in §1.5. 🔴 classification removed from both.

---

### X4 — ✅ RESOLVED (already fixed) — "Replaces current state entirely" vs. merged export

**Resolution:** Journey 2 step 10 was updated in a prior edit to read: *"this is simply the current state (imported annotations + any additions/edits/deletions made since). There is no separate tracking of 'original' vs 'changed' annotations; it is all one unified state."* No provenance tracking. Import replaces state; export dumps current state. Fully consistent with §1.4.

---

### X5 — ✅ RESOLVED — Pins visible rule vs. Journey 2 import flow

**Resolution:** Auto-enter annotation mode on import is intentional behavior. Added explicitly to §1.4 (Importing) and §3.1 (Annotation Mode) so it's in the normative spec, not just the journey narrative.

---

## 🔵 UX / Logic Problems

### U1 — ✅ RESOLVED (by design) — Auto-entering annotation mode on import suppresses all native clicks

**Resolution:** Intentional by design. Auto-entering annotation mode on import is the intended behavior for v1. User exits annotation mode via the Exit button when they want to navigate.

---

### U2 — ✅ OUT OF SCOPE (v1) — No read-only view mode exists

**Section:** §3.2, §3.3

Pins are only visible in annotation mode, which suppresses all native interaction. There is no "view mode" where annotations are visible but the page behaves normally. This means every time a user wants to see their annotations they must sacrifice the ability to click links, scroll interactively, or use the page. This fundamentally conflicts with the collaborative use case (user B wants to see annotations while using the site).

---

### U3 — ✅ RESOLVED — Silent success on import with no matching current-page pins is confusing

**Resolution:** The alert system in §3.4 disambiguates clearly. Import errors (wrong file, corrupted, etc.) prevent the filename from appearing at all. If the filename shows with no alert, it means import succeeded and this page simply has no annotations in the file. If annotations exist for this page but couldn’t be placed, a red/yellow alert fires. These three states are now distinguishable.

---

### U4 — ✅ RESOLVED (by design) — Global pin numbering has no user-visible purpose

**Resolution:** Global continuous numbering is intentional. Pin numbers serve as a reference system — when discussing annotations, users can say "see pin 12" and it uniquely identifies one annotation across the entire domain. Continuous numbering also gives users a sense of total feedback volume across a site.

---

### U5 — ✅ OUT OF SCOPE (v1) — No undo

**Section:** §1.5

The user can delete an annotation. There is no undo. A single misclick destroys an annotation permanently. The spec does not address this at all.

---

### U6 — ✅ RESOLVED — Domain mismatch error has no override

**Resolution:** www normalization added in A12/A13 resolution — `www.example.com` and `example.com` are now treated as the same domain. The frustrating case described here no longer occurs.

---

### U7 — ✅ RESOLVED (by design) — No indication of how many annotations were loaded

**Resolution:** Keeping it simple by design. No success count shown. Partial/no matches surface via the red/yellow page-level alerts in §3.4. If no alert shows, import was fully successful on this page. Info overload avoided.

---

## ⚪ Missing Edge Cases

### E1 — ✅ RESOLVED — Trailing slash URL normalization
Trailing slash is stripped; treated as same URL. See §6 #14.

### E2 — ✅ RESOLVED — Case-sensitive URLs
Path is case-sensitive; hostname is lowercased. `example.com/Products` ≠ `example.com/products`. See §6 #15.

### E3 — ✅ RESOLVED — What happens when the extension icon is clicked while the toolbar is already visible?
**Resolution:** Toolbar stays open. No toggle, no duplicate injection. Added as §6 edge case #18.

### E4 — ✅ OUT OF SCOPE — Content scripts don't run on chrome:// or extension pages
**Resolution:** Chrome system pages are not annotatable and that’s fine. The extension is for public webpages. No handling needed.

### E5 — ✅ RESOLVED — Annotating a page behind auth
**Resolution:** If the recipient lacks access, they’ll see a login page or redirect — elements won’t be found, triggering the standard red page-level alert ("None of the annotations could be placed on this page."). Existing error handling covers this adequately. Added as §6 edge case #19.

### E6 — ✅ RESOLVED — Fixed-position elements
**Resolution:** Real edge case. Added as §6 edge case #20. Implementation must use `getBoundingClientRect()` (viewport-relative) for fixed-position elements rather than document-relative offsets.

### E7 — ✅ ACCEPTED (v1) — Element removed from DOM after annotation (non-SPA case)
**Resolution:** Accepted v1 limitation. Existing silent-skip + page-level alert handles it adequately.

### E8 — ✅ RESOLVED — Large imports
**Resolution:** 8MB file size cap added as error case #13 in §5.

### E9 — ✅ RESOLVED — YAML file character encoding
**Resolution:** UTF-8 encoding required for both export and import. Added as §6 edge case #21.

### E10 — ✅ RESOLVED — Duplicate pin numbers in imported file
**Resolution:** Treated as a corrupted file. Added as error case #14 in §5 — red error above toolbar, file rejected.

### E11 — ✅ RESOLVED — Annotating a page, then the page URL changes (SPA client-side routing)
**Resolution:** Covered by the SPA navigation behavior in §2 (Toolbar Activation & Persistence): "SPA navigation (same tab, no reload): toolbar remains visible, annotation mode is off, pins update to reflect the new page’s annotations." The extension must listen for URL changes and update displayed pins accordingly.

### E12 — ✅ RESOLVED (by design) — Undo / accidental deletion
**Resolution:** Deletion requires a confirmation dialog (§3.2). Accepted permanent deletion by design; no undo for v1.

### E13 — ✅ OUT OF SCOPE (v1) — Extension update while annotations are stored
**Resolution:** Extremely rare edge case. Ignored for v1.

---

## 💡 Recommendations (all addressed)

> All recommendations below have been addressed through requirements updates made during review.

### R1 — Define the YAML schema explicitly with a code block
Add a normative YAML example to §1.3. Include every field name, type, nesting structure, and whether it's required or optional. This unblocks import validation (#4), version detection (C5), and all export tests.

```yaml
# Example — add this to §1.3
version: "1"
domain: "figma.com"
annotations:
  - pin: 1
    url: "https://figma.com/design/abc123"
    selector: "#canvas > div.toolbar"
    xpath: "/html/body/div[3]/div[1]"
    text_snippet: "Design toolbar"
    tag: "div"
    note: "This is the annotation text"
```

### R2 — Define the storage strategy in §2 Non-Functional Requirements
Add: "Annotations are stored in `chrome.storage.local`. Persist across browser restarts. Subject to Chrome's 10MB storage limit per extension." Address multi-tab behavior explicitly.

### R3 — Replace auto-annotation-mode-on-import with a view mode
After import, do NOT auto-enter annotation mode. Instead, display pins in a new **view mode** where pins are visible but native page interactions are not suppressed. Make annotation mode opt-in from view mode. This fixes U1 and U2 simultaneously.

### R4 — Add a summary message on successful import
After import, show (in the neutral message style): "Loaded N annotations across M pages. X found on this page." This resolves U3 and U7 and makes the import feel complete.

### R5 — Resolve the silent-vs-warned contradiction (X1) with a clear rule
Pick one: either all unresolved annotations produce a warning (§5 #8/#9), or they're all silent (§1.2/#6 #13). Recommended: warn at the file level (how many annotations couldn't be placed), not at the individual annotation level.

### R6 — Define URL normalization completely
Add a URL normalization algorithm to §1.2 or a new §1.6. At minimum: lowercase hostname, strip www prefix, normalize HTTP to HTTPS, strip query params and fragments, strip trailing slash. Explicit rules prevent mismatched annotation lookups.

### R7 — Add a version field to the export spec
Add `version: "1"` as a required top-level field in the YAML schema. Define the extension's current format version. This makes §5 #6 implementable.

### R8 — Clarify extension architecture in a new §0 or §8
Add a brief technical architecture section: popup vs. content script, background service worker presence/absence, permission model (activeTab vs. host permissions), how the toolbar is injected and when, how cross-page state is communicated. This prevents builders from having to invent the architecture independently.

### R9 — Specify the edit UX fully
Add to §3.1: "Clicking 'Edit' opens the comment popover pre-filled with the current annotation text. The button label changes from 'Add' to 'Save'. Clicking 'Save' updates the annotation. The character counter reflects current length. Saving an empty annotation is not permitted (Save button disabled when text is empty)."

### R10 — Decide on global vs. per-page pin numbering
If global numbering serves no user-visible feature, switch to per-page numbering to reduce implementation complexity. If global is intentional (e.g., for future cross-page navigation feature), say so explicitly and add a note to §7 Out of Scope.
