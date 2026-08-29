// Durable hand-off for recorded clips.
//
// On mobile, backgrounding the browser suspends the page: an upload that is
// in flight when the user switches apps is simply cancelled, and on iOS the
// page may be discarded outright without ever running another line of our JS.
// Uploading straight from memory therefore loses the clip with no trace.
//
// So every finished clip is written to IndexedDB FIRST, uploaded second, and
// deleted only once the PUT succeeds. Anything still in the store on the next
// page load was interrupted, and gets retried. The cost is one extra write per
// clip; the benefit is that footage survives an app switch, a tab discard, or
// a dead network.
//
// The store is capped (see capEntries) because a phone that stays offline
// would otherwise accumulate video until the origin's quota is exhausted,
// which breaks *everything* the site stores, not just this.

const DB_NAME = "visionlab-uploads";
const DB_VERSION = 1;
const STORE = "pending";

export const MAX_PENDING_CLIPS = 12;
export const MAX_PENDING_BYTES = 200 * 1024 * 1024; // 200MB

export interface PendingEntry {
  id: number;
  blob: Blob;
  label: string;
  contentType: string;
  createdAt: number;
}

/** Oldest-first eviction to keep the queue under both caps. Pure so the policy
 * can be tested without IndexedDB. Returns the ids to drop. */
export function capEntries(
  entries: { id: number; size: number; createdAt: number }[],
  maxCount = MAX_PENDING_CLIPS,
  maxBytes = MAX_PENDING_BYTES
): number[] {
  const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const drop: number[] = [];
  let count = sorted.length;
  let bytes = sorted.reduce((sum, e) => sum + e.size, 0);

  for (const entry of sorted) {
    if (count <= maxCount && bytes <= maxBytes) break;
    drop.push(entry.id);
    count--;
    bytes -= entry.size;
  }
  return drop;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    // Private browsing and storage-denied contexts reject here. Losing the
    // safety net is acceptable; failing the recording is not.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function promisify<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

/** Persists a clip and returns its id (null if storage is unavailable). */
export async function stashPending(
  blob: Blob,
  label: string,
  contentType: string
): Promise<number | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const id = await promisify(
      tx.objectStore(STORE).add({ blob, label, contentType, createdAt: Date.now() })
    );
    await evict(db);
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function removePending(id: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await promisify(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
  } catch {
    /* best effort */
  } finally {
    db.close();
  }
}

async function evict(db: IDBDatabase): Promise<void> {
  try {
    const all = (await promisify(db.transaction(STORE, "readonly").objectStore(STORE).getAll())) as
      | PendingEntry[]
      | null;
    if (!all?.length) return;
    const drop = capEntries(
      all.map((e) => ({ id: e.id, size: e.blob?.size ?? 0, createdAt: e.createdAt }))
    );
    if (!drop.length) return;
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    for (const id of drop) store.delete(id);
  } catch {
    /* best effort */
  }
}

/**
 * Retries every clip left over from an interrupted session.
 *
 * Serial on purpose: these are multi-megabyte videos and the user is usually
 * mid-scan, so saturating a phone's uplink would starve the thing they're
 * actually looking at. A clip that fails again is left in the store for the
 * next attempt.
 */
export async function drainPending(
  upload: (blob: Blob, label: string, contentType: string) => Promise<void>
): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  let entries: PendingEntry[] = [];
  try {
    entries = ((await promisify(
      db.transaction(STORE, "readonly").objectStore(STORE).getAll()
    )) as PendingEntry[] | null) ?? [];
  } catch {
    entries = [];
  } finally {
    db.close();
  }

  let uploaded = 0;
  for (const entry of entries) {
    if (!entry?.blob) {
      await removePending(entry.id);
      continue;
    }
    try {
      await upload(entry.blob, entry.label, entry.contentType);
      await removePending(entry.id);
      uploaded++;
    } catch {
      // Leave it queued — the next drain (page load or app return) retries.
      break;
    }
  }
  return uploaded;
}
