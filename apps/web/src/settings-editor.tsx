import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, json } from './api';
import { Autosave, reconnectRetry, type SaveState } from './autosave';
import type { Board, Project, Schedule } from './domain';
import { statusDisplayName, type TaskStatus } from './tasks';

type Draft = Record<string, string | boolean | string[]>;
type Target = { userId: string; boardId: string; projectId?: string; kind?: Schedule['kind'] };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const labels: Record<string, string> = { name: 'Название', enabled: 'Включена', weekdays: 'Дни', local_time: 'Время', timezone: 'Часовой пояс', included_statuses: 'Статусы' };
const saveLabels: Record<SaveState, string> = { idle: '', pending: 'Ожидает отправки', saving: 'Сохраняется…', saved: 'Сохранено', error: 'Не сохранено' };
const toDraft = (value: Board | Project | Schedule): Draft => 'kind' in value
  ? { enabled: value.enabled, weekdays: value.weekdays.join(','), local_time: value.local_time, timezone: value.timezone, included_statuses: value.included_statuses }
  : { name: value.name };
const wire = (draft: Draft) => Object.fromEntries(Object.entries(draft).map(([key, value]) => [key,
  key === 'weekdays' ? String(value).split(',').map(Number) : key === 'name' ? String(value).trim() : value]));
const equalField = (a: Draft, b: Draft, key: string) => same(wire(a)[key], wire(b)[key]);
const merge = (base: Draft, local: Draft, server: Draft) => {
  const draft = { ...server };
  const conflicts: string[] = [];
  for (const key of Object.keys(base)) {
    // Preserve raw input (including a trailing space) while its canonical value
    // is already acknowledged; a background save must not move the caret.
    if (equalField(local, server, key)) { draft[key] = local[key]; continue; }
    if (equalField(local, base, key)) continue;
    draft[key] = local[key];
    if (!equalField(server, base, key)) conflicts.push(key);
  }
  return { draft, conflicts };
};
const errorsFor = (draft: Draft): Record<string, string> => {
  const errors: Record<string, string> = {};
  if ('name' in draft) {
    if (!String(draft.name).trim() || String(draft.name).trim().length > 120) errors.name = 'Название должно содержать 1–120 символов.';
  } else {
    if (!/^[1-7](,[1-7])*$/.test(String(draft.weekdays))) errors.weekdays = 'Укажите дни от 1 до 7 через запятую.';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(draft.local_time))) errors.local_time = 'Укажите корректное время.';
    try { if (!draft.timezone) throw new Error(); new Intl.DateTimeFormat('ru', { timeZone: String(draft.timezone) }); }
    catch { errors.timezone = 'Укажите корректный часовой пояс.'; }
    if (!(draft.included_statuses as string[]).length) errors.included_statuses = 'Выберите хотя бы один статус.';
  }
  return errors;
};

