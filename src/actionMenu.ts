// src/actionMenu.ts
// The sidebar's "more options" menu (design spec v3 §C2, §AE) and the
// confirmation it turns into (§AF): its elements, its keyboard handling,
// closing on a press outside, and the morph into a question. Moved out of
// sidebar.ts unchanged; sidebar.ts builds one per panel, places it in the
// export group and wires its two items' clicks (import, delete all).
//
// Lives inside the sidebar's own closed shadow root — there is nowhere else
// it could go — and is shown/hidden via a `data-open` attribute so the CSS
// owns both the entrance and the (shorter) exit. Nothing inside it is
// focusable while it is closed: the closed rule is `visibility: hidden`.
//
// The menu as a confirmation (§AF): delete-all, and import when the site
// already has notes, ask in place: the menu itself turns into the question.
// Its box morphs from the menu's size to the full width of the panel (16px
// from each side, like the action row) and the question's height; only the
// size animates, the contents swap at once. The contents are laid out at
// their final width and pinned to the box's top-right corner, so the growing
// box uncovers them rather than reflowing them frame by frame. Anything that
// closes the menu — cancel, Esc, a press outside, the sidebar closing, add
// mode — answers no.
//
// Not merged with add mode's pencil menu: the two differ in placement and in
// how keys reach them.

import { CONFIRM_CANCEL_LABEL, NOTHING_TO_DELETE_MESSAGE } from './copy';
import { reducedMotionQuery } from './dom';
import { ICON_IMPORT, ICON_TRASH } from './icons';
import {
  ACTION_ROW_PAD_X,
  CONFIRM_ACTIONS_GAP_PX,
  EASE_STD,
  MENU_BORDER_PX,
  MENU_PAD_PX,
  PANEL_BORDER_PX,
} from './sidebarMetrics';
import { getSidebarWidth } from './sidebarWidth';

const MENU_CONFIRM_TEXT_ID = 'menu-confirm-text';
/** The morph's duration: a size change in an element already on screen, a
 *  touch longer than the menu's 120ms entrance (motion spec: standard
 *  easing for anything that stays on screen). */
const MENU_MORPH_MS = 200;

/** How confirm() styles its confirming button. */
export type ConfirmTone = 'danger' | 'accent';

type MenuView = 'list' | 'confirm';

export interface ActionMenuDeps {
  /** "more options" (⋯), the button that opens the menu. */
  button: HTMLButtonElement;
  /** The export group the menu hangs from (it carries `is-menu-open`). */
  group: HTMLElement;
  /** The sidebar's (closed) shadow root and its host. */
  shadow: ShadowRoot;
  host: HTMLElement;
  /** Take the panel's tooltip down (a menu closing or turning into a
   *  question must not leave one up for what was there). */
  hideTooltip: () => void;
}

export class ActionMenu {
  /** The menu itself. */
  readonly el: HTMLDivElement;
  /** "import" — the menu's first item. */
  readonly importItem: HTMLButtonElement;
  /** "delete all for this website" (design spec §AE). */
  readonly deleteAllItem: HTMLButtonElement;
  /** The menu's two faces (design spec §AF): the item list, and the
   *  confirmation the menu turns into in place. */
  private readonly list: HTMLDivElement;
  private readonly confirmEl: HTMLDivElement;
  private readonly confirmText: HTMLParagraphElement;
  private readonly confirmActions: HTMLDivElement;
  private readonly confirmCancel: HTMLButtonElement;
  private readonly confirmOk: HTMLButtonElement;

  private open_ = false;
  private view: MenuView = 'list';
  private confirmResolve: ((answer: boolean) => void) | null = null;
  private morph: Animation | null = null;

