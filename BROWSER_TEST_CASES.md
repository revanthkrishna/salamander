# Browser Test Cases

Manual test checklist for exercising the extension in real Chrome. Pure "click this, expect
that" — for unit tests, build commands, and debugging internals, see `TESTING.md`.

**Setup (once):**
```bash
npm run build
```
Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the project
root. After every rebuild, click the reload (↻) icon on the extension card, then refresh any open
test tabs (orphaned content scripts otherwise).

Use a mix of sites as you go — a plain static site (e.g. wikipedia.org), a heavy SPA (e.g.
reddit.com or twitter.com), and one with an iframe embed — rather than repeating every case on
the same page.

---

## 0. Regression checks (bugs found in the last manual pass — verify these first)

- [ ] **R1.** Click **add**. The comment box must **not** appear yet — only the crosshair cursor.
      It should only appear after you click on the page to place a selection box.
- [ ] **R2.** Place a box, then click directly into the comment box's textarea with the mouse
      (not Tab) — it should focus and accept typing normally. Click **cancel** and **ok** with the
      mouse too — both must respond to a real click.
- [ ] **R3.** Capture an item, click its thumbnail to open the modal. No underlying page content
      (headers, sticky nav, cookie banners, etc.) should visually appear on top of the modal or
      its backdrop.
- [ ] **R4.** With the modal open, confirm it does not visually overlap or collide with the
      sidebar's own strip on the right edge of the screen.

---

## 1. Sidebar activation & lifecycle (§1.1, §3.1)

- [ ] **1.1.** Click the extension icon on a normal page → sidebar opens on the right edge.
- [ ] **1.2.** The page itself visibly narrows/reflows to make room — the sidebar does **not**
      float on top of or cover page content.
- [ ] **1.3.** Sidebar header shows exactly 4 icon buttons, no text labels: add, export, import,
      close.
- [ ] **1.4.** With no feedback captured yet on this page, sidebar body shows the empty-state
      message: "no feedback on this page yet".
- [ ] **1.5.** Click **close** → sidebar disappears, page returns to full width.
- [ ] **1.6.** Click the extension icon again → sidebar re-opens, page narrows again.
- [ ] **1.7. (SPA persistence)** On a site with client-side routing, open the sidebar, then click
      an in-app link (not a full reload). Sidebar must stay open and its thumbnail list must
      refresh for the new URL.
- [ ] **1.8. (Reload persistence)** With the sidebar open, press a full reload (Cmd/Ctrl+Shift+R).
      Sidebar must reopen automatically with no click needed, showing the same items as before.
- [ ] **1.9.** Close the sidebar, then reload the page. Sidebar must **not** auto-open this time
      (closed state persists across reload too).
- [ ] **1.10.** Restart Chrome entirely (quit and reopen), revisit a page you'd left the sidebar
      open on. Sidebar should be closed by default (session state cleared on browser restart).

## 2. Add mode & capture (§1.2, §1.3, §3.2)

- [ ] **2.1.** Click **add** → cursor becomes a crosshair, page clicks stop navigating/activating
      anything underneath.
- [ ] **2.2.** Click once on the page → a box appears at that point, roughly 200×150px, with a
      dimming scrim over everything outside the box (rest of the page visibly darkened, box itself
      stays fully clear — like the macOS screenshot tool).
- [ ] **2.3.** Box outline is yellow (`#FEC800`), with visible resize handles on all 4 corners and
      4 edges.
- [ ] **2.4.** Drag a corner handle to resize the box larger and smaller. Try shrinking it down —
      it should refuse to go below ~20×20px.
- [ ] **2.5.** Drag the box (or a handle) toward a viewport edge — it should stop exactly at the
      edge, never extend past it or trigger the page to scroll.
- [ ] **2.6.** Comment box appears attached to the selection box (below it by default). Type in
      the textarea — no counter should be visible yet under 900 characters.
- [ ] **2.7.** Keep typing past 900 characters — a counter (e.g. "912 / 1000") should appear.
      Continue past 980 — the counter should turn red. Confirm you're hard-capped at 1000 chars.
- [ ] **2.8.** With the textarea empty, confirm **ok** is disabled (greyed out / unclickable).
- [ ] **2.9.** Click somewhere outside the box/comment area (on the dimmed page) — nothing should
      happen at all: no dismiss, no shake/wiggle, no page interaction underneath.
