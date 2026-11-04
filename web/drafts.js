/*
 * Unsent text survives (#130).
 *
 * Drafts: what is typed in each room, thread and ticket comment box is kept in this browser per
 * person and place, restored when you come back and cleared when it is sent. Places are a room ref,
 * `thread:<id>` or `ticket:<REF>`.
 *
 * Outbox: a message whose send did not reach the server waits here with its own idempotency key and
 * is sent again when the connection returns. The server posts a key once, so a send that did arrive
 * the first time is never posted twice.
 */
const DRAFT_PREFIX = 'orco.draft.';
const OUTBOX_KEY = 'orco.outbox.';

// Where storage is blocked (some private windows), drafts and the outbox live in memory for the page.
const memory = new Map();
const memoryStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => void memory.set(k, String(v)),
  removeItem: (k) => void memory.delete(k),
};

function storage() {
  try {
    const local = globalThis.localStorage;
    if (local) {
      local.getItem('orco.probe');
      return local;
    }
  } catch {
    // Blocked: fall through.
  }
  return memoryStorage;
}

export function createDrafts(me) {
  const key = (place) => `${DRAFT_PREFIX}${me()}.${place}`;
  return {
    get(place) {
      try {
        return storage()?.getItem(key(place)) ?? '';
      } catch {
        return '';
      }
    },
    set(place, text) {
      try {
        if (text.trim()) storage()?.setItem(key(place), text.slice(0, 50_000));
        else storage()?.removeItem(key(place));
      } catch {
        // Full or blocked storage: the draft lives only in the box.
      }
    },
    has(place) {
      return Boolean(this.get(place).trim());
    },
  };
}

/** A random key for one send, kept with it until the server answers. */
export function newKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True for failures where the request may never have reached the server: worth sending again. */
export function retryable(err) {
  if (!err) return false;
  if (err.name === 'TypeError') return true; // fetch: offline, DNS, connection reset
  return [0, 408, 425, 429, 502, 503, 504].includes(err.status);
}

/**
 * The outbox: items { key, place, room, body, text, at }. send(item) posts it and resolves with the
 * message; failures that are retryable keep it, others drop it and call onDropped.
 *
 * @param {() => string} me
 * @param {{ send: (item: any) => Promise<any>, onChange?: (list: any[]) => void, onSent?: (item: any, message: any) => void, onDropped?: (item: any, err: any) => void }} handlers
 */
export function createOutbox(me, { send, onChange, onSent, onDropped }) {
  const storeKey = () => `${OUTBOX_KEY}${me()}`;
  const read = () => {
    try {
      const list = JSON.parse(storage()?.getItem(storeKey()) ?? '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    try {
      if (list.length) storage()?.setItem(storeKey(), JSON.stringify(list));
      else storage()?.removeItem(storeKey());
    } catch {
      // Kept in memory for this page.
    }
    onChange?.(list);
  };
  let flushing = null;
  const api = {
    items: read,
    add(item) {
      write([...read().filter((i) => i.key !== item.key), item]);
    },
    cancel(key) {
      write(read().filter((i) => i.key !== key));
    },
    /** Sends everything waiting, oldest first; stops at the first that still cannot get through. */
    flush() {
      if (flushing) return flushing;
      flushing = (async () => {
        for (const item of read()) {
          try {
            const message = await send(item);
            write(read().filter((i) => i.key !== item.key));
            onSent?.(item, message);
          } catch (err) {
            if (retryable(err)) break;
            write(read().filter((i) => i.key !== item.key));
            onDropped?.(item, err);
          }
        }
      })().finally(() => {
        flushing = null;
      });
      return flushing;
    },
  };
  return api;
}
