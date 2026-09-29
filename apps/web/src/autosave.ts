import { api, json } from './api';

// Shared autosave contract (issue #129): debounce text edits, send single-flight patches
// carrying only changed fields, queue a resend when offline, and persist the pending draft
// to localStorage so a closed/reopened WebView resumes instead of losing the edit.

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export type AutosaveDeps<P extends Record<string, unknown>> = {
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

type Pending<P> = { patch: P; revision: number };

export class Autosave<P extends Record<string, unknown>> {
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight: Promise<boolean> | null = null;
  private queued: Pending<P> | null = null;
  private revision = 0;
  private state: SaveState = 'idle';
  private stopped = false;
  private paused = false;

  constructor(private readonly deps: AutosaveDeps<P>) {}

  private setState(next: SaveState) {
    if (this.stopped || this.state === next) return;
    this.state = next;
    this.deps.onState?.(next);
  }

  private getPending() { return this.queued; }

  // Schedule a debounced save; call for every draft mutation.
  schedule(patch: P, delayMs: number | null = 900) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = { patch, revision: ++this.revision };
    if (!Object.keys(patch).length) {
      this.queued = this.inFlight ? pending : null;
      if (!this.inFlight) {
        writeQueued(this.deps.key, null);
        if (this.state !== 'error') this.setState('saved');
      } else this.setState('pending');
      return;
    }
    this.queued = pending;
    if (!writeQueued(this.deps.key, { patch, at: Date.now() })) this.deps.onOfflineQueued?.(patch);
    if (delayMs !== null && !this.paused) this.timer = setTimeout(() => void this.flush(), delayMs);
    this.setState('pending');
  }

  // Send immediately (chosen values, blur, screen exit). Never drops a newer edit.
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.stopped || this.paused) return;
    if (this.inFlight) {
      const succeeded = await this.inFlight;
      if (succeeded && this.queued) await this.flush();
      return;
    }
    const pending = this.queued;
    if (!pending) return;
    if (!Object.keys(pending.patch).length) {
      this.queued = null;
      if (this.state !== 'error') {
        writeQueued(this.deps.key, null);
        this.setState('saved');
      }
      return;
    }
    this.queued = null;
    this.setState('saving');
    if (!writeQueued(this.deps.key, { patch: pending.patch, at: Date.now() })) this.deps.onOfflineQueued?.(pending.patch);
    let current: Promise<boolean>;
    current = this.send(pending).finally(() => {
      if (this.inFlight === current) this.inFlight = null;
    });
    this.inFlight = current;
    const succeeded = await current;
    if (!succeeded) return;
    const latest = this.getPending();
    if (latest && !Object.keys(latest.patch).length) {
      this.queued = null;
      writeQueued(this.deps.key, null);
      this.setState('saved');
    } else if (!latest && this.revision === pending.revision) {
      writeQueued(this.deps.key, null);
      this.setState('saved');
    } else if (latest) this.setState('pending');
  }

  private async send(pending: Pending<P>): Promise<boolean> {
    try {
      await this.deps.send(pending.patch);
      return true;
    } catch (error) {
      if (!this.queued || this.queued.revision <= pending.revision) {
        this.queued = pending;
        if (!writeQueued(this.deps.key, { patch: pending.patch, at: Date.now() })) this.deps.onOfflineQueued?.(pending.patch);
      }
      this.setState('error');
      this.deps.onError?.(error);
      return false;
    }
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

  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
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