- [ ] **2.10.** Click **cancel** — box, scrim, and comment box all disappear, add mode exits, no
      thumbnail is created.
- [ ] **2.11.** Repeat 2.1–2.7, then click **ok** with valid text — overlay UI should disappear
      briefly, then a new thumbnail appears at the bottom of the sidebar list showing the
      screenshot and a truncated preview of your note.
- [ ] **2.12.** Capture 3+ items across 2 different pages of the same site (domain). Confirm the
      item numbers keep incrementing across pages (e.g. page A gets #1–2, page B continues at #3),
      not restarting per page.
- [ ] **2.13. (Restricted pages)** Try clicking the extension icon on `chrome://extensions`, a
      blank new tab, or an open PDF. The sidebar should not appear, and nothing should break on the
      page itself.
- [ ] **2.14. (Capture failure)** Trigger 4–5 captures back-to-back as fast as you can. At least
      one should show an error like "couldn't capture a screenshot here. try again." rather than
      silently failing or creating a broken item — confirm no partial/blank thumbnail appears.

## 3. Viewing & managing feedback (§1.5, §3.3)

- [ ] **3.1.** Click a thumbnail → modal opens with a translucent backdrop over the page, showing
      the full-size screenshot and the full note in an editable textarea.
- [ ] **3.2.** Edit the note text, then click outside the textarea (blur) — reopen the modal to
      confirm the edit was saved automatically (no explicit save button, no lost edits).
- [ ] **3.3.** Edit the note again, then close the modal (not by blurring the textarea first) —
      reopen to confirm that edit also autosaved.
- [ ] **3.4.** Click **delete** on an item — it disappears immediately, no confirmation dialog.
      Reload the page/sidebar to confirm it's actually gone, not just hidden.
- [ ] **3.5.** After capturing several items, confirm the newest one appears at the **bottom** of
      the sidebar list (chronological order, not reverse).
- [ ] **3.6.** Capture items on page A, navigate to page B (different URL, same domain) — sidebar
      should show **only** page B's items, not page A's. Navigate back to page A — its items should
      reappear, unchanged.

## 4. Exporting (§1.6)

- [ ] **4.1.** With zero feedback captured anywhere on the domain, click **export** — should show
      `alert("nothing to export")`, no file downloads.
- [ ] **4.2.** Capture 2+ items on 2+ different pages of one domain, then click **export** — a
      `.zip` downloads named like `feedback-{domain}-{YYYY-MM-DD}.zip` (dots in the domain replaced
      with underscores, e.g. `feedback-example_com-2026-09-18.zip`).
- [ ] **4.3.** Unzip it. Confirm a `screenshots/` folder with one `.png` per item, and a single
      `feedback.md` at the top level (no other files).
- [ ] **4.4.** Open `feedback.md` in a markdown viewer (VS Code preview, GitHub, Obsidian, etc.).
      Confirm: one `##` heading per URL, items listed in the order you captured them, each item
      shows its number, the screenshot rendered inline, the note text as plain prose, and a fenced
      ` ```yaml ` block underneath with structured context (selector, xpath, contained elements,
      area text, page metadata).
- [ ] **4.5.** Spot-check the yaml block's `page_meta`: `viewport` should roughly match your
      browser window size, `dpr` should match your screen (1.0 normal, 2.0 on Retina/high-DPI).

## 5. Importing (§1.7) and all error cases (§5)

- [ ] **5.1. (Happy path)** On the same site the bundle was exported from, click **import**,
      select the `.zip` from §4. Sidebar should populate with thumbnails matching what was
      exported (same images, same notes) once you're on a URL that has items.
- [ ] **5.2. (Round trip)** Export again right after importing — the new export should be
      equivalent to the original (same item count, same notes, same context data).
- [ ] **5.3. (Existing-data confirmation)** With feedback already present for this domain, import
      a bundle — a confirm dialog should appear: "importing will replace your current N feedback
      item(s) for this site. this cannot be undone. continue?" Cancel it — nothing should change.
      Confirm it — old items are wiped and the new bundle's items take their place.
- [ ] **5.4. (Wrong file type)** Try importing a `.txt` or `.png` file → "invalid file type. please
      upload a .zip feedback bundle."
- [ ] **5.5. (Corrupted zip)** Rename some random non-zip file to `.zip` and try importing it →
      "could not read this file — it appears to be corrupted."
- [ ] **5.6. (Missing feedback.md)** Take a valid export zip, delete `feedback.md` from it, re-zip,
      import → "this doesn't look like a feedback bundle."
- [ ] **5.7. (Missing screenshot)** Take a valid export zip, delete one file from `screenshots/`,
      re-zip, import → "this file is missing screenshot data and can't be imported."
- [ ] **5.8. (Malformed metadata fence)** Edit `feedback.md` to break one item's yaml fence (e.g.
      delete a closing ` ``` `), re-zip, import → "this bundle appears to be corrupted (couldn't
      read feedback data)."