// Only the existing name/publication editors use this adapter. Autosave owns the
// single-flight queue; this layer retains the raw draft and its three-way baseline.
class SettingsEdit {
  readonly autosave: Autosave<Record<string, unknown>>;
  readonly storageKey: string;
  readonly listeners = new Set<() => void>();
  base: Draft;
  draft: Draft;
  state: SaveState = 'idle';
  error = '';
  warning = false;
  conflict?: { server: Draft; fields: string[] };
  private inFlight = false;
  private stopped = false;
  private blocked = 0;
  private needsRead = true;
  private started = false;
  private attempt?: { draft: Draft; fields: string[] };
  private readonly path: string;
  constructor(readonly target: Target, initial: Board | Project | Schedule, private confirmed: (value: Board | Project | Schedule) => void) {
    const { userId, boardId, projectId, kind } = target;
    const key = JSON.stringify([userId, boardId, projectId ? 'project' : kind ? 'publication' : 'board', projectId ?? kind ?? boardId]);
    this.storageKey = `tasks.settings.v1.${key}`;
    this.path = `/api/boards/${boardId}${projectId ? `/projects/${projectId}` : kind ? `/publications/${kind}` : ''}`;
    this.base = this.draft = toDraft(initial);
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const stored = JSON.parse(raw);
        const valid = (value: unknown): value is Draft => Boolean(value && typeof value === 'object'
          && Object.keys(this.base).every((key) => Array.isArray(this.base[key])
            ? Array.isArray((value as Draft)[key]) && ((value as Draft)[key] as unknown[]).every((item) => typeof item === 'string' && Object.hasOwn(statusDisplayName, item))
            : typeof (value as Draft)[key] === typeof this.base[key])
          && Object.keys(value).length === Object.keys(this.base).length);
        if (stored.version !== 1 || !valid(stored.base) || !valid(stored.draft)) throw new Error('Invalid settings draft');
        if (stored.attempt !== undefined) {
          if (!valid(stored.attempt?.draft) || !Array.isArray(stored.attempt.fields) || !stored.attempt.fields.length
            || !stored.attempt.fields.every((key: unknown) => typeof key === 'string' && Object.hasOwn(this.base, key))) throw new Error('Invalid settings attempt');
          this.attempt = stored.attempt;
        }
        this.base = stored.base; this.draft = stored.draft; this.state = 'pending';
      }
    } catch { this.warning = true; }
    this.autosave = new Autosave({ key: `settings:${key}`, send: () => this.send(),
      onState: (state) => { this.state = state; this.notify(); },
      onError: (error) => {
        this.error = error instanceof Error ? error.message : 'Ошибка сохранения';
        if (error instanceof ApiError && [401,403,404].includes(error.status)) { this.blocked = error.status; this.autosave.setPaused(true); }
        this.notify();
      }
    });
  }
  notify() { for (const listener of this.listeners) listener(); }
  get errors() { return errorsFor(this.draft); }
  get displayedState(): SaveState { return Object.keys(this.errors).length || this.error ? 'error' : this.conflict ? 'pending' : this.state; }
  private patch() {
    const invalid = this.errors;
    return Object.fromEntries(Object.entries(wire(this.draft)).filter(([key]) => !invalid[key] && !equalField(this.draft, this.base, key)));
  }
  private persist() {
    try {
      if (!this.inFlight && !this.attempt && !this.conflict && Object.keys(this.base).every((key) => equalField(this.draft, this.base, key)) && !Object.keys(this.errors).length) localStorage.removeItem(this.storageKey);
      else localStorage.setItem(this.storageKey, JSON.stringify({ version: 1, base: this.base, draft: this.draft, attempt: this.attempt }));
      this.warning = false;
    } catch { this.warning = true; }
  }
  private queue(delay: number | null) {
    this.persist();
    this.autosave.setPaused(Boolean(this.blocked || this.conflict));
    const patch = this.patch();
    this.autosave.schedule(this.attempt && !Object.keys(patch).length ? { refresh: true } : patch, delay);
    this.notify();
  }
  private async read() {
    const { boardId, projectId, kind } = this.target;
    const board = (await api<{boards: Board[]}>('/api/boards')).boards.find((value) => value.id === boardId);
    if (!board) throw new ApiError('board not found', 404);
    if (board.status === 'frozen' || board.status === 'archived') throw new ApiError('board is read-only', 403);
    if (projectId) {
      const project = (await api<{projects: Project[]}>(`/api/boards/${boardId}/projects?archived=true`)).projects.find((value) => value.id === projectId);
      if (!project || project.archived_at) throw new ApiError('project not found', 404);
      return project;
    }
    if (kind) {
      if (board.status !== 'active') throw new ApiError('board is read-only', 403);
      const schedule = (await api<{schedules: Schedule[]}>(`/api/boards/${boardId}/publications`)).schedules.find((value) => value.kind === kind);
      if (!schedule) throw new ApiError('publication not found', 404);
      return schedule;
    }
    return board;
  }
  private acknowledged(value: Board | Project | Schedule) {
    return Boolean(this.attempt && this.attempt.fields.every((key) => equalField(toDraft(value), this.attempt!.draft, key)));
  }
  private accept(value: Board | Project | Schedule, previous = this.base) {
    const server = toDraft(value);
    if (this.acknowledged(value)) previous = this.attempt!.draft;
    this.attempt = undefined;
    const merged = merge(previous, this.draft, server);
    this.draft = merged.draft;
    if (merged.conflicts.length) {
      this.conflict = { server, fields: merged.conflicts };
      this.autosave.setPaused(true);
    } else { this.base = server; this.conflict = undefined; }
    this.confirmed(value);
    this.persist();
    this.notify();
  }
  private async send() {
    if (this.stopped || this.blocked || this.conflict) return;
    this.inFlight = true;
    try {
      if (this.needsRead) {
        const current = await this.read();
        if (this.stopped) return;
        this.needsRead = false;
        this.accept(current);
        if (this.conflict) return;
      }
      const patch = this.patch();
      if (!Object.keys(patch).length) { this.queue(null); return; }
      const expected = Object.fromEntries(Object.keys(patch).map((key) => [key, wire(this.base)[key]]));
      const sent = { ...this.base };
      for (const key of Object.keys(patch)) sent[key] = this.draft[key];
      this.attempt = { draft: sent, fields: Object.keys(patch) };
      this.persist();
      const saved = await api<Board | Project | Schedule>(this.path, json(this.target.kind ? 'PUT' : 'PATCH', { ...patch, expected }));
      if (this.stopped) return;
      this.accept(saved, sent);
      this.error = '';
      this.queue(0);
    } catch (error) {
      if (this.stopped) return;
      this.needsRead = true;
      if (error instanceof ApiError && error.status === 409 && error.data.error === 'settings conflict') {
        const current = await this.read();
        if (this.stopped) return;
        this.accept(current);
        this.error = '';
        this.queue(0);
        return;
      }
      if (!(error instanceof ApiError) || error.status >= 500) {
        try {
          const current = await this.read();
          if (this.stopped) return;
          const acknowledged = this.acknowledged(current);
          this.accept(current);
          if (acknowledged && !this.conflict) { this.error = ''; this.queue(0); return; }
          if (!Object.keys(this.patch()).length && !this.conflict) { this.error = ''; this.queue(null); return; }
        } catch (readError) {
          if (readError instanceof ApiError && [401,403,404].includes(readError.status)) this.blocked = readError.status;
        }
      } else this.blocked = error.status;
      this.error = error instanceof Error ? error.message : 'Ошибка сохранения';
      this.queue(null);
      throw error;
    } finally {
      this.inFlight = false;
      if (!this.stopped) { this.persist(); this.notify(); }
    }
  }
  start() {
    if (this.started) {
      if (!this.blocked && !this.conflict) { this.needsRead = true; this.autosave.schedule({ refresh: true }, 0); }
      return;
    }
    this.started = true;
    if (this.state === 'pending') this.queue(700);
  }
  set(key: string, value: Draft[string], immediate = false) {
    if (this.stopped) return;
    this.draft = { ...this.draft, [key]: value };
    if (![401,403,404].includes(this.blocked)) { this.blocked = 0; this.error = ''; }
    this.queue(immediate ? 0 : 700);
  }
  retry(manual = false) {
    if (this.stopped || this.conflict || (this.blocked && !manual)) return;
    if (manual) { this.blocked = 0; this.error = ''; }
    this.needsRead = true;
    this.queue(0);
    void this.autosave.flush();
  }
  resolve(local: boolean) {
    if (!this.conflict) return;
    if (!local) for (const key of this.conflict.fields) this.draft[key] = this.conflict.server[key];
    this.base = this.conflict.server;
    this.conflict = undefined; this.error = ''; this.blocked = 0;
    this.needsRead = true;
    this.queue(0);
    // Choosing the server also rereads it: the displayed conflict may be stale.
    if (!Object.keys(this.patch()).length) this.autosave.schedule({ refresh: true }, 0);
  }
  stop() { this.stopped = true; this.autosave.stop(); }
}

