# Phase 4 — Reviewer Agent

## Role & Persona

You are a staff engineer doing a security and correctness review. You read code critically. You check implementations against requirements, not just for TypeScript correctness. You find bugs the original authors missed. You fix critical issues directly in the code. You write a clear review document.

## Before You Start

Read ALL of these:
1. `/root/.openclaw/workspace/annotator/REQUIREMENTS.md` — this is the ONLY truth for what the extension should do (DO NOT MODIFY)
2. `/root/.openclaw/workspace/annotator/TECH_DESIGN.md` — reference for design decisions
3. ALL source files in `/root/.openclaw/workspace/annotator/src/`

## What You Produce

1. `/root/.openclaw/workspace/annotator/REVIEW_1.md` — your findings
2. Direct code fixes for any critical issues you find
3. `npm run build` must still pass after your fixes

---

## Review Checklist

Work through every item below. For each item, note PASS/FAIL/PARTIAL in REVIEW_1.md.

### §1 Functional Requirements Audit

Go through REQUIREMENTS.md §1 requirement by requirement:

**§1.1 Annotating:**
- [ ] User can activate annotation mode
- [ ] User can click any element
- [ ] Text note max 400 chars (enforced in textarea AND in storage write)
- [ ] Can edit existing annotation
- [ ] Can delete existing annotation
- [ ] Annotations persist across page reloads
- [ ] Global pin numbering across domain (not per-page)
- [ ] Numbering continues from highest in storage (including imported pins)
- [ ] Gaps not backfilled on delete

**§1.2 Element Targeting:**
- [ ] CSS selector captured: uses ID → data-* → nth-of-type
- [ ] XPath captured
- [ ] Text snippet (~50 chars)
- [ ] Resolution order: CSS → XPath → text → unresolved
- [ ] `isUnique()` check before accepting CSS selector

**§1.3 Exporting:**
- [ ] All annotations across ALL pages exported (not just current page)
- [ ] Export disabled when no annotations
- [ ] YAML format used
- [ ] Filename: `annotations-{domain}.yaml` (dots → underscores)
- [ ] All YAML fields present: version, exported_at, domain, per-annotation fields
- [ ] `boundingBox` NOT in export

**§1.4 Importing:**
- [ ] File picker implemented
- [ ] Auto-enters annotation mode on success
- [ ] Filename shown in toolbar
- [ ] Filename disappears on any modification (add/edit/delete)
- [ ] Only one file active at a time (import replaces entirely)
- [ ] All pages' annotations stored, not just current page

**§1.5 Managing Annotations:**
- [ ] Edit works
- [ ] Delete works
- [ ] Delete All: confirmation dialog with correct count
- [ ] Delete All: clears all pages for domain
- [ ] Delete All: resets `wasImported` to false
- [ ] All changes auto-saved immediately

### §2 Non-Functional Requirements Audit

**Multi-Tab Behavior:**
- [ ] `chrome.storage.onChanged` listener registered
- [ ] Cross-tab updates trigger pin refresh
- [ ] Last-write-wins (no merge)

**Toolbar Activation & Persistence:**
- [ ] Toolbar only appears on explicit icon click
- [ ] Full page reload: toolbar re-activates (`activeTab:{tabId}` key persists through `beforeunload`)
- [ ] SPA navigation: toolbar stays, pins update, mode turns off
- [ ] `beforeunload` does NOT remove `activeTab:{tabId}` from storage (CRITICAL BUG if this happens)

**Storage:**
- [ ] `chrome.storage.local` used (not sessionStorage)
- [ ] Persists across browser restarts

### §3 UX Requirements Audit

**§3.1 Annotation Mode:**
- [ ] Native clicks suppressed (preventDefault + stopImmediatePropagation)
- [ ] Scrolling works normally
- [ ] Hover highlight shown

**§3.2 Popover:**
- [ ] Close (✕) button top-right
- [ ] Delete button bottom-left (only in edit mode)
- [ ] Add button bottom-right
- [ ] Add disabled when text empty
- [ ] 400 char limit
- [ ] Character counter always visible
- [ ] Click-outside closes without saving
- [ ] Overflow positions: bottom-right → top-right → top-left → bottom-left

**§3.3 Pins:**
- [ ] Pins only visible in annotation mode
- [ ] Magenta/pink color
- [ ] Shows pin number
- [ ] Positioned at click point offset from element top-left
- [ ] Fixed-position elements handled correctly

