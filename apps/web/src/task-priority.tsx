import { useState, type ReactNode } from 'react';
import { ActionRow, ChoiceRow, Sheet } from './app-shell';
import { assessmentText, emptyAssessment, groupTasksByPriority, type Assessment, type Task, type TaskFilters } from './tasks';


export function PrioritySheet({ value, onApply, onClose }: { value: Partial<Assessment>; onApply: (value: Assessment) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Assessment>({ importance: value.importance ?? null, urgency: value.urgency ?? null });
  return <Sheet className="task-sheet priority-sheet" title="Приоритет" onClose={onClose}>
    <p>Важность и срочность независимы. Срок не меняет оценку.</p>
    {(['importance', 'urgency'] as const).map(key => <fieldset key={key}>
      <legend>{key === 'importance' ? 'Важная?' : 'Срочная?'}</legend>
      <div className="choice-list" role="radiogroup" aria-label={key === 'importance' ? 'Важная?' : 'Срочная?'}>
        {([true, false, null] as const).map(value => <ChoiceRow key={String(value)} label={value === null ? 'Не оценено' : value ? 'Да' : 'Нет'} selected={draft[key] === value} onClick={() => setDraft(current => ({ ...current, [key]: value }))}/>)}
      </div>
    </fieldset>)}
    <button type="button" className="secondary" onClick={() => setDraft(emptyAssessment)}>Сбросить оценку</button>
    <button type="button" onClick={() => { onApply(draft); onClose(); }}>Применить</button>
    <button type="button" className="secondary" onClick={onClose}>Отмена</button>
  </Sheet>;
}

export function PriorityField({ value, onChange }: { value: Partial<Assessment>; onChange: (value: Assessment) => void }) {
  const [open, setOpen] = useState(false);
  return <><ActionRow label="Приоритет" value={assessmentText(value)} onClick={() => setOpen(true)}/>{open && <PrioritySheet value={value} onApply={onChange} onClose={() => setOpen(false)}/>}</>;
}

export function AssessmentFilters({ value, onChange }: { value: TaskFilters; onChange: (value: TaskFilters) => void }) {
  return <div className="assessment-filters">
    {(['importance', 'urgency'] as const).map(key => <label key={key}>{key === 'importance' ? 'Важность' : 'Срочность'}<select aria-label={key === 'importance' ? 'Важность' : 'Срочность'} value={value[key] ?? 'any'} onChange={event => onChange({ ...value, priority: '', [key]: event.target.value })}>
      <option value="any">Любая</option><option value="true">Да</option><option value="false">Нет</option><option value="unassessed">Не оценено</option>
    </select></label>)}
    <label className="checkbox"><input type="checkbox" checked={Boolean(value.unassessed)} onChange={event => onChange({ ...value, unassessed: event.target.checked })}/>Не разобрано</label>
    {value.priority === 'normal' && <button className="secondary" onClick={() => onChange({ ...value, priority: '' })}>Без отметки «Срочная» · Снять</button>}
  </div>;
}

export function PriorityTasks({ tasks, matrix = false, renderTask, selected, onSelect }: { tasks: Task[]; matrix?: boolean; renderTask: (task: Task) => ReactNode; selected?: number; onSelect: (group?: number) => void }) {
  const groups = groupTasksByPriority(tasks.filter(task => !task.archived_at));
  return <div className="priority-tasks">
    <details className="unassessed-tasks"><summary>Не разобрано · {groups[0].tasks.length}</summary>{groups[0].tasks.map(renderTask)}{!groups[0].tasks.length && <p>Все задачи оценены</p>}</details>
    <div className={matrix ? 'priority-matrix' : 'priority-list'} aria-label={matrix ? 'Матрица важности и срочности' : 'По приоритету'}>
      {matrix && <><span className="matrix-column important">Важное</span><span className="matrix-column unimportant">Неважное</span><span className="matrix-row urgent">Срочное</span><span className="matrix-row not-urgent">Несрочное</span></>}
      {groups.slice(1).map((group, index) => <section className={`priority-quadrant quadrant-${index + 1}`} aria-label={group.label} key={group.label}>
        <h2>{group.label} · {group.tasks.length}</h2>
        {(matrix ? group.tasks.slice(0, 3) : group.tasks).map(renderTask)}
        {!group.tasks.length && <p className="matrix-empty">Нет задач</p>}
        {matrix && group.tasks.length > 3 && <button className="secondary matrix-more" onClick={() => onSelect(index + 1)}>Ещё {group.tasks.length - 3}</button>}
      </section>)}
    </div>
    {selected !== undefined && <Sheet className="task-sheet priority-more" title={groups[selected].label} onClose={() => onSelect()}>{groups[selected].tasks.map(renderTask)}{!groups[selected].tasks.length && <p>Нет задач</p>}<button className="secondary" onClick={() => onSelect()}>Закрыть</button></Sheet>}
  </div>;
}
