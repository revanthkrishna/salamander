# salamander

> Chrome extension for design feedback on any webpage. Select an area, draw on it, write a note; salamander screenshots the area, records where it sits in the DOM, and exports everything as a bundle a developer or an AI coding agent can act on.

Version 2.2.0 · Manifest V3 · MIT · [Chrome Web Store](https://chromewebstore.google.com/detail/salamander/meemlolebjpemamjgeppcpklhegdombd)

## how it works

1. launch salamander on any website.
2. click "add note", then click or drag to select an area.
3. mark up the area with the pencil.
4. write your note and save. the screenshot and the element data are captured together.
5. add as many notes as you want, then export them in one click. send the zip to a colleague, or drop it into claude, cursor or chatgpt.

Shortcut: **Option+N** (Mac) or **Alt+N** (Windows/Linux) adds a note while the sidebar is open. Click any note to see every note on the site in one editable view.

## the export

One `.zip` per site: `feedback.md` plus `screenshots/{id}.png`. Each note in `feedback.md` has its screenshot, the note, and its element data (CSS selector, XPath, HTML snippet, page URL) as JSON, so the code can be found without the live page. The extension imports the same file back. The format is specified in `design/SALAMANDER_SPEC.md` §AC.

## privacy

No accounts, no servers, no network requests (`connect-src 'none'`). Everything stays in your browser until you export or delete it. See [PRIVACY.md](PRIVACY.md) for what is stored and why each permission is needed.

## development

Requires Chrome 105 or newer.

```bash
npm install
npm run build          # esbuild → dist/ (not committed)
npm test               # jest unit tests
npx tsc --noEmit       # type check
npx playwright test    # end-to-end against a real Chromium (needs a build)
```

To load it: `chrome://extensions` → **Developer mode** → **Load unpacked** → the project root. After a rebuild, reload the extension and refresh the tab.

`REQUIREMENTS.md` describes the behaviour, `TECH_DESIGN.md` the architecture, `TESTING.md` the test suites.

## license

MIT — see `LICENSE`.