- [ ] **5.9. (Domain mismatch)** Export from one site, try importing that bundle while on a
      different site → "this bundle contains feedback for '{other-domain}', but you're currently
      on '{current-domain}'."
- [ ] **5.10. (Duplicate IDs)** Edit `feedback.md` so two items share the same id, re-zip, import →
      "this bundle appears to be corrupted (duplicate item ids)."
- [ ] **5.11. (Newer version)** If feasible, edit the bundle's version marker to something ahead of
      the installed extension's version → import should show a warning ("this bundle was created
      with a newer version...") but still proceed, not block.

## 6. Edge cases (§6)

- [ ] **6.1. (iframe)** Select an area containing an embedded iframe (video embed, ad, etc.).
      Screenshot should visually include the iframe's content correctly. Check the exported yaml —
      context for that region should be limited to the iframe tag's own attributes, not its
      internal DOM.
- [ ] **6.2. (Large selection)** Select a big region with 15+ distinct child elements. In the
      exported yaml, `contained_elements` should cap at 15 with a truncation marker present —
      elements with text/attributes should be prioritized over bare `div`s.
- [ ] **6.3. (High-DPI / zoom)** On a Retina display or at 150% browser zoom, capture a region with
      recognizable text/UI. Open the modal and visually compare — no offset or misalignment between
      what you selected and what was captured.
- [ ] **6.4. (Scrolled page)** Scroll halfway down a long page, then capture something below the
      fold. Confirm the screenshot shows the correct content (not something from the top of the
      page).
- [ ] **6.5. (Form inputs)** Select an area containing a password or email input. Capture should
      proceed normally with **no masking** — the raw field is visible in the screenshot (this is a
      known, accepted v1 limitation, not a bug).
- [ ] **6.6. (URL normalization)** Visit `example.com/page`, `example.com/page/` (trailing slash),
      and `www.example.com/page` — feedback captured on one should appear as the same page's
      feedback on the others. Visit `example.com/Page` (different case) — should be treated as a
      **different** page.
- [ ] **6.7. (Fixed/sticky elements)** Try selecting an area on a sticky header or fixed-position
      element while scrolled down the page. Should behave like any other selection — no odd
      jumping or misplacement.

## 7. Text case convention (§3.4)

- [ ] **7.1.** Scan every piece of visible text you've encountered so far — button labels,
      placeholder text ("type something..."), error messages, confirm dialogs, the empty-state
      message. All of it should be **lowercase**, no exceptions, no title case.

## 8. End-to-end journey smoke tests (§4)

- [ ] **8.1. (Journey 1)** From a cold start (extension freshly loaded, no prior data): open
      sidebar → add → place box → resize → note → ok → thumbnail appears → repeat on a second page
      → export. Confirm the whole flow works without any console errors (check the page's DevTools
      console and the extension's service-worker console — right-click the extension icon →
      "Manage extension" → "Inspect views: service worker").
- [ ] **8.2. (Journey 2)** As a "second person": on a fresh Chrome profile (or after clearing this
      extension's storage via `chrome://extensions` → Details → Clear data, if available, or just
      a different machine/profile), import the bundle from 8.1 and confirm you can browse to each
      URL in it and see the right thumbnails, with no prior setup beyond installing the extension.

---

## Reporting a bug

For anything that fails, note: the test case number, the site/URL, and what you saw vs. expected.
If it's a visual bug, a screenshot of the actual browser (not the extension's own capture) helps.
