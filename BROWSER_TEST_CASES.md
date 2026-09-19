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

## 0. Regression checks (bugs found in manual passes — verify these first)

- [ ] **R1.** Click **add**. The comment box must **not** appear yet — only the crosshair cursor.
      It should only appear after you click on the page to place a selection box.
- [ ] **R2.** Place a box, then click directly into the comment box's textarea with the mouse
      (not Tab) — it should focus and accept typing normally. Click **cancel** and **save** with
      the mouse too — both must respond to a real click.
- [ ] **R8. (dock magnification vs. capture)** Hover the note list to get an item magnified and
      growing out over the page, then immediately click **add** and capture a new item overlapping
      where the magnified item was bleeding. The resulting screenshot must show only page content —
      no trace of the sidebar's note/thumbnail should ever appear in it.
- [ ] **R3.** Capture an item, click its thumbnail to open the enlarged view. No underlying page
      content (headers, sticky nav, cookie banners, etc.) should visually appear on top of the
      expanded panel or its scrim.
- [ ] **R4.** With the enlarged view open, click **add note** — the view must collapse back to the
      list *before* add mode starts, and nothing from the enlarged view may appear in the capture.
- [ ] **R5. (keyboard isolation — Gmail)** On mail.google.com, open add mode, place a box, and
      type a full sentence with mixed letters into the comment box. Every character you type must
      appear — none dropped — and no Gmail keyboard shortcut (e.g. "c" for compose) should fire.
      Repeat while editing a note in the enlarged view.
- [ ] **R6. (keyboard isolation — Instagram)** On instagram.com, same test as R5. Specifically
      type the letter "n" into the comment box — it must appear as text, and Instagram's
      notifications panel must **not** open.
- [ ] **R7. (YouTube sidebar)** On youtube.com, open the sidebar. Compare against a plain site —
      YouTube's known layout quirks (see `REQUIREMENTS.md` §6 #13) may prevent the page from fully
      reflowing; check that regardless, the sidebar itself stays fully visible, usable, and on top
      (not clipped or hidden), and that closing it restores the page exactly as it was.

---

## 1. Sidebar activation & lifecycle (§1.1, §3.1)

- [ ] **1.1.** Click the extension icon on a normal page → sidebar opens on the right edge.
- [ ] **1.2.** The page itself visibly narrows/reflows to make room — the sidebar does **not**
      float on top of or cover page content.
- [ ] **1.3.** Sidebar header shows a logo + "salamander" wordmark (display italic), a theme
      toggle, and a close button. Below it, a separate action row holds the primary "add note"
      button (icon + label) and the export/import icon buttons.
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
- [ ] **1.11. (Resizable sidebar)** Hover the sidebar's left edge — cursor should change to a
      resize cursor and a thin yellow rail should appear. Drag it wider and narrower. It should
      stop at 100px (min) and 300px (max) and not go past either. Reload the page — the width you
      left it at should be remembered.
- [ ] **1.12.** With the sidebar resized to a non-default width, open add mode — the selection area
      must not extend under the sidebar. Then open a note: the enlarged view expands to ~75% of the
      window regardless of the sidebar width, and collapsing returns the sidebar to your width.
- [ ] **1.13. (Theme toggle)** Click the theme toggle in the header — it cycles auto → light →
      dark → auto. Its icon (sun/moon/half-circle) and its aria-label/title (hover to see the
      tooltip) should always describe the *current* mode, e.g. "theme: auto". Confirm the whole
      sidebar (background, text, accent colour) actually repaints for light vs. dark. Reload the
      page — the mode you left it on should be remembered. With two tabs open on the same site,
      change the theme in one — the other should update live, without a reload.
