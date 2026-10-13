// src/addModeControl.ts
// The "add note" control's state machine (design spec v3 §A2), moved out of
// content.ts unchanged: off / on / kept-on, the double-click window, the
// "keep add mode on" switch, Esc and the Option/Alt+N shortcut, and what a
// capture's outcome does to add mode. It is the only thing that moves the
// control between its painted states, so the paint
// (sidebar.setAddButtonState) can never drift from addMode.isAddModeActive().
// Every one of add mode's exit paths (capture success/failure, cancel, Esc,
// sidebar close, SPA navigation, opening the enlarged view) funnels through
// exitFully() or the cancel callback here rather than calling
// addMode.exitAddMode() directly, so "sync in every path" only has to be
// true in one place.
//
// Everything it touches comes in through `deps` (add mode, the sidebar, the
// capture pipeline, a clock), so it is unit-testable on fakes; content.ts
// wires the real modules.

import type * as AddModeModule from './addMode';
import type * as SidebarModule from './sidebar';
import type { CaptureOutcome, OverlayControls } from './capture';
import type { PenColor } from './drawing';
import { isAddNoteShortcut } from './shortcut';
import type { KeyVerdict } from './keyRouter';

export interface AddModeControlDeps {
  addMode: Pick<
    typeof AddModeModule,
    'startAddMode' | 'exitAddMode' | 'isAddModeActive' | 'dismissDrawingMenu' | 'hideOverlayUI' | 'showOverlayUI'
  >;
  sidebar: Pick<
    typeof SidebarModule,
    | 'collapseEnlargedView'
    | 'setAddModeHold'
    | 'setAddButtonState'
    | 'isSidebarOnPage'
    | 'isEnlargedViewOpen'
    | 'showError'
    | 'hideTooltipNow'
  >;
  /** The capture pipeline (src/capture.ts). */
  captureAndSave: (result: AddModeModule.AddModeResult, overlay: OverlayControls) => Promise<CaptureOutcome>;
  /** True while the user is typing in the page (src/shortcut.ts). */
  isTypingTarget: () => boolean;
  /** The pencil's session colour (content.ts): asked for on every entry,
   *  remembered on every pick. */
  penColor: { restore: () => void; remember: (color: PenColor) => void };
  /** A note was saved: re-read the list so it shows up. */
  onSaved: () => void;
  /** Milliseconds, for the double-click pairing (Date.now in production). */
  now: () => number;
}

export interface AddModeControl {
  /** Enter add mode (fresh placement) and paint the control for the switch. */
  enter: () => void;
  /** Full stop: exit add mode, switch off, hold lifted, control painted off. */
  exitFully: () => void;
  /** The "add note" button's click (sidebar.SidebarCallbacks.onAdd). */
  onButtonClick: () => void;
  /** The native dblclick, shift+click and shift+Enter/Space on it. */
  onButtonDoubleClick: () => void;
  /** The switch flicked (sidebar.SidebarCallbacks.onAddSwitchChange). */
  setSwitch: (on: boolean) => void;
  /** Esc and Option/Alt+N, heard through the key router; 'stop' when the
   *  shortcut acted, so the page never sees the key. */
  onGlobalKeyDown: (e: KeyboardEvent) => KeyVerdict;
}

/**
 * A click while add mode is already on (switch off) that follows another click
 * on the button within this window might be the *second* click of a
 * double-click that the native 'dblclick' event (fired right after) will
 * turn into "switch on" instead. Only then is the toggle-off deferred by this
 * much, so the dblclick has a chance to pre-empt it — comfortably longer
 * than any OS's double-click timing. A deliberate, lone "off" click acts
 * immediately, and the first click of any pair (off -> on) is never delayed
 * — see onButtonClick.
 */
export const ADD_DBLCLICK_WINDOW_MS = 400;

