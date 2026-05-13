# Annotator — Requirements

> Chrome extension for inline web annotations. Annotate any webpage, export as a file, share with others who can import and view the same annotations.

---

## Status: 🟡 Draft — In Progress

---

## 1. Functional Requirements

### 1.1 Annotating
- [ ] User can activate annotation mode on any webpage via the extension
- [ ] User can click any element on the page to select it
- [ ] User can attach a text note to the selected element
- [ ] User can edit an existing annotation
- [ ] User can delete an existing annotation
- [ ] Annotations persist across page reloads (within the same session/browser)

### 1.2 Exporting
- [ ] User can export all annotations for the current page as a file
- [ ] Export file format: TBD (JSON preferred — human-readable)
- [ ] Export file includes: page URL, element selectors, annotation text, timestamp, author name (optional)

### 1.3 Importing
- [ ] Another user can import an annotation file into the extension
- [ ] Extension applies annotations to the correct elements on the matching URL
- [ ] Graceful error handling if file is invalid or URL doesn't match
- [ ] Imported annotations are visually distinct from own annotations (TBD)

### 1.4 Managing Annotations
- [ ] User can view a list of all annotations on the current page
- [ ] User can navigate to an annotated element from the list
- [ ] User can clear all annotations on the current page

---

## 2. Non-Functional Requirements

- Works on any public webpage
- No backend / server required (fully local + file-based in v1)
- Annotation file is human-readable (JSON)
- Import is fault-tolerant — graceful errors, no crashes
- Annotations render without breaking page layout
- Fast — annotation interactions feel instant (no lag)
- Chrome desktop only (v1)

---

## 3. UX / UI Requirements

### 3.1 Annotation Mode
- [ ] Clear visual indicator when annotation mode is active vs inactive
- [ ] Hovering over an element highlights it as selectable
- [ ] Clicking an element opens an input to write the annotation

### 3.2 Annotation Display
- [ ] TBD: sticky-note style popups? numbered pins + sidebar? tooltip on hover?
- [ ] Annotations don't break or obscure the page content
- [ ] Annotated elements are visually marked (badge, underline, pin, etc.)

### 3.3 Sidebar / Panel
- [ ] Extension opens a sidebar or popup panel
- [ ] Panel shows: list of annotations, export button, import button
- [ ] Panel allows toggling annotation mode on/off

### 3.4 Keyboard Shortcuts
- [ ] Shortcut to toggle annotation mode (TBD, e.g. Alt+A)

---

## 4. Open Questions

These need decisions before build starts:

| # | Question | Decision |
|---|----------|----------|
| 1 | Annotation types: text only, or also highlights / tags / emoji? | TBD |
| 2 | Annotation display style (pins, bubbles, sidebar list)? | TBD |
| 3 | Export covers one URL only, or multiple pages in one file? | TBD |
| 4 | Handling dynamic pages (React/SPA where elements shift)? | TBD |
| 5 | Author name in export — mandatory, optional, or none? | TBD |
| 6 | Can multiple annotation files be merged / layered? | TBD |
| 7 | Imported annotations: same look or visually distinct? | TBD |

---

## 5. Out of Scope (v1)

- Real-time collaboration
- Cloud sync or backend
- Comment threads / replies
- Mobile / non-Chrome browsers
- Video or audio annotations
- Auth / user accounts