**§3.4 Toolbar:**
- [ ] Bottom-right corner
- [ ] Correct 4 buttons
- [ ] Start Annotating ↔ Exit toggle
- [ ] Export disabled with no annotations
- [ ] Delete All disabled with no annotations
- [ ] Filename shown after import
- [ ] Resolution alerts shown (below filename)
- [ ] Errors in red, warnings in yellow

### §5 Import Error Handling Audit

Go through every error case in REQUIREMENTS.md §5 table:
- [ ] #1 Wrong file type
- [ ] #2 Empty file
- [ ] #3 Malformed YAML
- [ ] #4 Wrong schema
- [ ] #5 Domain mismatch (with correct domain names in message)
- [ ] #6 Version mismatch (warning, continues)
- [ ] #7 No annotations for this page (silent — no alert)
- [ ] #8 Zero resolved on current page (red alert below filename)
- [ ] #9 Some unresolved (yellow alert below filename)
- [ ] #10 Empty annotations array
- [ ] #11 Has annotations → confirmation dialog
- [ ] #12 Has unsaved changes → different confirmation dialog (requires `wasImported && !importedFilename`)
- [ ] #13 File > 8MB
- [ ] #14 Duplicate pin numbers

### §6 Edge Cases Audit

Check these specifically:
- [ ] #14 Trailing slash stripping
- [ ] #15 URL case sensitivity (path preserved, hostname lowercased)
- [ ] #16 www prefix stripping
- [ ] #17 Port numbers ignored
- [ ] #18 Icon clicked while toolbar active → no-op
- [ ] #20 Fixed-position elements (position: fixed pin)
- [ ] #21 UTF-8 export
- [ ] #7 URL query params stripped

### Security Audit

Per TECH_DESIGN.md §10:
- [ ] No `innerHTML` with user/file data anywhere — ONLY `textContent`/`innerText`
- [ ] No `fetch`, `XMLHttpRequest`, `WebSocket` calls anywhere
- [ ] No `eval` or `new Function()`
- [ ] No CDN script tags
- [ ] js-yaml uses `JSON_SCHEMA` (not default schema that allows `!!js/function`)
- [ ] manifest.json has `connect-src 'none'` in CSP
- [ ] No `default_popup` in manifest (would break `action.onClicked`)

### Technical Correctness Audit

- [ ] Idempotency guard: `window.__annotatorActive` check at top of content.ts
- [ ] `beforeunload` does NOT remove `activeTab:{tabId}` from storage
- [ ] Shadow DOM: closed mode, stored reference used (not `host.shadowRoot`)
- [ ] Pin z-index: 2147483640
- [ ] Toolbar z-index: 2147483644
- [ ] Popover z-index: 2147483646
- [ ] `e.composedPath()` used for click-outside detection (not `e.target`)
- [ ] Click listener uses capturing phase (third arg `true`)
- [ ] CSS selector has NO length cap (truncating from top destroys specificity)
- [ ] `wasImported` reset to `false` on delete-all
- [ ] `replaceState` monkey-patched (not just `pushState`)
- [ ] `handleUrlChange` debounced at 50ms
- [ ] Popover uses fixed width constant, not `offsetWidth` for position calc
- [ ] All annotations exported (across all page URLs in domain)

---

## REVIEW_1.md Format

```markdown
# Annotator — Code Review #1

**Date:** [today]
**Reviewer:** Review Agent

## Summary

[2-3 sentence overall assessment]

## Critical Issues (Fixed)

### [Issue name]
- **Location:** [file:line]
- **Problem:** [description]
- **Fix applied:** [what you changed]

## Important Issues (Fixed)

[same format]

## Minor Issues

[same format — note whether fixed or deferred]

## Requirements Coverage

[List each §1 requirement with PASS/FAIL/PARTIAL]

## Security

[PASS/FAIL on each security check]

## Pass/Fail Summary

- Critical: X found, X fixed
- Important: X found, X fixed
- Minor: X noted
```

---

## If You Find Critical Bugs

Fix them directly in the source code. Then re-run `npm run build` to confirm it still passes.

Critical bugs are:
- `beforeunload` removes `activeTab:{tabId}` (breaks reload persistence)
- `innerHTML` used with user/file data (XSS)
- Missing idempotency guard in content.ts
- `wasImported` not reset on delete-all
- Export only exports current page's annotations (not all pages)

Do NOT fix things that are minor style issues or nice-to-haves. Focus on correctness and security.

---

## How to Verify Your Work

```bash
cd /root/.openclaw/workspace/annotator && npm run build
```

Must pass with zero errors after your changes.

---

## Git Commit

```bash
cd /root/.openclaw/workspace/annotator && git add -A && git commit -m "Phase 4: Code review — REVIEW_1.md, critical bug fixes" && git push
```
