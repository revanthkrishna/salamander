// src/rpc.ts
// The content script's one way of talking to the service worker: a typed
// `send()` over chrome.runtime.sendMessage whose return type follows from
// the request (src/messages.ts's MessageMap), so a caller cannot send a
// GetImageMessage and read the reply as an ExportResponse.
//
// Contract every caller relies on — never rejects. A dead service worker,
// an invalidated extension context (the extension was reloaded while the
// page stayed open) or a torn-down port all surface as `undefined`, which
// every caller already treats as a failure. This is exactly the behaviour
// of the two private helpers it replaces (content.ts's and capture.ts's).
//
// An invalidated context is also reported, once per failed call, to the
// hook content.ts registers (onContextInvalidated): this script is then an
// orphan of an extension that was reloaded or updated, and shuts itself
// down. The hook runs a microtask before the caller hears `undefined`, so
// the caller's own failure path finds everything already gone and shows
// nothing.
//
// Content-script only: the service worker has no reason to import this
// (it answers, it does not ask). Long-running, progress-reporting calls —
// if they ever arrive — belong on a chrome.runtime.connect port variant
// beside this, not in a widened `send`.

import type { ContentToBackgroundMessage, ResponseFor } from './messages';

let contextInvalidated: (() => void) | null = null;

/** Register (or, with null, clear) what to do when a call finds the
 *  extension context invalidated. */
export function onContextInvalidated(hook: (() => void) | null): void {
  contextInvalidated = hook;
}

/** Whether a failed call failed because this script's extension context is
 *  gone: Chrome says so in the error, and an orphaned script's
 *  chrome.runtime has no id any more. */
function isContextInvalidatedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/extension context invalidated/i.test(message)) return true;
  try {
    return !chrome.runtime?.id;
  } catch {
    return true;
  }
}

function reportIfInvalidated(err: unknown): void {
  if (!contextInvalidated || !isContextInvalidatedError(err)) return;
  const hook = contextInvalidated;
  queueMicrotask(hook);
}

export function send<M extends ContentToBackgroundMessage>(message: M): Promise<ResponseFor<M> | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: ResponseFor<M> | undefined) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reportIfInvalidated(lastError.message);
          resolve(undefined);
          return;
        }
        resolve(response);
      });
    } catch (err) {
      // Extension context invalidated (e.g. reloaded while the page stayed open).
      reportIfInvalidated(err);
      resolve(undefined);
    }
  });
}
