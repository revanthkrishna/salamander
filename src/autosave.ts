// src/autosave.ts
// Draft / saved / in-flight / failed / sequence tracking for a per-item value
// that autosaves on a debounce, lifted out of the enlarged view so the same
// machinery can carry a second per-item field (an annotations document, say)
// as a second instance rather than a second copy.
//
// What lives here is the bookkeeping the view used to do across six maps:
//   - a draft per id, and the last value known to be stored;
//   - "dirty" = a savable draft that differs from BOTH the stored value and
//     the value of a save still in flight — so blur-then-navigate does not
//     send the same value twice;
//   - one pending debounce timer (at most one id is pending at a time — a
//     new draft for any id replaces it, exactly as the view's single
//     saveTimer did);
//   - a sequence number per id so a reply to a superseded save is ignored;
//   - the set of ids whose latest save failed, which flush() retries.
//
// What stays with the caller, by design: what counts as savable (the note's
// "never save an empty note" is passed in as `savable`), what to do when a
// save settles (status text, banners, marking the list dirty), and every
// decision about WHEN to schedule/flush — the controller never fires a save
// the caller did not ask for.

export interface AutosaveOptions<T> {
  /** Quiet period after the last setDraft()/schedule() before a save. */
  debounceMs: number;
  /** Value equality for the dirty test. */
  equals: (a: T, b: T) => boolean;
  /** Whether a draft may be persisted at all. An unsavable draft is kept as
   *  the draft (so the editor keeps showing it) but is never dirty and is
   *  never sent. */
  savable: (value: T) => boolean;
  /** Persist `value` for `id`; resolves false (or rejects) on failure. */
  save: (id: number, value: T) => Promise<boolean>;
  /** Fired the moment a save is dispatched. */
  onSaveStarted?: (id: number, value: T) => void;
  /** Fired when the LATEST save for `id` settles; a superseded save's reply
   *  is dropped without a callback. The controller's own state (stored
   *  value, failed set, in-flight) is already updated when this runs. */
  onSettled: (id: number, value: T, ok: boolean) => void;
}

export class AutosaveController<T> {
  private drafts = new Map<number, T>();
  private stored = new Map<number, T>();
  private seq = new Map<number, number>();
  /** Value of each id's latest save still awaiting a reply. */
  private inflight = new Map<number, T>();
  /** Ids whose latest save failed. They stay dirty and are retried by the
   *  next flush(). */
  private failed = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingId: number | null = null;

  constructor(private readonly opts: AutosaveOptions<T>) {}

  /** Register an id with its stored value (draft == stored, not dirty). */
  seed(id: number, value: T): void {
    this.drafts.set(id, value);
    this.stored.set(id, value);
  }

  /** Drop every trace of `id` (the item was deleted). A pending timer for
   *  it is cancelled; a reply to a save already in flight is ignored. */
  forget(id: number): void {
    this.cancelPending(id);
    this.drafts.delete(id);
    this.stored.delete(id);
    this.seq.delete(id);
    this.inflight.delete(id);
    this.failed.delete(id);
  }

  draft(id: number): T | undefined {
    return this.drafts.get(id);
  }

  /** Record the editor's current value. Does not schedule anything. */
  setDraft(id: number, value: T): void {
    this.drafts.set(id, value);
  }

  /** (Re)start the debounce for `id`, replacing any pending timer. */
  schedule(id: number): void {
    this.cancelPending();
    this.pendingId = id;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pendingId = null;
      this.saveNow(id);
    }, this.opts.debounceMs);
  }

  /** Cancel the pending debounce — any pending one, or only `id`'s. */
  cancelPending(id?: number): void {
    if (this.timer === null) return;
    if (id !== undefined && this.pendingId !== id) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.pendingId = null;
  }

  /** True while a debounce is pending (for `id`, if given). */
  isPending(id?: number): boolean {
    return this.timer !== null && (id === undefined || this.pendingId === id);
  }

  isDirty(id: number): boolean {
    const d = this.drafts.get(id);
    if (d === undefined || !this.opts.savable(d)) return false;
    const s = this.stored.get(id);
    if (s !== undefined && this.opts.equals(d, s)) return false;
    const f = this.inflight.get(id);
    return f === undefined || !this.opts.equals(d, f);
  }

  /** A failed save with no retry in flight. */
  unresolvedFailure(id: number): boolean {
    return this.failed.has(id) && !this.inflight.has(id);
  }

  hasUnresolvedFailure(): boolean {
    return this.firstUnresolvedFailure() !== undefined;
  }

  /** The first id (in failure order) whose save failed and is not being retried. */
  firstUnresolvedFailure(): number | undefined {
    for (const id of this.failed) if (this.unresolvedFailure(id)) return id;
    return undefined;
  }

  /** Immediate save of `shownId`'s pending change (if dirty), plus a retry
   *  of every other id whose last save failed. Cancels the debounce. */
  flush(shownId: number | null): void {
    this.cancelPending();
    if (shownId !== null && this.isDirty(shownId)) this.saveNow(shownId);
    for (const f of [...this.failed]) {
      if (f !== shownId && this.isDirty(f)) this.saveNow(f);
    }
  }

  /** Dispatch a save of `id`'s draft now, if it is savable. Does not check
   *  dirtiness — callers decide. */
  saveNow(id: number): void {
    const value = this.drafts.get(id);
    if (value === undefined || !this.opts.savable(value)) return;
    const seq = (this.seq.get(id) ?? 0) + 1;
    this.seq.set(id, seq);
    this.inflight.set(id, value);
    this.opts.onSaveStarted?.(id, value);
    // Dispatched synchronously (the request must leave before a page
    // unload, which is the one caller that cannot wait a microtask); only
    // the reply is asynchronous.
    let request: Promise<boolean>;
    try {
      request = this.opts.save(id, value);
    } catch {
      request = Promise.resolve(false);
    }
    void request
      .catch(() => false)
      .then((ok) => {
        if (this.seq.get(id) !== seq) return; // superseded by a newer save
        this.inflight.delete(id);
        if (ok) {
          this.stored.set(id, value);
          this.failed.delete(id);
        } else {
          this.failed.add(id);
        }
        this.opts.onSettled(id, value, ok);
      });
  }

  /** Cancel the debounce. Replies to saves in flight still settle. */
  dispose(): void {
    this.cancelPending();
  }
}