export function useSettingsEdits(userId: string) {
  const [edits] = useState(() => new Map<string, SettingsEdit>());
  const disposal = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(disposal.current);
    for (const [key, edit] of edits) if (edit.target.userId !== userId) { edit.stop(); edits.delete(key); }
    const removeRetry = reconnectRetry(() => { for (const edit of edits.values()) edit.retry(); });
    // Defer final disposal so React StrictMode's setup/cleanup probe keeps live queues.
    return () => {
      removeRetry();
      disposal.current = setTimeout(() => { for (const edit of edits.values()) edit.stop(); }, 0);
    };
  }, [edits, userId]);
  return edits;
}
type EditorProps = { edits: Map<string, SettingsEdit>; userId: string; board: Board; project?: Project; schedule?: Schedule; onConfirmed: (value: Board | Project | Schedule) => void };
function useEditor({ edits, userId, board, project, schedule, onConfirmed }: EditorProps) {
  const key = JSON.stringify([userId, board.id, project?.id ?? schedule?.kind ?? 'board']);
  let edit = edits.get(key);
  if (!edit) { edit = new SettingsEdit({ userId, boardId: board.id, projectId: project?.id, kind: schedule?.kind }, project ?? schedule ?? board, onConfirmed); edits.set(key, edit); }
  const current = edit;
  const [, refresh] = useState(0);
  useEffect(() => {
    const listener = () => refresh((value) => value + 1);
    current.listeners.add(listener); current.start();
    return () => { current.listeners.delete(listener); };
  }, [current]);
  return current;
}
function Feedback({ edit }: {edit: SettingsEdit}) {
  const value = (item: Draft[string]) => typeof item === 'boolean' ? item ? 'Да' : 'Нет' : Array.isArray(item) ? item.map((status) => statusDisplayName[status as TaskStatus] ?? status).join(', ') : item || 'Пусто';
  return <div className="settings-feedback">
    {edit.displayedState !== 'idle' && <p className="detail-save-state" role="status" data-state={edit.displayedState}>{saveLabels[edit.displayedState]}</p>}
    {edit.warning && <p role="alert">Локальная копия недоступна или повреждена: несохранённые правки могут потеряться при закрытии приложения.</p>}
    {Object.entries(edit.errors).map(([key, error]) => <p role="alert" key={key}>{error}</p>)}
    {edit.error && <p role="alert">{edit.error}</p>}
    {edit.conflict ? <section aria-label="Конфликт настроек"><p>Настройки изменил кто-то другой. Выберите версию.</p>
      <dl className="detail-conflict-values">{edit.conflict.fields.map((key) => <div key={key}><dt>{labels[key]}</dt><dd>Ваше: {value(edit.draft[key])}</dd><dd>На сервере: {value(edit.conflict!.server[key])}</dd></div>)}</dl>
      <button type="button" className="secondary" onClick={() => edit.resolve(true)}>Оставить моё</button>
      <button type="button" className="secondary" onClick={() => edit.resolve(false)}>Принять серверное</button>
    </section> : edit.error && <button type="button" className="secondary" onClick={() => edit.retry(true)}>Повторить</button>}
  </div>;
}
export function NameSetting(props: EditorProps & { children?: ReactNode }) {
  const edit = useEditor(props);
  const readOnly = ['frozen', 'archived'].includes(props.board.status) || Boolean(props.project?.archived_at);
  return <div className="settings-name-editor"><div className="settings-form inline-form"><label>{props.project ? 'Название проекта' : 'Название'}
    <input name="name" aria-label={props.project ? `Название проекта ${props.project.name}` : 'Название'} maxLength={120} required disabled={readOnly}
      value={readOnly ? (props.project ?? props.board).name : String(edit.draft.name)} aria-invalid={Boolean(edit.errors.name)}
      onChange={(event) => edit.set('name', event.target.value)} onBlur={() => void edit.autosave.flush()}/></label>{props.children}</div>
    {!readOnly && <Feedback edit={edit}/>}</div>;
}
export function PublicationSetting(props: EditorProps & {schedule: Schedule; onPreview: (schedule: Schedule) => void}) {
  const edit = useEditor(props);
  const draft = edit.draft;
  return <fieldset><legend>{props.schedule.kind === 'daily' ? 'План дня' : 'Недельная сводка'}</legend>
    <label><input type="checkbox" checked={Boolean(draft.enabled)} onChange={(event) => edit.set('enabled', event.target.checked, true)}/> Включена</label>
    <Feedback edit={edit}/>
    <label>Дни (1–7)<input value={String(draft.weekdays)} aria-invalid={Boolean(edit.errors.weekdays)} onChange={(event) => edit.set('weekdays', event.target.value)}/></label>
    <label>Время<input type="time" value={String(draft.local_time)} aria-invalid={Boolean(edit.errors.local_time)} onChange={(event) => edit.set('local_time', event.target.value, true)}/></label>
    <label>Часовой пояс<input value={String(draft.timezone)} aria-invalid={Boolean(edit.errors.timezone)} onChange={(event) => edit.set('timezone', event.target.value)}/></label>
    <div className="status-options">{Object.entries(statusDisplayName).map(([status, name]) => <label key={status}><input type="checkbox" checked={(draft.included_statuses as string[]).includes(status)} onChange={(event) => edit.set('included_statuses', event.target.checked ? [...draft.included_statuses as string[], status] : (draft.included_statuses as string[]).filter((value) => value !== status), true)}/> {name}</label>)}</div>
    <div className="actions"><button className="secondary" disabled={Boolean(Object.keys(edit.errors).length)} onClick={() => props.onPreview({ kind: props.schedule.kind, ...wire(draft) } as Schedule)}>Предпросмотр</button></div>
  </fieldset>;
}
