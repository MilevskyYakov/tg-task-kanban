import { useState } from 'react';
import { ActionRow, ChoiceRow, Icon, Sheet } from './app-shell';
import { deadlineModeName, deadlinePatch, formatTaskDeadline, type DeadlineDraft } from './tasks';

export function DeadlineField({ value, onChange, disabled = false }: { value: DeadlineDraft; onChange: (value: DeadlineDraft) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<DeadlineDraft>();
  const [error, setError] = useState('');
  const label = value.mode === 'none' ? 'Без срока' : formatTaskDeadline({
    deadline_date: value.mode === 'date' ? value.date : undefined,
    deadline: value.mode === 'datetime' ? deadlinePatch(value).deadline ?? undefined : undefined
  });
  return <>
    <ActionRow label="Срок" value={label} icon={<Icon name="calendar"/>} disabled={disabled} onClick={() => { setDraft(value); setError(''); }}/>
    {draft && <Sheet className="task-sheet deadline-sheet" title="Срок задачи" onClose={() => setDraft(undefined)}>
      <div className="choice-list" role="radiogroup" aria-label="Режим срока">{(Object.keys(deadlineModeName) as DeadlineDraft['mode'][]).map((mode) => <ChoiceRow key={mode} label={deadlineModeName[mode]} selected={draft.mode === mode} onClick={() => { setDraft({ ...draft, mode }); setError(''); }}/>)}</div>
      {draft.mode !== 'none' && <div className="deadline-inputs">
        <label>Дата<input aria-label="Дата срока" type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })}/></label>
        {draft.mode === 'datetime' && <label>Время<input aria-label="Время срока" type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })}/></label>}
        <p>{draft.mode === 'date' ? 'Можно выполнить в течение всего дня. Просрочка — после окончания дня.' : 'Точное время в часовом поясе устройства.'}</p>
        <small>Часовой пояс: {draft.mode === 'date' ? draft.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
      </div>}
      {error && <p role="alert" className="detail-error">{error}</p>}
      <button type="button" className="filter-apply" onClick={() => {
        try { deadlinePatch(draft); onChange(draft); setDraft(undefined); }
        catch (caught) { setError(caught instanceof Error ? caught.message : 'Проверьте срок'); }
      }}>Применить</button>
      <button type="button" className="sheet-close secondary" onClick={() => setDraft(undefined)}>Отмена</button>
    </Sheet>}
  </>;
}
