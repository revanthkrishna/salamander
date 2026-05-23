# Testing

How to test the annotator extension after code changes — both the unit-test loop and the manual browser-loop.

## Unit tests

```bash
npm test            # full Jest run
npx jest fingerprint   # just the fingerprint tests
```

The `fingerprint.test.ts` suite covers:
- CSS-selector generation (data-* preference, ID rules, nth-of-type fallback, rejection of UUIDs / numerics / React `useId` patterns).
- XPath generation (data-* / heading-anchored / positional).
- `headingPath` capture (document order, descendant exclusion, 10-entry cap, 80-char trim, `role="heading"` inclusion).
- `resolveElement` round-trip via CSS, XPath, and text+tag fallback.
- `headingPath` scoring regression (the wizard case — see below).
- Backward compat: legacy fingerprints without `headingPath` still resolve.

jsdom doesn't implement layout, so `offsetWidth`/`offsetHeight` are stubbed in `src/__tests__/setup.ts` to return non-zero for any element connected to the document. Without that stub, `isVisible()` would reject every element and every `resolveElement` test would fail. Don't remove it.

## Build & load in Chrome

The extension's compiled bundle lives in `dist/`. Chrome reads from there directly via "Load unpacked".

```bash
npm run build       # esbuild → dist/
```

In Chrome:
1. `chrome://extensions` → enable Developer mode.
2. **First time only**: "Load unpacked" → pick the project root (the directory with `manifest.json`).
3. After every rebuild: click the **reload (↻)** icon on the extension card.
4. After reloading the extension, **refresh the test tab** (⌘⇧R / Ctrl+Shift+R). Content scripts injected into open tabs become orphaned when you reload the extension, throwing `Cannot read properties of undefined (reading 'onChanged')` on the next interaction. A page refresh re-injects the new content script.

## Manual smoke test — Cloudscape wizard regression

This is the case the `headingPath` signal was built to handle. Use it to verify the resolver doesn't false-positive on wizard step changes.

**Page:** <https://cloudscape.design/examples/react/wizard.html>

**Steps:**
1. Click through the wizard until you're on the **penultimate step** (e.g. "Maintenance and monitoring").
2. Activate the extension toolbar and pin the step's **Previous** button.
3. Click **Next** to go to the final **Review and submit** step (renders a summary of all prior steps, including their section headings).
4. **Expected:** the pin disappears (unresolved) — Maintenance's button is no longer in the DOM, and Review's Previous button has a different surrounding heading set, so resolution should refuse to attach.
5. Click **Previous** to go back. **Expected:** the pin reappears on the Maintenance step's Previous button.

**Failure mode:** the pin attaches to the Review step's Previous button. This used to happen because Review's summary contains an `<h…>Maintenance and monitoring</h…>` section heading, so `closestLabel` and `pageHeading` text-collide with the captured fingerprint. Two layered defenses now catch this: (1) the `headingPath` set comparison adds a direct penalty (missing −10 each capped −60, extra −7 each capped −40), and (2) the `closestLabel` / `pageHeading` / `pageSubHeading` *match bonuses* are scaled by Jaccard similarity of stored vs. current `headingPath`, so a coincidental text match earns proportionally less credit when the broader context disagrees.

### Variant: the Cancel button (shared across all steps)

Cloudscape's Cancel button is a single DOM element in the wizard footer — same element across every step. This variant exists because the CSS selector keeps matching uniquely across step changes (the button never leaves the DOM), so the previous-button defenses (XPath fallback, candidate-set diversity) don't kick in.

**Steps:**
1. Pin the **Cancel** button on, say, the **Review and submit** step.
2. Click **Previous** to navigate back to an earlier step (e.g. "Maintenance and monitoring").
3. **Expected:** the pin disappears. The button's identity hasn't changed, but its surrounding heading context has — the `headingPath` agreement is low (~0.18 for this example), which scales the `closestLabel` / `pageHeading` match bonuses down to a few points each, and the `scoreHeadingPath` direct penalty pushes the candidate well below threshold.
4. Click **Next** back to Review and submit. **Expected:** the pin reappears on the Cancel button.

**Why this case was the test:** the previous-button case alone could be fixed with weight bumps on `scoreHeadingPath`. The Cancel button case requires the *agreement-scaling* layer — text-match bonuses need to depend on broader-context confidence, not just contribute additively.

## Debug tracer

When something resolves wrong (or fails to resolve), turn on the debug log to see the per-candidate score breakdown.

**Enable** in the page's DevTools console (no need to switch to the content-script world):

```js
localStorage.__annotatorDebug = '1'
```

**Disable:**

```js
localStorage.removeItem('__annotatorDebug')
```

**Trigger a re-resolve** by navigating, reloading the page, or toggling annotation mode off/on. The RAF loop in `pinRenderer` re-resolves on DOM changes.

**Sample output** (Cancel button case, on the wrong step — should *not* resolve):

```
[Annotator] ────────── resolveElement ──────────
[Annotator] fingerprint: { textSnippet: "Cancel", pageHeading: "Maintenance and monitoring", headingPath: [...], … }
[Annotator] 2 candidate(s) collected
[Annotator]   • <button.awsui_cancel-button_…> "Cancel" → -8
[Annotator]       CSS-unique +60
[Annotator]       closestLabel match: stored="Maintenance and monitoring" current="Maintenance and monitoring" +4 (scaled ×0.18 from headingPath agreement)
[Annotator]       pageHeading match: stored="Maintenance and monitoring" current="Maintenance and monitoring" +3 (scaled ×0.18 from headingPath agreement)
[Annotator]       headingPath -85 (agreement=0.18, stored=[...10 entries...] current=[...different 10 entries...])
[Annotator]       domIndex match (1) +10
[Annotator]   ✗ <button.awsccc-u-btn> "Cancel" INVISIBLE → -1000
[Annotator] → best score -8 below threshold 40 — returning null
```

What the lines tell you:
- The candidate set size — if 0, no element matched any of CSS / XPath / text+tag. Stored selector or XPath is probably broken (e.g. unstable ID).
- The base score — `CSS-unique +60` is best; `XPath +50`, `text+tag unique +40`, `text+tag non-unique +20`, `CSS-non-unique +30`. Falling back to `text+tag` means the stored CSS selector and XPath aren't matching anymore.
- Per-signal deltas, with the actual stored vs. current values for each context signal. The `(scaled ×0.XX from headingPath agreement)` suffix on a *match* line means the bonus was discounted because the broader heading context disagrees — the bug-catching signal. `MISMATCH` is the other line to watch.
- The final winner and whether it cleared the 40-point threshold.

If the trace shows `INVISIBLE → -1000` for the candidate you expected to match, the page is hiding it via a mechanism `isVisible()` doesn't catch (e.g. `aria-hidden`, `inert`, `clip-path`). That's an `isVisible()` bug, not a fingerprint bug.

## Gotchas

- **Old pins don't benefit from new signals.** A fingerprint captured before a code change has whatever fields were captured at that time. Add a new signal? Old pins keep using the old fingerprint shape. To test improvements, delete and re-pin.
- **Re-pinning isn't enough if the bundle didn't change.** Confirm `dist/content.js` was rebuilt after your code change before testing in Chrome.
- **Hard-refresh after extension reload.** Otherwise the content script throws `chrome.storage` undefined.
- **The `:claude/` and `.claude/` directories** at the project root are local config — don't commit them.
- **YAML round-trip touches `importExport.ts` whitelists.** Any new optional fingerprint field must be added to both the import (snake_case → camelCase) and export (camelCase → snake_case) sections, otherwise exports silently drop the field.
