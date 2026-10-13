// src/pageHeading.ts
// One page's heading in the enlarged view (design spec §AH): the page's
// name in the display serif, a pencil to rename it, its address in the
// monospace face and — on the page on screen — a "this page" label.
//
//   [name][✎]  example.com/blog/…/post   [this page]
//   [ field…………………… ][✓][×]  example.com/…   (while renaming)
//
// The name is the HTML title captured with the page's notes until the
// reviewer renames it; renaming swaps the name for a text field styled like
// the note text areas, with save and cancel beside it. Enter or ✓ saves, Esc
// or × cancels (src/enlargedView.ts routes Esc here first, so it never
// collapses the view while a name is being edited), and moving focus out of
// the field saves, the way a rename does in Finder or Figma — a name typed
// and clicked away from is never silently lost. Saving an empty or
// whitespace-only name, or the default itself, gives the page back its
// default.
//
// The heading owns its DOM and its edit state; what a rename means for
// storage is the caller's (`onRename`), which answers whether it stuck. The
// new name shows at once and goes back if it did not, with an error under
// the heading.
//
// The address is middle-ellipsized to the room it has (ellipsizeMiddle):
// its face is monospace, so the room is a character count, measured once per
// heading set from the face itself (measureCharWidth).

import { displayUrl, ellipsizeMiddle, Box } from './enlargedLayout';
import { ICON_CHECK, ICON_CLOSE, ICON_PENCIL } from './icons';
import {
  CONFIRM_CANCEL_LABEL,
  EDIT_PAGE_NAME_TIP,
  PAGE_NAME_FIELD_LABEL,
  PAGE_NAME_SAVE_ERROR_MESSAGE,
  SAVE_PAGE_NAME_LABEL,
  THIS_PAGE_LABEL,
  editPageNameLabel,
} from './copy';

/** Longest name the field takes — a page name, not a note. */
export const PAGE_NAME_MAX_LENGTH = 200;

export interface PageHeadingOptions {
  url: string;
  /** The page on screen gets the "this page" label. */
  isCurrent: boolean;
  /** The name it falls back to: the captured HTML title. */
  defaultName: string;
  /** The reviewer's name for it, or null. */
  editedName: string | null;
  /** Unique within the view; the heading's ids derive from it. */
  idPrefix: string;
  /** Persist `name` (null = back to the default); resolves whether it
   *  stuck. */
  onRename: (name: string | null) => Promise<boolean>;
  /** The shown name changed (a rename, or one reverted): the notes under
   *  it name their page in their labels. */
  onNameChanged: () => void;
}

export class PageHeading {
  readonly el: HTMLDivElement;
  readonly url: string;
  private readonly nameEl: HTMLHeadingElement;
  private readonly editBtn: HTMLButtonElement;
  private readonly editor: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly urlEl: HTMLSpanElement;
  private readonly statusEl: HTMLParagraphElement;
  private readonly defaultName: string;
  private edited: string | null;
  private editing = false;
  /** Bumped by every rename, so a reply that arrives after a newer rename
   *  never reverts it. */
  private renameSeq = 0;
  /** The monospace advance the address was last fitted with (fitAddress),
   *  so a change of what sits beside it — a new name, the rename field —
   *  can refit it. 0 until the view has measured it. */
  private charW = 0;

  constructor(private readonly opts: PageHeadingOptions) {
    this.url = opts.url;
    this.defaultName = opts.defaultName;
    this.edited = opts.editedName;

    const el = document.createElement('div');
    el.className = 'xp-page';
    el.dataset.pageUrl = opts.url;
    this.el = el;

    this.nameEl = document.createElement('h2');
    this.nameEl.className = 'xp-page-name';
    this.nameEl.id = `${opts.idPrefix}-name`;

    this.editBtn = button('xp-page-edit', ICON_PENCIL);
    this.editBtn.dataset.tip = EDIT_PAGE_NAME_TIP;
    this.editBtn.addEventListener('click', () => this.beginEdit());

    this.editor = document.createElement('div');
    this.editor.className = 'xp-page-editor';
    this.editor.hidden = true;
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'xp-page-input';
    this.input.maxLength = PAGE_NAME_MAX_LENGTH;
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', PAGE_NAME_FIELD_LABEL);
    this.saveBtn = button('xp-page-save', ICON_CHECK);
    this.saveBtn.setAttribute('aria-label', SAVE_PAGE_NAME_LABEL);
    this.saveBtn.dataset.tip = SAVE_PAGE_NAME_LABEL;
    this.saveBtn.addEventListener('click', () => this.commit());
    this.cancelBtn = button('xp-page-cancel', ICON_CLOSE);
    this.cancelBtn.setAttribute('aria-label', CONFIRM_CANCEL_LABEL);
    this.cancelBtn.dataset.tip = CONFIRM_CANCEL_LABEL;
    this.cancelBtn.addEventListener('click', () => this.cancel());
    this.editor.append(this.input, this.saveBtn, this.cancelBtn);
    // Focus leaving the field and its two buttons saves (see the banner);
    // moving between the three does not.
    this.editor.addEventListener('focusout', (e) => {
      const next = e.relatedTarget;
      if (this.editing && !(next instanceof Node && this.editor.contains(next))) this.commit({ refocus: false });
    });

    this.urlEl = document.createElement('span');
    this.urlEl.className = 'xp-page-url';
    this.urlEl.dataset.tip = opts.url;
    this.urlEl.textContent = displayUrl(opts.url);

    const line = document.createElement('div');
    line.className = 'xp-page-line';
    line.append(this.nameEl, this.editBtn, this.editor, this.urlEl);
    if (opts.isCurrent) {
      const here = document.createElement('span');
      here.className = 'xp-page-here';
      here.textContent = THIS_PAGE_LABEL;
      line.append(here);
    }

    this.statusEl = document.createElement('p');
    this.statusEl.className = 'xp-page-status';
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');

    el.append(line, this.statusEl);
    this.renderName();
  }