- [ ] **1.14. (Auto theme follows the OS)** Set the toggle to "auto", then flip your OS/browser's
      light/dark appearance setting (or emulate it via DevTools' Rendering panel → "Emulate CSS
      prefers-color-scheme") — the sidebar (and add mode / the enlarged view, if open) should repaint to match
      without any click.
- [ ] **1.15. (Narrow sidebar widths)** Drag the sidebar narrower than ~220px — the "salamander"
      wordmark should hide and "add note" should collapse to an icon-only button (its accessible
      label stays "add note"). Keep dragging to the 100px minimum — the action row should
      wrap so "add note" and the export/import icons all stay reachable with nothing clipped or
      overflowing, and the logo mark should hide too.
- [ ] **1.16. ("this page (n)" heading)** With items captured on the current page, the sidebar
      shows a small "this page (n)" heading above the list, where n matches the visible item count.
      Delete items down to zero — the heading should disappear and the empty state should show
      instead (never both at once).
- [ ] **1.17. (Notification banners)** Trigger an error or warning (e.g. import an invalid file —
      see §5.4) — confirm it renders as a small rounded banner just under the action row (not a
      full-width black bar), with an icon and lowercase text, and a thin progress line along its
      bottom edge that drains over about 8 seconds before the banner auto-clears.
- [ ] **1.18. (Dock magnification — hover)** With 4+ items in the list, move your mouse slowly up
      and down over it. The item nearest the cursor should grow and shift left (out over the page)
      the most, with neighbouring items growing progressively less — smooth and continuous like the
      macOS Dock, never a sudden jump between discrete "hovered/not hovered" states. The hovered
      item's note text should gain a subtle background as it magnifies. Moving the mouse off the
      list should relax every item back to its resting size smoothly, not instantly.
- [ ] **1.19. (Dock magnification — keyboard focus)** Click into the page to move focus away, then
      Tab into the sidebar's note list. The focused item should magnify the same way a hovered item
      does, and its note background should appear.
- [ ] **1.20. (Reduced motion)** Enable "prefers-reduced-motion: reduce" (DevTools Rendering panel,
      or your OS's reduce-motion setting), then hover/focus items in the list again — none of them
      should grow or shift position, but the hovered/focused item's note background should still
      appear normally.

## 2. Add mode & capture (§1.2, §1.3, §3.2)

- [ ] **2.1.** Click **add** → cursor becomes a crosshair, page clicks stop navigating/activating
      anything underneath.
- [ ] **2.2. (Click-to-place, centered)** Click once somewhere in the middle of the page (not near
      an edge) → a box the same size as the sidebar's note thumbnail at the sidebar's default width
      (267×100px, fixed — does not change if you've resized the sidebar) appears **centered on your
      click point** (not with the click point as its top-left corner), with a dimming scrim over
      everything outside the box (rest of the page visibly darkened, box itself stays fully clear —
      like the macOS screenshot tool).
- [ ] **2.2b. (Click near an edge — clamped, not centered)** Click very close to the top-left
      corner of the viewport (e.g. within ~20px of both edges). The box should **not** hang off
      the edge or get cut off — it should shift to stay fully on-screen (e.g. clicking at
      roughly (20,20) should produce a box from about (0,0) to (267,100), not one centered on the
      click point). Repeat near the top-right, bottom-left, and bottom-right corners.
- [ ] **2.2c. (Drag-to-draw)** Instead of a single click, press and drag a noticeable distance
      (like drawing a rectangle in Figma) → the box should be exactly the rectangle you dragged,
      not the default thumbnail-matching size, updating live as you drag in any direction
      (down-right, up-left, etc.).
- [ ] **2.3.** Box has a rounded outline (yellow `#FEC800` plus a thin dark keyline outside it) —
      no visible square handles anywhere on the corners or edges.
- [ ] **2.4.** Hover near an edge (roughly a 10px-thick strip straddling the outline) or a corner
      (roughly a 16×16 area centred on it) — the cursor should change to the matching resize cursor
      (↕/↔/⤡/⤢) even though nothing is drawn there, and dragging from that invisible zone should
      resize the box from that edge/corner. Try shrinking it down from a corner — it should refuse
      to go below ~20×20px.
- [ ] **2.5.** Drag the box (or a handle) toward a viewport edge — it should stop exactly at the
      edge, never extend past it or trigger the page to scroll.
- [ ] **2.6.** Comment box appears attached to the selection box (below it by default) as a single
      rounded, merged surface — no gap or divider between the textarea and the footer bar below it,
      only the footer's own top hairline. The empty textarea shows the placeholder "what should
      change here?". Type in it — no counter should be visible yet under 900 characters.
- [ ] **2.7.** Keep typing past 900 characters — a muted counter (e.g. "942/1000") should appear.
      Continue past 980 — the counter should turn red/danger-coloured (e.g. "980/1000"). Confirm
      you're hard-capped at 1000 chars.
- [ ] **2.8.** With the textarea empty, confirm **save** is disabled (muted, unclickable).
- [ ] **2.9.** Click somewhere outside the box/comment area (on the dimmed page) — nothing should
      happen at all: no dismiss, no shake/wiggle, no page interaction underneath.
- [ ] **2.10.** Click **cancel** — box, scrim, and comment box all disappear, add mode exits, no
      thumbnail is created.
- [ ] **2.11.** Repeat 2.1–2.7, then click **save** with valid text — the label may briefly read
      "saving…" while the textarea/buttons lock, overlay UI should disappear briefly, then a new
      thumbnail appears at the bottom of the sidebar list showing the screenshot and a truncated
      preview of your note.
- [ ] **2.12.** Capture 3+ items across 2 different pages of the same site (domain). Confirm the
      item numbers keep incrementing across pages (e.g. page A gets #1–2, page B continues at #3),
      not restarting per page.
- [ ] **2.13. (Restricted pages)** Try clicking the extension icon on `chrome://extensions`, a
      blank new tab, or an open PDF. The sidebar should not appear, and nothing should break on the
      page itself.
- [ ] **2.14. (Capture failure)** Trigger 4–5 captures back-to-back as fast as you can. At least
      one should show an error like "couldn't capture a screenshot here. try again." rather than
      silently failing or creating a broken item — confirm no partial/blank thumbnail appears.

- [ ] **2.15. (add note toggle)** **add note** looks like a secondary button when off. Click it → it
      turns yellow (on) and add mode starts; click it again → add mode is cancelled and it's off.
      Hover/press show yellow in both states; Tab to it → a focus ring appears.
- [ ] **2.16. (lock)** Double-click **add note** (also try shift+click and shift+enter) → a small
      padlock appears on the button. Capture a note → you're immediately back in add mode for the
      next one. Click **cancel** in a comment box → that note is discarded but you stay in add mode.
      Single-click the button, or press Esc → the lock and add mode both end.
- [ ] **2.17.** While locked, close the sidebar, or navigate to another page in the app — the lock
      and add mode end cleanly, and the button shows off when the sidebar is reopened.
- [ ] **2.18. (comment box)** The comment box is a rounded text area with a button bar tucked under
      it (same width, edges line up). Hover the text area → its border darkens; focus it → the
      border turns yellow (no extra glow). cancel/save are padded ghost buttons; save fills yellow
      on hover, press and keyboard focus.

## 3. Viewing & managing feedback (§1.5, §3.3)

- [ ] **3.1.** Click a thumbnail → the sidebar expands leftward to ~75% of the window (the page
      itself doesn't reflow; the strip still visible is dimmed). The clicked thumbnail should
      visibly *grow* into the large screenshot, and the notes above/below it grow into the peeking
      cards — nothing should just fade or jump. The title reads "feedback #n" with "n / total".
- [ ] **3.2.** Edit the note, then pause — a muted "✓ saved" appears briefly. Collapse (x) and
      reopen to confirm the edit was kept (there is no save button).
- [ ] **3.3.** Edit the note and immediately press ↓ (or Esc) without pausing — the edit must still
      be saved (flushed on navigate/collapse).
- [ ] **3.3a. (navigation)** Use ↓/↑ (focus not in the text area), the rail's ↑/↓ buttons, and
      clicks on the peeking cards to move between notes — each move is a smooth carousel (the
      peek grows into the main slot, the main shrinks into the opposite peek). ↑ is disabled on
      the first note, ↓ on the last. Hover a peek → the top one nudges down, the bottom one up,
      nothing else. Press ↓ several times quickly — it should keep up without glitches.
- [ ] **3.3b. (empty note)** Clear the note text completely (or leave only spaces), then try to
      leave: x, Esc, clicking the dimmed page, ↑/↓, the peeks, closing the sidebar. Every one must
      be blocked with the inline error "a note can't be empty. add some text to continue." and a red
      text-area border; the old text is still what's stored. Type something → the error clears and
      leaving works again.
- [ ] **3.3c. (reduced motion)** Turn on reduced motion (OS setting, or DevTools → Rendering →
      emulate prefers-reduced-motion) — opening, navigating and collapsing should change layout
      instantly with only crossfades, no sliding or growing.
- [ ] **3.4.** In the enlarged view click **delete** — the note disappears immediately (no
      confirmation) and the view moves on to the next note (or the previous one if it was last);
      deleting the only note collapses back to the empty list. Reload to confirm it's really gone.
- [ ] **3.5.** After capturing several items, confirm the newest one appears at the **bottom** of
      the sidebar list (chronological order, not reverse).
- [ ] **3.6.** Capture items on page A, navigate to page B (different URL, same domain) — sidebar
      should show **only** page B's items, not page A's. Navigate back to page A — its items should
      reappear, unchanged.
- [ ] **3.7. (Fixed-size thumbnails)** Capture a very wide/short selection and a very tall/narrow
      selection. Both thumbnails should occupy the same fixed-height image box in the sidebar, with
      the actual screenshot scaled to fit inside it — no thumbnail should be a different height
      than the others, and no screenshot should be cropped (the full image should always be
      visible, letterboxed if its aspect ratio doesn't match the box).
- [ ] **3.8. (Focus)** Open a note with the keyboard (Tab to a thumbnail, Enter) — focus lands on the
      x button in the rail; Tab cycles rail → peeks → note → delete. Collapse (x or Esc) — focus
      returns to the thumbnail you opened it from. Delete the only note — focus lands on the add
      note button, not the page body.
- [ ] **3.8a.** Start add mode, place a box and type a comment, then click a note in the list — it
      must not open; a banner says "finish or cancel your note first." and your comment is kept.
- [ ] **3.8b.** Edit a note, then immediately reload the page — the edit should still be there
      afterwards (pending edits are flushed on unload).
- [ ] **3.9. (Note hover)** Hover a note in the list — the thumbnail keeps all four rounded corners
      and the note text gains a background that tucks under the thumbnail (same width, edges
      aligned); the text itself doesn't move.

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
      recognizable text/UI. Open the note in the enlarged view and visually compare — no offset or misalignment between
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
- [ ] **6.8. (App-shell sites — known limitation, see REQUIREMENTS.md §6 #13)** On youtube.com,
      confirm the sidebar itself is still fully usable even though the page may not visibly narrow
      the way it does on simpler sites. This is a documented, accepted limitation (YouTube sizes
      its player using viewport units and `window.innerWidth`, which a content script cannot force
      to shrink) — not something to file as a new bug unless the sidebar itself becomes unusable
      or the page breaks/errors.

## 7. Text case convention (§3.4)

- [ ] **7.1.** Scan every piece of visible text you've encountered so far — button labels,
      placeholder text ("what should change here?"), error messages, confirm dialogs, the
      empty-state message. All of it should be **lowercase**, no exceptions, no title case.

## 8. End-to-end journey smoke tests (§4)

- [ ] **8.1. (Journey 1)** From a cold start (extension freshly loaded, no prior data): open
      sidebar → add → place box → resize → note → save → thumbnail appears → repeat on a second page
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