  constructor(private readonly deps: ActionMenuDeps) {
    this.el = document.createElement('div');
    this.el.className = 'action-menu';
    this.el.setAttribute('role', 'menu');
    this.el.setAttribute('aria-label', 'more options');
    this.el.dataset.open = 'false';
    // What a delete-all reason sits beside.
    this.el.dataset.tipEdge = '';

    this.importItem = makeMenuItem(ICON_IMPORT, 'import', 'is-import');
    const divider = document.createElement('div');
    divider.className = 'action-menu-divider';
    divider.setAttribute('role', 'separator');
    this.deleteAllItem = makeMenuItem(ICON_TRASH, 'delete all for this website', 'is-danger is-delete-all');
    // Its reason sits beside the menu, to the left: the menu is against the
    // window's right edge (§AF).
    this.deleteAllItem.dataset.tipReason = NOTHING_TO_DELETE_MESSAGE;
    this.deleteAllItem.dataset.tipSide = 'left';
    this.list = document.createElement('div');
    this.list.className = 'action-menu-list';
    this.list.append(this.importItem, divider, this.deleteAllItem);

    // The confirmation the menu morphs into (design spec §AF). Hidden until a
    // question is asked; its text and confirming label are set per question.
    this.confirmEl = document.createElement('div');
    this.confirmEl.className = 'action-menu-confirm';
    this.confirmEl.hidden = true;
    this.confirmText = document.createElement('p');
    this.confirmText.className = 'action-menu-confirm-text';
    this.confirmText.id = MENU_CONFIRM_TEXT_ID;
    this.confirmActions = document.createElement('div');
    this.confirmActions.className = 'action-menu-confirm-actions';
    this.confirmCancel = document.createElement('button');
    this.confirmCancel.type = 'button';
    this.confirmCancel.className = 'confirm-btn is-cancel';
    this.confirmCancel.textContent = CONFIRM_CANCEL_LABEL;
    this.confirmOk = document.createElement('button');
    this.confirmOk.type = 'button';
    this.confirmOk.className = 'confirm-btn is-danger is-confirm';
    this.confirmActions.append(this.confirmCancel, this.confirmOk);
    this.confirmEl.append(this.confirmText, this.confirmActions);

    this.el.append(this.list, this.confirmEl);
  }

