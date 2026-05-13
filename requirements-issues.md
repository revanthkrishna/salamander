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

### A8 — Annotations on unvisited pages during export

**Section:** §1.3, §1.4, §4 Journey 2 step 10

After import, annotations for other pages "are stored" (§1.4). On export, do these stored-but-unvisited pages' annotations get included? The spec doesn't say. If yes: great, round-trip fidelity preserved. If no: importing then re-exporting silently discards all annotations on pages the user didn't visit. This is a data loss scenario.

---

### A9 — No storage quota handling

**Section:** §2 (Non-Functional Requirements)

`chrome.storage.local` has a 10MB limit by default. The spec mentions no limits on number of annotations, number of pages, or total storage use. No quota-exceeded error handling is defined. Heavy users will silently fail to save annotations.

---

### A10 — No file size limit on import

**Section:** §1.4, §5 (Import Error Handling)

What if someone uploads a 50MB file? Or a 1GB file? No size limit is defined for the import file picker. The browser will attempt to read it. No error case covers this.

---

### A11 — Multi-tab same-domain behavior

**Section:** §1.1

User has 3 tabs open on `example.com`. They annotate on tab 1. They go to tab 2. Do tab 2's pins reflect what was added on tab 1? When does the storage write happen? Are reads live? If `chrome.storage.local` is used, changes fire a `storage.onChanged` event — but no listener logic is described. Race conditions between tabs are not addressed.

---

### A12 — URL normalization incomplete

**Section:** §6 edge case #7, #8

The spec handles query params (strip them), fragments (strip them), and HTTP vs HTTPS (normalize to HTTPS). It does not address:
- **Trailing slashes:** `example.com/page` vs `example.com/page/` — same or different?
- **Case sensitivity:** `example.com/Page` vs `example.com/page`
- **www prefix:** `www.example.com` vs `example.com`
- **Port numbers:** `example.com:8080` vs `example.com`

These are extremely common in real URLs and will cause annotation matching failures on import.

---

### A13 — Domain matching for subdomains

**Section:** §5 #5 (Domain mismatch error)

The spec says import is blocked if the file domain doesn't match the current domain. But `app.figma.com` and `www.figma.com` are different domains under this rule. Users annotating across subdomains of the same product will have their files silently rejected. No subdomain policy is defined.

---

## 🟠 Contradictions

### X1 — Silent failure vs. warning for unresolved elements

**Section:** §1.2 vs. §5 #8, #9 vs. §6 #13

§1.2: "If none match: annotation is silently unresolved (no pin placed)"
§5 #8: "zero elements could be resolved on the current page → 🟡 Warning"
§5 #9: "some elements found, some not → 🟡 Warning"
§6 #13: "If resolution fails on import, annotation silently skipped. No special warning per annotation."

This is a three-way contradiction. Is unresolved resolution silent or warned? §1.2 and §6 #13 say silent. §5 #8 and #9 say warned. Builders will implement one or the other. In testing it will appear "wrong" no matter what they choose.

---

### X2 — Annotation mode auto-activation on import

**Section:** §4 Journey 2 step 7 vs. step 8

Step 7: "Extension enters annotation mode automatically" after import.
Step 8: "User can browse the site — **entering annotation mode** on each page reveals the imported pins."

