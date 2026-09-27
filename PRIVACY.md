# Privacy policy

**Extension:** salamander
**Last updated:** 26 September 2026

## The short version

Salamander does not collect, transmit, or sell any data. Everything it captures stays on your own computer.

## What salamander stores

When you capture feedback, salamander saves the following in your browser's local storage on your device:

- the screenshot of the region you selected
- the note you wrote
- data about the element you selected: its CSS selector, its XPath, the surrounding HTML, and the text inside it
- the address and title of the page you captured it on
- interface state, such as whether the sidebar is open and how wide you made it

That is all of it. Salamander does not record your browsing history, does not read pages you have not opened it on, and does not capture anything on a page until you select a region and save a note.

## Where that data goes

Nowhere. Salamander has no servers, no accounts, and no analytics. It makes no network requests of any kind: the extension's content security policy sets `connect-src 'none'`, which means the browser itself blocks it from contacting any server, including ours.

Your data leaves your machine only when you choose to export it. Exporting writes a zip file to your computer, containing a Markdown file and the screenshots. What you then do with that file is entirely up to you. If you send it to a colleague or paste it into an AI tool, that transfer is your action, not the extension's, and is governed by whatever service you send it to.

## Who it is shared with

No one. Salamander has no third parties: no analytics provider, no crash reporter, no advertising network, no hosting provider. No data is sold or transferred to anyone, for any purpose.

## How it is stored and secured

Everything is held in your browser's own local storage on your device (`chrome.storage` for notes and settings, IndexedDB for screenshots), inside the extension's private storage area, which other extensions and websites cannot read. The extension's interface is isolated from the pages you visit using closed shadow DOM, so a page cannot see or alter your feedback. Because nothing is transmitted, there is no server-side copy to secure, and no data in transit to intercept.

## Deleting your data

Delete an individual note from the sidebar, or uninstall the extension to remove everything it has stored. No copy is kept anywhere else, because no copy was ever made anywhere else.

## Permissions

Salamander requests these browser permissions, and uses them only as described:

- **storage** and **unlimitedStorage** — to save your feedback on your device. Screenshots are full-resolution images and exceed the default quota.
- **scripting** — to place salamander's sidebar on the page you are reviewing, after you click the toolbar icon.
- **tabs** — to identify the active tab, capture its visible area for the screenshot, and keep notes attached to the correct page as you navigate.
- **downloads** — to save the exported zip file when you click export.
- **host permission for all sites** — because you can review any website, salamander cannot know in advance which sites you will use it on. It stays inactive on every page until you click the toolbar icon there.

## Contact

Questions or concerns: email revk44@gmail.com, or open an issue at https://github.com/revanthkrishna/salamander/issues

## Changes

If this policy changes, the updated version will be published at this address and the date at the top will change.