export function createAddModeControl(deps: AddModeControlDeps): AddModeControl {
  const { addMode, sidebar } = deps;

  /** True while the "keep add mode on" switch is on: add mode survives each
   *  successful capture and each per-note cancel, until a click on the button,
   *  a flick of the switch, or Esc ends it (§A2). Deliberately not persisted —
   *  it resets to off per page session, like the v2 lock it replaces. */
  let addKeptOn = false;

  /** When the button was last clicked (deps.now()), for the pairing above. */
  let lastAddClickAt = -Infinity;

  /** Pending "toggle off" from a single click while on (switch off); cleared
   *  if a dblclick or another exit path pre-empts it. */
  let pendingAddOffTimer: ReturnType<typeof setTimeout> | null = null;

  /** Bumped by every entry into add mode: a capture that resolves after a
   *  new session has started (the button clicked off and on, or Esc then
   *  Option/Alt+N, while it was in flight) leaves that session alone. */
  let session = 0;

  function clearPendingAddOff(): void {
    if (pendingAddOffTimer !== null) {
      clearTimeout(pendingAddOffTimer);
      pendingAddOffTimer = null;
    }
  }

  /** Enter add mode (fresh placement) and paint the control for whatever
   *  addKeptOn currently is — the single entry point for every "start/restart
   *  add mode" path: the first click off -> on, flicking the switch on from
   *  off, and re-entry while the switch is on after a successful capture or a
   *  per-note cancel. */
  function enter(): void {
    session++;
    // The enlarged view and add mode can never coexist (design spec v2 §D) —
    // nothing of it may be on screen for add mode's capture. Cancel-then-run
    // (MOTION_SPEC §13): kill it instantly to its resting closed state, no
    // half-collapse frame. A no-op when it isn't open.
    sidebar.collapseEnlargedView({ immediate: true, force: true });
    // The sidebar goes "on hold" for the whole of add mode (design spec v3
    // §H): the note list stops taking input and dims, export and "more
    // options" are disabled and the menu closed, and dock magnification is
    // switched off — swollen note items grow out over the page, which is
    // exactly what add mode selects and screenshots, and suspending snaps them
    // back to rest instantly (no release animation still in flight at capture
    // time). Lifted by finish() on every exit path.
    sidebar.setAddModeHold(true);
    addMode.startAddMode({
      onOk: (result) => {
        // The capture pipeline (src/capture.ts) owns everything between
        // "ok" and a stored item; this side only decides what happens to add
        // mode/the sidebar afterwards (handleCaptureOk below).
        void handleCaptureOk(result);
      },
      onCancel: handleAddModeCancel,
      onPenColorChange: deps.penColor.remember,
    });
    deps.penColor.restore();
    sidebar.setAddButtonState(addKeptOn ? 'kept-on' : 'on');
  }

  /** Common tail of every full exit: turn the switch off, take the sidebar off
   *  hold (§H — list interactive again, dimming gone, export group re-enabled)
   *  and paint the control off. Does NOT touch add mode itself — callers that
   *  still need to call addMode.exitAddMode() do so first (see exitFully). */
  function finish(): void {
    addKeptOn = false;
    sidebar.setAddModeHold(false);
    sidebar.setAddButtonState('off');
  }

  /** Full stop: exits add mode (a no-op if it's already idle) and resets the
   *  switch, the control's paint and the sidebar's §H hold. Every exit path
   *  that isn't "cancel a note while the switch is on, stay in add mode" goes
   *  through this — capture failure never does (add mode stays exactly as the
   *  user left it), but Esc, a click while the switch is on, sidebar close,
   *  SPA navigation and opening a note's enlarged view all do (§A2, and
   *  "sidebar state must stay in sync … in every path"). */
  function exitFully(): void {
    clearPendingAddOff();
    addMode.exitAddMode();
    finish();
  }

  /** addMode.ts's onCancel — fired once add mode has already torn itself down
   *  for this note (exitAddMode() already ran). While the switch is on this
   *  only cancels the one note; the switch (and add mode) persists, so
   *  re-enter immediately rather than falling all the way to "off" (§A2). */
  function handleAddModeCancel(): void {
    clearPendingAddOff();
    if (addKeptOn) {
      enter();
      return;
    }
    finish();
  }

  /**
   * §1.2 step 4: "add mode exits; sidebar restores; a new thumbnail appears at
   * the bottom of the sidebar list" — except while the switch is on (§A2),
   * where the user is put straight back into add mode (a fresh placement)
   * instead of exiting, so several notes can be added without re-clicking the
   * button.
   *
   * On failure the opposite: add mode stays exactly as the user left it (the
   * capture pipeline has already restored the hidden overlay and re-enabled
   * cancel/ok), no item exists anywhere (§1.3, §5 #8), and the reason is shown
   * in the sidebar's error bar — lowercase, verbatim from §5. The switch and
   * the control's paint are untouched either way, since add mode itself
   * hasn't exited.
   *
   * A success that lands after a new session has started (`session` moved
   * on) only refreshes the list: the new session is the user's, and is left
   * exactly as it is.
   */
  async function handleCaptureOk(result: AddModeModule.AddModeResult): Promise<void> {
    const started = session;
    const outcome = await deps.captureAndSave(result, {
      hide: () => {
        sidebar.hideTooltipNow();
        addMode.hideOverlayUI();
      },
      show: addMode.showOverlayUI,
    });

    if (!outcome.ok) {
      sidebar.showError(outcome.message);
      return;
    }

    if (started === session) {
      addMode.exitAddMode();
      if (addKeptOn) {
        enter();
      } else {
        finish();
      }
    }
    // Re-read the list for the current URL so the new item shows up.
    deps.onSaved();
  }

  /** The "add note" button's click handler (sidebar.SidebarCallbacks.onAdd). */
  function onButtonClick(): void {
    const now = deps.now();
    const pairedClick = now - lastAddClickAt < ADD_DBLCLICK_WINDOW_MS;
    lastAddClickAt = now;
    if (!addMode.isAddModeActive()) {
      // Off -> on: act immediately, never delayed (the double-click ambiguity
      // below only ever applies to the *second* click of a pair).
      enter();
      return;
    }
    if (addKeptOn) {
      // A single click while the switch is on exits add mode AND turns the
      // switch off (§A2) — one click to stop everything. No dblclick
      // disambiguation needed: there is no intermediate state to fall back to.
      exitFully();
      return;
    }
    // On, switch off, and not right after another click: a lone "turn it off".
    if (!pairedClick) {
      exitFully();
      return;
    }
    // Right after another click: possibly the second click of a double-click
    // the browser is about to report — defer the toggle-off just long enough
    // for that native 'dblclick' (handled below) to pre-empt it and turn the
    // switch on instead.
    if (pendingAddOffTimer !== null) return;
    pendingAddOffTimer = setTimeout(() => {
      pendingAddOffTimer = null;
      exitFully();
    }, ADD_DBLCLICK_WINDOW_MS);
  }

  /** sidebar.SidebarCallbacks.onAddDoubleClick — the v2 gestures, which now
   *  simply drive the switch (§A2's "Behaviour"): the native browser
   *  'dblclick' that follows the click pair onButtonClick already saw, or a
   *  shift+click / shift+Enter / shift+Space. Converts the pending toggle-off
   *  (if any) into "switch on" instead; from off it enters add mode with the
   *  switch already on. They are alternates now, not the only path — the
   *  visible switch is. */
  function onButtonDoubleClick(): void {
    setSwitch(true);
  }

  /** sidebar.SidebarCallbacks.onAddSwitchChange — the user flicked the "keep
   *  add mode on" switch (§A2):
   *    - on while add mode is off starts add mode immediately ("start, and
   *      keep going")
   *    - on while it is already active just keeps it on past the next capture
   *    - off leaves add mode running for the current note only
   *  The switch never moves on its own: the sidebar reports the requested
   *  value and this repaints whatever actually happened. */
  function setSwitch(on: boolean): void {
    clearPendingAddOff();
    if (on === addKeptOn && addMode.isAddModeActive()) return;
    addKeptOn = on;
    if (on && !addMode.isAddModeActive()) {
      enter();
      return;
    }
    if (!addMode.isAddModeActive()) {
      // Switching off with add mode already gone: nothing to keep on.
      finish();
      return;
    }
    sidebar.setAddButtonState(on ? 'kept-on' : 'on');
  }

  /** Esc always exits add mode and turns the switch off (§A2), regardless of
   *  what state add mode is in ('placing' or 'editing'). Registered once, by
   *  content.ts's ensureStarted(), with the key router at
   *  GLOBAL_ESC_AND_SHORTCUT — before every isolation (keyRouter.ts), so it
   *  sees the keydown even though add mode's isolation stops the event from
   *  ever reaching a page/document-level listener. */
  function onGlobalKeyDown(e: KeyboardEvent): KeyVerdict {
    if (isAddNoteShortcut(e)) return onAddNoteShortcut(e);
    if (e.key !== 'Escape') return 'pass';
    // Esc during IME composition cancels the composition, not add mode.
    if (e.isComposing || e.keyCode === 229) return 'pass';
    if (!addMode.isAddModeActive()) return 'pass';
    // An open pencil menu takes this Esc for itself (design spec §AB, §C2):
    // it closes and focus returns to the pencil; the next Esc exits.
    if (addMode.dismissDrawingMenu()) return 'pass';
    exitFully();
    return 'pass';
  }

  /** Option+N / Alt+N (src/shortcut.ts): one note, like a single click on
   *  add. Only while the sidebar is open, and nothing happens while a note is
   *  being placed, while the enlarged view is open or while the user is
   *  typing. When it does act, the page never sees the key (a page access key
   *  "n" or a web app's own Alt+N stays quiet while the sidebar is open):
   *  'stop'. */
  function onAddNoteShortcut(e: KeyboardEvent): KeyVerdict {
    if (!sidebar.isSidebarOnPage()) return 'pass';
    if (addMode.isAddModeActive() || sidebar.isEnlargedViewOpen()) return 'pass';
    if (deps.isTypingTarget()) return 'pass';
    e.preventDefault();
    clearPendingAddOff();
    addKeptOn = false;
    enter();
    return 'stop';
  }

  return { enter, exitFully, onButtonClick, onButtonDoubleClick, setSwitch, onGlobalKeyDown };
}
