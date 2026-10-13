// src/notifications.ts
// The sidebar's notification banner (design spec §3.1): an error or a
// warning, with a countdown bar, that clears itself after 8s. All copy
// passed in must already be lowercase (§3.4); it is rendered verbatim so the
// §5 error-table strings stay byte-exact. Moved out of sidebar.ts unchanged:
// the banner builds its own elements, which the sidebar places in the panel.

import { ICON_ERROR, ICON_WARNING } from './icons';

const NOTIF_DURATION_MS = 8000;

export class Notifications {
  /** The banner — a live region, so a screen reader announces errors and
   *  warnings that appear without the user having focused anything. */
  readonly el: HTMLDivElement;
  private readonly icon: HTMLSpanElement;
  private readonly text: HTMLSpanElement;
  private readonly countdownBar: HTMLDivElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'notif';
    this.el.setAttribute('role', 'alert');
    this.el.hidden = true;

    this.countdownBar = document.createElement('div');
    this.countdownBar.className = 'notif-progress';
    this.countdownBar.hidden = true;

    const row = document.createElement('div');
    row.className = 'notif-row';
    this.icon = document.createElement('span');
    this.icon.className = 'icon';
    this.icon.innerHTML = ICON_ERROR;
    this.text = document.createElement('span');
    this.text.className = 'notif-text';
    row.appendChild(this.icon);
    row.appendChild(this.text);

    this.el.appendChild(row);
    this.el.appendChild(this.countdownBar);
  }

  /** Show the error bar. Auto-clears after 8s. */
  showError(message: string): void {
    this.show('error', message, ICON_ERROR);
  }

  /** Show the warning bar. Auto-clears after 8s. */
  showWarning(message: string): void {
    this.show('warning', message, ICON_WARNING);
  }

  /** Hide whatever notification is showing and cancel its auto-clear timer. */
  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.el.hidden = true;
    this.el.classList.remove('warning');
    this.text.textContent = '';
    this.stopCountdown();
  }

  private show(kind: 'error' | 'warning', message: string, icon: string): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.el.classList.toggle('warning', kind === 'warning');
    this.icon.innerHTML = icon;
    this.text.textContent = message;
    this.el.hidden = false;
    this.startCountdown();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.clear();
    }, NOTIF_DURATION_MS);
  }

  /** Animate the countdown bar from full width to zero over the notification
   *  duration, as a visual timer. Colour comes from the .warning modifier on
   *  the parent, so nothing to set here. */
  private startCountdown(): void {
    const bar = this.countdownBar;
    bar.hidden = false;
    // Snap to full width with no transition...
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    // ...then force a reflow so the reset actually takes effect before the
    // next transition is applied. Without this the browser collapses both
    // style changes into one frame and the animation never runs.
    void bar.offsetWidth;
    bar.style.transition = `transform ${NOTIF_DURATION_MS}ms linear`;
    bar.style.transform = 'scaleX(0)';
  }

  private stopCountdown(): void {
    const bar = this.countdownBar;
    bar.hidden = true;
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
  }
}