  /** The button's and the menu's own listeners: "more options" toggles (and
   *  opens from the keyboard), the menu's keys, and the question's two
   *  buttons. */
  wire(): void {
    const button = this.deps.button;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.open_) {
        this.close();
        return;
      }
      // A keyboard activation (Enter/Space) reports detail 0, a real pointer
      // click reports ≥1 — the spec only wants focus pulled into the menu for
      // the former ("open via keyboard focuses the first item").
      this.open({ focusFirstItem: e.detail === 0 });
    });
    button.addEventListener('keydown', (e) => {
      // Esc closes a menu opened by pointer, where focus is still on "more
      // options" rather than inside the menu (§C2's "Esc" applies either way).
      if (e.key === 'Escape' && this.open_) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
        return;
      }
      // ArrowDown/Up open the menu straight into its first item, the usual
      // menu-button convention.
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.stopPropagation();
      this.open({ focusFirstItem: true });
    });

    this.el.addEventListener('keydown', this.onKeyDown);

    this.confirmCancel.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close({ returnFocus: true });
    });
    this.confirmOk.addEventListener('click', (e) => {
      e.stopPropagation();
      this.settle(true);
      this.close({ returnFocus: true });
    });
  }

  /** "Outside pointerdown closes the menu" (§C2) needs two listeners,
   *  because this shadow root is *closed*: an event raised inside it
   *  retargets to the host by the time it reaches the document, and
   *  composedPath() is truncated for listeners outside the tree. So the
   *  shadow root itself sees everything inside the sidebar, and the document
   *  listener handles the host page (where every one of our events looks
   *  like the host). */
  listenForOutsidePresses(): void {
    this.deps.shadow.addEventListener('pointerdown', this.onShadowPointerDown, true);
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
  }

  /** Remove the page-level listeners (the panel's own go with its DOM). */
  destroy(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    this.deps.shadow.removeEventListener('pointerdown', this.onShadowPointerDown, true);
  }

  isOpen(): boolean {
    return this.open_;
  }

  open(options: { focusFirstItem?: boolean } = {}): void {
    const button = this.deps.button;
    if (this.open_ || button.disabled) return;
    this.open_ = true;
    // Always opens as the item list, whatever it closed as.
    this.showList();
    this.el.dataset.open = 'true';
    this.deps.group.classList.add('is-menu-open');
    button.setAttribute('aria-expanded', 'true');
    if (options.focusFirstItem) this.items()[0]?.focus();
  }

  /**
   * Close the menu. `returnFocus` hands focus back to "more options", which is
   * right for Esc (§C2) and wrong for an outside click — the user has already
   * aimed somewhere else, and stealing focus back would fight them.
   */
  close(options: { returnFocus?: boolean } = {}): void {
    if (!this.open_) return;
    this.open_ = false;
    // A question still open is answered no: closing is cancelling (§AF).
    this.settle(false);
    this.deps.hideTooltip();
    this.el.dataset.open = 'false';
    this.deps.group.classList.remove('is-menu-open');
    this.deps.button.setAttribute('aria-expanded', 'false');
    if (options.returnFocus) this.deps.button.focus();
  }

  /** Answer a question still open with no, without closing the menu. */
  cancelQuestion(): void {
    this.settle(false);
  }

  /**
   * Turn the open menu into a yes/no question (design spec §AF) and resolve
   * with the answer: true only for the confirming button. Resolves false at
   * once if the menu is not open (the user dismissed it while the question
   * was being prepared), and false when anything closes the menu. Focus goes
   * to "cancel", so a stray Enter is the safe answer.
   *
   * `tone` styles the confirming button: 'danger' (soft red) for a delete,
   * 'accent' (yellow text, like "add note"'s glyph) for everything else.
   */
  confirm(message: string, confirmLabel: string, tone: ConfirmTone = 'danger'): Promise<boolean> {
    if (!this.open_) return Promise.resolve(false);
    this.settle(false);
    this.deps.hideTooltip();

    return new Promise<boolean>((resolve) => {
      this.confirmResolve = resolve;
      const menu = this.el;
      const from = menu.getBoundingClientRect();

      this.confirmText.textContent = message;
      this.confirmOk.textContent = confirmLabel;
      this.confirmOk.classList.toggle('is-danger', tone === 'danger');
      this.confirmOk.classList.toggle('is-accent', tone === 'accent');
      const width = confirmWidthPx();
      this.view = 'confirm';
      menu.classList.add('is-confirm');
      menu.setAttribute('role', 'alertdialog');
      // Named by the question itself (an alertdialog needs a name), and
      // described by it too, as before.
      menu.removeAttribute('aria-label');
      menu.setAttribute('aria-labelledby', MENU_CONFIRM_TEXT_ID);
      menu.setAttribute('aria-describedby', MENU_CONFIRM_TEXT_ID);
      this.list.hidden = true;
      this.confirmEl.hidden = false;
      menu.style.width = `${width}px`;
      this.confirmEl.style.width = `${Math.max(0, width - (MENU_BORDER_PX + MENU_PAD_PX) * 2)}px`;
      this.layoutConfirmActions();
      const to = menu.getBoundingClientRect();

      const reduced = reducedMotionQuery()?.matches ?? false;
      if (!reduced && typeof menu.animate === 'function' && from.width > 0 && to.width > 0) {
        this.morph?.cancel();
        this.morph = menu.animate(
          [
            { width: `${from.width}px`, height: `${from.height}px` },
            { width: `${to.width}px`, height: `${to.height}px` },
          ],
          { duration: MENU_MORPH_MS, easing: EASE_STD },
        );
        const morph = this.morph;
        morph.onfinish = () => {
          if (this.morph === morph) this.morph = null;
        };
      }
      this.confirmCancel.focus();
    });
  }

  private settle(answer: boolean): void {
    const resolve = this.confirmResolve;
    this.confirmResolve = null;
    resolve?.(answer);
  }

  /** Back to the item list (on every open), with the box's own sizing. */
  private showList(): void {
    this.morph?.cancel();
    this.morph = null;
    this.view = 'list';
    const menu = this.el;
    menu.classList.remove('is-confirm');
    menu.style.width = '';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'more options');
    menu.removeAttribute('aria-labelledby');
    menu.removeAttribute('aria-describedby');
    this.list.hidden = false;
    this.confirmEl.hidden = true;
  }

  /** Side by side when both buttons fit on one line at their natural
   *  (unwrapped) widths; otherwise stacked full width, cancel at the bottom.
   *  Measured per question, since the confirming label differs. */
  private layoutConfirmActions(): void {
    const actions = this.confirmActions;
    actions.classList.remove('is-stacked');
    const needed = this.confirmCancel.offsetWidth + CONFIRM_ACTIONS_GAP_PX + this.confirmOk.offsetWidth;
    actions.classList.toggle('is-stacked', needed > actions.clientWidth);
  }

  private items(): HTMLButtonElement[] {
    return Array.from(this.el.querySelectorAll<HTMLButtonElement>('.action-menu-item:not([disabled])'));
  }

  /** Up/Down move between items (wrapping), Esc closes and returns focus to
   *  the button, Tab closes and lets focus move on normally (§C2). As a
   *  confirmation (§AF), Esc cancels and Tab moves between its two buttons
   *  rather than dismissing the question. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close({ returnFocus: true });
      return;
    }
    if (this.view === 'confirm') {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const onCancel = this.deps.shadow.activeElement === this.confirmCancel;
      (onCancel ? this.confirmOk : this.confirmCancel).focus();
      return;
    }
    if (e.key === 'Tab') {
      this.close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = this.items();
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    // ShadowRoot.activeElement, not document.activeElement — the latter only
    // ever reports the host for anything focused inside a closed root.
    const current = items.indexOf(this.deps.shadow.activeElement as HTMLButtonElement);
    const from = current >= 0 ? current : 0;
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    items[(from + delta + items.length) % items.length].focus();
  };

  /** Pointerdown anywhere inside the sidebar's shadow tree: close unless it
   *  landed on the menu itself or on "more options" (whose own click handler
   *  toggles). */
  private readonly onShadowPointerDown = (e: Event): void => {
    if (!this.open_) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(this.el) || path.includes(this.deps.button)) return;
    this.close();
  };

  /** Pointerdown on the host page (or in another extension surface). Anything
   *  raised inside our closed root arrives here retargeted to the host, and is
   *  already handled by onShadowPointerDown. */
  private readonly onDocumentPointerDown = (e: Event): void => {
    if (!this.open_) return;
    if (e.target === this.deps.host) return;
    this.close();
  };
}

/** The panel's content width: the box a confirmation fills. */
function confirmWidthPx(): number {
  return Math.max(0, getSidebarWidth() - PANEL_BORDER_PX - ACTION_ROW_PAD_X * 2);
}

/** One row of the "more options" menu (§C2, §AE): a 16px leading icon plus a
 *  visible, lowercase label. `role="menuitem"` and the roving Tab/arrow
 *  behaviour are wired in ActionMenu.wire(). `extraClass` names the item
 *  (and marks the destructive one). */
function makeMenuItem(svgMarkup: string, label: string, extraClass = ''): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `action-menu-item ${extraClass}` : 'action-menu-item';
  btn.setAttribute('role', 'menuitem');
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.innerHTML = svgMarkup;
  const text = document.createElement('span');
  text.className = 'menu-item-label';
  text.textContent = label;
  btn.appendChild(icon);
  btn.appendChild(text);
  return btn;
}
