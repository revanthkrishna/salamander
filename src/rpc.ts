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
// Content-script only: the service worker has no reason to import this
// (it answers, it does not ask). Long-running, progress-reporting calls —
// if they ever arrive — belong on a chrome.runtime.connect port variant
// beside this, not in a widened `send`.

import type { ContentToBackgroundMessage, ResponseFor } from './messages';

export function send<M extends ContentToBackgroundMessage>(message: M): Promise<ResponseFor<M> | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: ResponseFor<M> | undefined) => {
        if (chrome.runtime.lastError) {
          resolve(undefined);
          return;
        }
        resolve(response);
      });
    } catch {
      // Extension context invalidated (e.g. reloaded while the page stayed open).
      resolve(undefined);
    }
  });
}