Step 7 says annotation mode is auto-entered. Step 8 says the user enters annotation mode (implying it's not automatic). These are in direct conflict. Which is it? Auto-active on import page only, then manual on subsequent pages? Or always manual? The spec says both.

---

### X3 — Error classification: Confirmations labeled as Errors

**Section:** §5 #11, #12

Both #11 and #12 are classified as "🔴 Confirm" — but the error display model (§5 intro, §3.3) says errors appear in red above the toolbar. A confirmation dialog is not an error — it's a modal interrupt. The spec mixes two completely different UI patterns (inline error message vs. blocking confirmation dialog) under the same 🔴 classification, and provides no design guidance on how confirmations are rendered.

---

### X4 — "Replaces current state entirely" vs. merged export

**Section:** §1.4 vs. §4 Journey 2 step 10

§1.4: "importing a new file replaces the current state entirely"
Journey 2 step 10: "export the full annotation set (original + changes)"

If import replaces state, then after import the state IS the file's annotations. Any additions/edits modify that state. On export you'd export the current state — there is no separate "original." The use of "original + changes" implies a tracked distinction that §1.4 explicitly eliminates. These statements are inconsistent.

---

### X5 — Pins visible rule vs. Journey 2 import flow

**Section:** §3.2 vs. §4 Journey 2 step 7

§3.2: "Pins are **only visible in annotation mode** — when annotation mode is off, pins are hidden"
Journey 2 step 7: after import, "Extension enters annotation mode automatically" and "Magenta pins appear"

This is technically not a contradiction IF the extension auto-enters annotation mode. But the auto-enter behavior is only stated in the journey, not in §1.4 (Import requirements) or §3.1 (Annotation Mode). The import section says nothing about entering annotation mode. The annotation mode section says nothing about import triggering it. It's specified in exactly one place (a journey narrative) and missing from the normative requirements sections.

---

## 🔵 UX / Logic Problems

### U1 — Auto-entering annotation mode on import suppresses all native clicks

**Section:** §4 Journey 2 step 7

When a user imports a file, annotation mode is automatically activated. §2 and §3.1 state that in annotation mode, "all native element click behaviors are suppressed." This means: after importing a file, the user cannot click any links, buttons, or interactive elements on the page. If they want to navigate anywhere, they must first find the Exit button and click it. This is hostile UX. Users import to *view* annotations while browsing, not to be locked into annotation mode immediately.

---

### U2 — No read-only view mode exists

**Section:** §3.2, §3.3

Pins are only visible in annotation mode, which suppresses all native interaction. There is no "view mode" where annotations are visible but the page behaves normally. This means every time a user wants to see their annotations they must sacrifice the ability to click links, scroll interactively, or use the page. This fundamentally conflicts with the collaborative use case (user B wants to see annotations while using the site).

---

### U3 — Silent success on import with no matching current-page pins is confusing

**Section:** §5 #7

If the imported file has zero annotations for the current page, the spec says: "Import succeeds. Toolbar shows filename. No pins appear on this page." The user sees: toolbar shows a filename, no pins. They will assume the import failed. There is no message like "Loaded 47 annotations for 12 pages — none on this page." The silent success is indistinguishable from a broken import to a user unfamiliar with the tool.

---

### U4 — Global pin numbering has no user-visible purpose

**Section:** §1.1

Pins are globally and continuously numbered across all pages of a domain. There is no described feature that uses this global numbering — no cross-page navigation, no "go to pin N" feature, no summary list. The global numbering adds implementation complexity (shared counter across pages, gap-tracking across deletions, import coordination) for zero described user benefit. If global numbering is just for reference, why is it continuous across pages rather than per-page?

---

### U5 — No undo

**Section:** §1.5

The user can delete an annotation. There is no undo. A single misclick destroys an annotation permanently. The spec does not address this at all.

---

### U6 — Domain mismatch error has no override

**Section:** §5 #5

The spec says domain mismatch is a hard error: "Import is not allowed." No proceed option. This means a user who annotated `www.example.com` and is now on `example.com` (same site, different normalization) is permanently blocked. Combined with the missing www/subdomain normalization (A12, A13), this will frustrate real users.

---

### U7 — No indication of how many annotations were loaded

**Section:** §1.4, §5

After a successful import, the toolbar shows the filename. There is no count of how many annotations were loaded, how many pages they span, how many resolved on the current page. Users have no feedback on whether their import was complete or partial.

---

## ⚪ Missing Edge Cases

### E1 — Trailing slash URL normalization
`example.com/page` vs `example.com/page/` — treated as same URL or different? Annotations placed on one won't appear on the other if treated as different. Not addressed.

### E2 — Case-sensitive URLs
`example.com/Products` vs `example.com/products` — different pages or same? Server-side behavior varies. Not addressed.

### E3 — What happens when the extension icon is clicked while the toolbar is already visible?
Does clicking the extension icon again toggle the toolbar off? Show a popup? Send a message? No toggle or duplicate-injection behavior defined.

### E4 — Content scripts don't run on chrome:// or extension pages
`chrome://newtab`, `chrome://settings`, other extension pages — the spec says "works on any public webpage" but doesn't address that content scripts are blocked on `chrome://` URLs by the browser. Users who try to annotate these pages will get no toolbar and no error.

### E5 — Annotating a page behind auth
The sharer annotates a page that requires login. The recipient doesn't have access. The annotations are useless but the spec says nothing about this. The domain might match, elements might resolve, but the content is inaccessible.

### E6 — Fixed-position elements
If a user annotates a sticky header or fixed nav bar (`position: fixed`), the pin anchoring logic must differ from a normal scrollable element. A pin anchored to a fixed element at its DOM-position top-left will scroll away from the element as the user scrolls. Not addressed.

### E7 — Element removed from DOM after annotation (non-SPA case)
§6 #9 addresses modals/dropdowns for SPA. But even on static pages, elements can be added/removed by ad scripts, cookie banners, lazy-loaders. The only handling described is silent skip — but the user who annotated the element on this page will see their annotation silently disappear on reload.

### E8 — Large imports
No file size limit. No annotation count limit. Importing a file with 10,000 annotations across 500 pages — what happens to performance? What if YAML parsing takes 5 seconds? No handling defined.

### E9 — YAML file character encoding
Annotation text may contain emoji, CJK characters, RTL text, or other non-ASCII content. The spec doesn't state file encoding (assume UTF-8, but it should be explicit).

### E10 — Duplicate pin numbers in imported file
What if the imported YAML file (manually edited or corrupted) has two annotations with the same pin number? No handling defined. The auto-increment logic post-import is undefined in this case.

### E11 — Annotating a page, then the page URL changes (SPA client-side routing)
On SPAs (React Router, Next.js, etc.), the URL changes via `history.pushState` without a full page load. The content script won't reload. Annotations are stored against the URL at time of annotation. If the URL changes while the content script is alive, the annotations displayed may be for the wrong URL.

### E12 — Undo / accidental deletion
No undo mechanism for deleted annotations. Confirmed permanent data loss with no recovery path.

### E13 — Extension update while annotations are stored
If the extension is updated and the storage schema changes, existing stored annotations may be invalid. No migration strategy defined (partly covered by version field, but version field doesn't exist per C5).

---

## 💡 Recommendations

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
