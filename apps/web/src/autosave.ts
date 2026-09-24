import { api, json } from './api';

// Shared autosave contract (issue #129): debounce text edits, send single-flight patches
// carrying only changed fields, queue a resend when offline, and persist the pending draft
// to localStorage so a closed/reopened WebView resumes instead of losing the edit.

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export type AutosaveDeps<P> = {
  key: string;
  send: (patch: P) => Promise<void>;
  onState?: (state: SaveState) => void;
  onOfflineQueued?: (patch: P) => void;
  onError?: (error: unknown) => void;
};

const storageKey = (key: string) => `tasks.autosave.${key}`;

type QueuedDraft<P> = { patch: P; at: number };

const readQueued = <P,>(key: string): QueuedDraft<P> | null => {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const value = JSON.parse(raw) as QueuedDraft<P>;
    return value && typeof value === 'object' && value.patch && typeof value.patch === 'object' ? value : null;
  } catch { return null; }
};

const writeQueued = <P,>(key: string, value: QueuedDraft<P> | null): boolean => {
  try {
    if (value) localStorage.setItem(storageKey(key), JSON.stringify(value));
    else localStorage.removeItem(storageKey(key));
    return true;
  } catch { return false; }
};

export class Autosave<P> {
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight: Promise<void> | null = null;
  private queued: P | null = null;
  private state: SaveState = 'idle';
  private stopped = false;

  constructor(private readonly deps: AutosaveDeps<P>) {}

  private setState(next: SaveState) {
    if (this.stopped || this.state === next) return;
    this.state = next;
    this.deps.onState?.(next);
  }

  // Schedule a debounced save; call for every draft mutation.
  schedule(patch: P, delayMs = 900) {
    if (this.stopped) return;
    this.queued = patch;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delayMs);
    this.setState('pending');
  }

  // Send immediately (chosen values, blur, screen exit). Never drops a newer edit.
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.queued || this.stopped) return;
    const patch = this.queued;
    this.queued = null;
    this.setState('saving');
    const stored = writeQueued(this.deps.key, { patch, at: Date.now() });
    if (!stored) this.deps.onOfflineQueued?.(patch); // storage unavailable: caller must warn
    await this.send(patch);
  }

  private async send(patch: P): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    let current: Promise<void> | null = null;
    current = this.inFlight = (async () => {
      try {
        await this.deps.send(patch);
        // A late success for an older request must not mark a newer edit saved: only
        // report 'saved' when nothing newer has been scheduled meanwhile (issue #129).
        if (!this.queued) this.setState('saved');
        writeQueued(this.deps.key, null);
      } catch (error) {
        // Hold the patch for the next flush; no infinite retry on validation/auth —
        // the next attempt happens only on user action or reconnect (issue #129).
        this.queued = patch;
        writeQueued(this.deps.key, { patch, at: Date.now() });
        this.setState('error');
        this.deps.onError?.(error);
      } finally {
        if (this.inFlight === current) this.inFlight = null;
      }
    })();
    return current;
  }

  // Resume a draft persisted by a previous session (offline close / lost response).
  takeQueued(): P | null {
    const queued = readQueued<P>(this.deps.key);
    if (!queued) return null;
    writeQueued(this.deps.key, null);
    return queued.patch;
  }

  clearStorage() {
    writeQueued(this.deps.key, null);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

// Online event is a hint, not proof; resending verifies with the actual request (issue #129).
export function reconnectRetry(retry: () => void): () => void {
  const handler = () => retry();
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}

export const patchRequest = (path: string) => (body: unknown) => api(path, json('PATCH', body));
