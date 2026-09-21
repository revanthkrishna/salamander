// src/autosave.ts — the draft/stored/in-flight/failed bookkeeping the
// enlarged view's note editor runs on. enlargedView.test.ts covers the same
// behaviour end to end through the DOM; this pins the controller alone so a
// second instance (a future per-item document) has a spec of its own.

import { AutosaveController } from '../autosave';

function make(overrides: Partial<ConstructorParameters<typeof AutosaveController<string>>[0]> = {}) {
  const pending: Array<(ok: boolean) => void> = [];
  const save = jest.fn((_id: number, _value: string) => new Promise<boolean>((resolve) => pending.push(resolve)));
  const onSettled = jest.fn();
  const onSaveStarted = jest.fn();
  const ctl = new AutosaveController<string>({
    debounceMs: 700,
    equals: (a, b) => a === b,
    savable: (v) => v.trim() !== '',
    save,
    onSaveStarted,
    onSettled,
    ...overrides,
  });
  return { ctl, save, onSettled, onSaveStarted, pending };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('AutosaveController', () => {
  test('a seeded value is not dirty; an edit is; the debounce sends it once', async () => {
    const { ctl, save, onSaveStarted } = make();
    ctl.seed(1, 'stored');
    expect(ctl.isDirty(1)).toBe(false);

    ctl.setDraft(1, 'edited');
    expect(ctl.isDirty(1)).toBe(true);
    ctl.schedule(1);
    expect(ctl.isPending(1)).toBe(true);
    jest.advanceTimersByTime(699);
    expect(save).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1, 'edited');
    expect(onSaveStarted).toHaveBeenCalledWith(1, 'edited');
    expect(ctl.isPending()).toBe(false);
  });

  test('re-scheduling restarts the debounce; scheduling another id replaces the pending one', () => {
    const { ctl, save } = make();
    ctl.seed(1, 'a');
    ctl.seed(2, 'b');
    ctl.setDraft(1, 'a1');
    ctl.schedule(1);
    jest.advanceTimersByTime(500);
    ctl.schedule(1);
    jest.advanceTimersByTime(500);
    expect(save).not.toHaveBeenCalled();

    ctl.setDraft(2, 'b1');
    ctl.schedule(2);
    expect(ctl.isPending(1)).toBe(false);
    expect(ctl.isPending(2)).toBe(true);
    jest.advanceTimersByTime(700);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(2, 'b1');
  });

  test('an unsavable draft is kept but never dirty and never sent', () => {
    const { ctl, save } = make();
    ctl.seed(1, 'stored');
    ctl.setDraft(1, '   ');
    expect(ctl.draft(1)).toBe('   ');
    expect(ctl.isDirty(1)).toBe(false);
    ctl.schedule(1);
    jest.advanceTimersByTime(700);
    expect(save).not.toHaveBeenCalled();
    ctl.saveNow(1);
    expect(save).not.toHaveBeenCalled();
  });

  test('a value in flight counts as clean, so blur-then-navigate does not send it twice', async () => {
    const { ctl, save, pending, onSettled } = make();
    ctl.seed(1, 'stored');
    ctl.setDraft(1, 'edited');
    ctl.saveNow(1);
    await flush();
    expect(ctl.isDirty(1)).toBe(false);
    ctl.flush(1);
    expect(save).toHaveBeenCalledTimes(1);

    pending[0](true);
    await flush();
    expect(onSettled).toHaveBeenCalledWith(1, 'edited', true);
    expect(ctl.isDirty(1)).toBe(false);
    expect(ctl.unresolvedFailure(1)).toBe(false);
  });

  test('a reply to a superseded save is dropped; only the latest settles', async () => {
    const { ctl, pending, onSettled } = make();
    ctl.seed(1, 'stored');
    ctl.setDraft(1, 'one');
    ctl.saveNow(1);
    await flush();
    ctl.setDraft(1, 'two');
    ctl.saveNow(1);
    await flush();
    expect(pending).toHaveLength(2);

    pending[0](true); // the stale reply
    await flush();
    expect(onSettled).not.toHaveBeenCalled();
    // The value the stale reply carried is not what is stored: still dirty.
    expect(ctl.isDirty(1)).toBe(false); // 'two' is in flight
    pending[1](true);
    await flush();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(1, 'two', true);
  });

  test('a failed save stays dirty, is an unresolved failure, and flush() retries it', async () => {
    const { ctl, save, pending, onSettled } = make();
    ctl.seed(1, 'stored');
    ctl.seed(2, 'other');
    ctl.setDraft(1, 'edited');
    ctl.saveNow(1);
    await flush();
    pending[0](false);
    await flush();
    expect(onSettled).toHaveBeenCalledWith(1, 'edited', false);
    expect(ctl.isDirty(1)).toBe(true);
    expect(ctl.unresolvedFailure(1)).toBe(true);
    expect(ctl.hasUnresolvedFailure()).toBe(true);
    expect(ctl.firstUnresolvedFailure()).toBe(1);

    // Flushing while another note is shown retries the failed one.
    ctl.flush(2);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(1, 'edited');
    // While the retry is in flight the failure is no longer "unresolved".
    expect(ctl.unresolvedFailure(1)).toBe(false);
    pending[1](true);
    await flush();
    expect(ctl.hasUnresolvedFailure()).toBe(false);
    expect(ctl.isDirty(1)).toBe(false);
  });

  test('a rejected save is treated as a failure, never a throw', async () => {
    const { ctl, onSettled } = make({ save: jest.fn().mockRejectedValue(new Error('boom')) });
    ctl.seed(1, 'stored');
    ctl.setDraft(1, 'edited');
    ctl.saveNow(1);
    await flush();
    expect(onSettled).toHaveBeenCalledWith(1, 'edited', false);
    expect(ctl.unresolvedFailure(1)).toBe(true);
  });

  test('cancelPending(id) only cancels a debounce pending for that id', () => {
    const { ctl, save } = make();
    ctl.seed(1, 'a');
    ctl.setDraft(1, 'a1');
    ctl.schedule(1);
    ctl.cancelPending(2);
    expect(ctl.isPending(1)).toBe(true);
    ctl.cancelPending(1);
    expect(ctl.isPending()).toBe(false);
    jest.advanceTimersByTime(700);
    expect(save).not.toHaveBeenCalled();
  });

  test('forget(id) drops its state, cancels its debounce and ignores its in-flight reply', async () => {
    const { ctl, save, pending, onSettled } = make();
    ctl.seed(1, 'a');
    ctl.setDraft(1, 'a1');
    ctl.saveNow(1);
    await flush();
    ctl.setDraft(1, 'a2');
    ctl.schedule(1);

    ctl.forget(1);

    expect(ctl.draft(1)).toBeUndefined();
    expect(ctl.isDirty(1)).toBe(false);
    jest.advanceTimersByTime(700);
    expect(save).toHaveBeenCalledTimes(1);
    pending[0](false);
    await flush();
    expect(onSettled).not.toHaveBeenCalled();
    expect(ctl.hasUnresolvedFailure()).toBe(false);
  });
});