  /** The name shown: the reviewer's, else the default. */
  get name(): string {
    return this.edited ?? this.defaultName;
  }

  get nameId(): string {
    return this.nameEl.id;
  }

  isEditing(): boolean {
    return this.editing;
  }

  setBox(box: Box): void {
    const s = this.el.style;
    s.left = `${box.x}px`;
    s.top = `${box.y}px`;
    s.width = `${box.w}px`;
    s.height = `${box.h}px`;
  }

  /** Swap the name for the field, holding the current name, all selected. */
  beginEdit(): void {
    if (this.editing) return;
    this.editing = true;
    this.setStatus('');
    this.input.value = this.name;
    this.nameEl.hidden = true;
    this.editBtn.hidden = true;
    this.editor.hidden = false;
    this.el.classList.add('is-editing');
    this.fitAddress();
    this.input.focus({ preventScroll: true });
    this.input.select();
  }

  /**
   * Save what is in the field and leave edit mode. Empty, whitespace-only or
   * the default itself means "the default" (null). `refocus` returns focus
   * to the pencil — false when focus has already gone elsewhere (a click
   * away, the view closing).
   */
  commit({ refocus = true }: { refocus?: boolean } = {}): void {
    if (!this.editing) return;
    const typed = this.input.value.trim();
    const next = typed === '' || typed === this.defaultName ? null : typed;
    this.leaveEdit(refocus);
    if (next === this.edited) return;
    const prev = this.edited;
    const seq = ++this.renameSeq;
    this.edited = next;
    this.renderName();
    this.opts.onNameChanged();
    void this.opts
      .onRename(next)
      .catch(() => false)
      .then((ok) => {
        if (ok || seq !== this.renameSeq) return;
        this.edited = prev;
        this.renderName();
        this.opts.onNameChanged();
        this.setStatus(PAGE_NAME_SAVE_ERROR_MESSAGE);
      });
  }

  /** Leave edit mode without saving. */
  cancel({ refocus = true }: { refocus?: boolean } = {}): void {
    if (!this.editing) return;
    this.leaveEdit(refocus);
  }

  /**
   * Fit the address to the room the line leaves it, ellipsizing in the
   * middle. `charW` is the monospace face's advance (measureCharWidth); a
   * layout-less environment (0) leaves the full address. Called again by
   * the heading itself whenever the name beside it changes width. Also
   * gives a name its own ellipsis cut short a tooltip with all of it.
   */
  fitAddress(charW: number = this.charW): void {
    this.charW = charW;
    // A name cut short by its 60% cap says the rest in its tooltip.
    if (this.nameEl.scrollWidth > this.nameEl.clientWidth + 1) this.nameEl.dataset.tip = this.name;
    else delete this.nameEl.dataset.tip;
    const full = displayUrl(this.url);
    this.urlEl.textContent = full;
    const room = this.urlEl.clientWidth;
    if (!(charW > 0) || !(room > 0) || this.urlEl.scrollWidth <= room + 0.5) return;
    this.urlEl.textContent = ellipsizeMiddle(full, Math.max(1, Math.floor(room / charW)));
  }

  /** The heading's controls, in tab order. */
  focusables(): HTMLElement[] {
    return this.editing ? [this.input, this.saveBtn, this.cancelBtn] : [this.editBtn];
  }

  private leaveEdit(refocus: boolean): void {
    const root = this.el.getRootNode();
    const active = root instanceof ShadowRoot || root instanceof Document ? root.activeElement : null;
    const hadFocus = active instanceof Node && this.editor.contains(active);
    this.editing = false;
    this.editor.hidden = true;
    this.nameEl.hidden = false;
    this.editBtn.hidden = false;
    this.el.classList.remove('is-editing');
    this.fitAddress();
    if (refocus && hadFocus) this.editBtn.focus({ preventScroll: true });
  }

  private renderName(): void {
    this.nameEl.textContent = this.name;
    this.editBtn.setAttribute('aria-label', editPageNameLabel(this.name));
    if (this.charW) this.fitAddress();
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('is-shown', text !== '');
  }
}

/** The monospace face's advance width at the address's size, measured from
 *  a probe of 20 characters inside `parent` (the face is loaded through the
 *  FontFace API, so it can only be measured in place). 0 without layout. */
export function measureCharWidth(parent: HTMLElement): number {
  const probe = document.createElement('span');
  probe.className = 'xp-page-url';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.textContent = '0'.repeat(20);
  parent.appendChild(probe);
  const w = probe.scrollWidth / 20;
  probe.remove();
  return Number.isFinite(w) ? w : 0;
}

function button(className: string, icon: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.innerHTML = icon;
  return b;
}
