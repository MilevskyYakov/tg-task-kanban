import { useEffect, useRef, useState } from 'react';
import { Icon, Sheet } from './app-shell';
import type { Board, Member, Project } from './domain';
import { defaultFilters, statusDisplayName, type TaskFilters, type TaskViewState } from './tasks';
import './task-filters.css';

type Option = { value: string; label: string };
function FilterField({ label, value, options, onChange, onClear, disabled = false }: {
  label: string; value: string; options: Option[]; onChange: (value: string) => void; onClear?: () => void; disabled?: boolean;
}) {
  const selected = options.find(option => option.value === value)?.label ?? 'Выбор недоступен';
  return <div className={`filter-field${onClear ? ' selected' : ''}`}>
    <label><span>{label}</span><strong aria-hidden="true">{selected}</strong><select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><Icon name="chevron"/></label>
    {onClear && <button type="button" className="filter-clear" aria-label={`Сбросить: ${label}`} onClick={onClear}><Icon name="close"/></button>}
  </div>;
}

export function TaskFilterSheet({ filters, onChange, boards, board, projects, members, view, grouping, onGrouping, onBoard, count, loadState, onRetry, onClose }: {
  filters: TaskFilters; onChange: (value: TaskFilters) => void; boards: Board[]; board?: Board; projects: Project[]; members: Member[];
  view: TaskViewState['view']; grouping: TaskViewState['grouping']; onGrouping: (value: TaskViewState['grouping']) => void;
  onBoard: (id: string) => void; count: number; loadState: 'loading' | 'error' | 'ready'; onRetry: () => void; onClose: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const checkScroll = () => { const node = body.current; if (node) setMore(node.scrollHeight - node.clientHeight - node.scrollTop > 4); };
  useEffect(() => {
    const observer = new ResizeObserver(checkScroll);
    if (body.current) { observer.observe(body.current); for (const child of body.current.children) observer.observe(child); }
    checkScroll();
    return () => observer.disconnect();
  }, []);
  useEffect(checkScroll);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const back = window.Telegram?.WebApp?.BackButton;
    const wasVisible = back?.isVisible;
    const handleBack = () => close.current();
    back?.show(); back?.onClick(handleBack);
    return () => { back?.offClick(handleBack); if (!wasVisible) back?.hide(); };
  }, []);
  const change = <K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) => onChange({ ...filters, [key]: value });
  const assignee = filters.unassigned ? 'unassigned' : filters.scope === 'mine' ? 'mine' : filters.assignee;
  const busy = loadState !== 'ready';
  const reset = () => onChange({ ...defaultFilters, scope: board ? 'all' : 'mine' });
  return <Sheet className="task-sheet unified-filter-sheet" title="Фильтры" onClose={onClose} headerActions={<><button className="filter-reset" type="button" onClick={reset}>Сбросить</button><button className="filter-clear" type="button" aria-label="Закрыть фильтры" onClick={onClose}><Icon name="close"/></button></>}>
    <div className="filter-body" ref={body} onScroll={checkScroll}>
      {loadState !== 'ready' && <div className="filter-notice" role={loadState === 'error' ? 'alert' : 'status'}><p>{loadState === 'error' ? 'Не удалось обновить задачи или условия. Выбор сохранён; число задач недоступно.' : 'Загружаем задачи и условия…'}</p>{loadState === 'error' && <button type="button" className="secondary" onClick={onRetry}>Повторить</button>}</div>}
      <section className="filter-section"><h3>Контекст</h3><div className="filter-card">
        <FilterField label="Доска" value={board?.id ?? ''} options={[{ value: '', label: 'Все доски' }, ...boards.map(item => ({ value: item.id, label: item.name }))]} onChange={onBoard}/>
        <FilterField label="Проект" value={filters.project} disabled={!board || busy} options={[{ value: '', label: 'Все проекты' }, ...projects.filter(item => !item.archived_at).map(item => ({ value: item.id, label: item.name }))]} onChange={value => change('project', value)} onClear={filters.project ? () => change('project', '') : undefined}/>
        <FilterField label="Исполнитель" value={assignee} disabled={!board || busy} options={[{ value: '', label: 'Все исполнители' }, { value: 'mine', label: 'Только мои' }, { value: 'unassigned', label: 'Без исполнителя' }, ...members.map(item => ({ value: item.id, label: item.first_name }))]} onChange={value => onChange({ ...filters, scope: value === 'mine' ? 'mine' : 'all', assignee: value === 'mine' || value === 'unassigned' ? '' : value, unassigned: value === 'unassigned' })} onClear={board && assignee ? () => onChange({ ...filters, scope: 'all', assignee: '', unassigned: false }) : undefined}/>
      </div>{!board && <p className="filter-hint">Все доски — ваши задачи. Проект и другой исполнитель доступны внутри конкретной доски.</p>}</section>
      <section className="filter-section"><h3>Условия</h3><div className="filter-card">
        <div className={`filter-field filter-search${filters.search ? ' selected' : ''}`}><label><span>Поиск по задачам</span><input type="search" aria-label="Поиск по задачам" value={filters.search} placeholder="Название или описание" onChange={event => change('search', event.target.value)}/></label>{filters.search && <button type="button" className="filter-clear" aria-label="Очистить поиск" onClick={() => change('search', '')}><Icon name="close"/></button>}</div>
        <div className="filter-pair">
          <FilterField label="Статус" value={view === 'kanban' ? '' : filters.status} disabled={view === 'kanban'} options={[{ value: '', label: view === 'kanban' ? 'Колонки канбана' : 'Без завершённых' }, ...Object.entries(statusDisplayName).map(([value, label]) => ({ value, label }))]} onChange={value => change('status', value as TaskFilters['status'])} onClear={filters.status ? () => change('status', '') : undefined}/>
          <FilterField label="Срок" value={filters.deadline} options={[{ value: '', label: 'Любой' }, { value: 'overdue', label: 'Просрочено' }, { value: 'today', label: 'Сегодня' }, { value: 'week', label: '7 дней' }, { value: 'none', label: 'Без срока' }]} onChange={value => change('deadline', value as TaskFilters['deadline'])} onClear={filters.deadline ? () => change('deadline', '') : undefined}/>
        </div>
        <div className="filter-pair">{(['importance', 'urgency'] as const).map(key => <FilterField key={key} label={key === 'importance' ? 'Важность' : 'Срочность'} value={filters[key] ?? 'any'} options={[{ value: 'any', label: 'Любая' }, { value: 'true', label: key === 'importance' ? 'Важная' : 'Срочная' }, { value: 'false', label: key === 'importance' ? 'Неважная' : 'Несрочная' }, { value: 'unassessed', label: 'Не оценена' }]} onChange={value => onChange({ ...filters, priority: '', [key]: value })} onClear={filters[key] && filters[key] !== 'any' ? () => change(key, 'any') : undefined}/>)}</div>
        <label className={`filter-unassessed${filters.unassessed ? ' selected' : ''}`}><input type="checkbox" aria-label="Не разобрано" checked={Boolean(filters.unassessed)} onChange={event => change('unassessed', event.target.checked)}/><span><strong>Только «Не разобрано»</strong><small>Важность или срочность ещё не оценена</small></span></label>
        {filters.priority === 'normal' && <div className="filter-legacy"><span>Без отметки «Срочная»<small>Сохранённый фильтр: несрочные и неоценённые</small></span><button type="button" className="filter-clear" aria-label="Снять сохранённый приоритет" onClick={() => change('priority', '')}><Icon name="close"/></button></div>}
      </div>{view === 'kanban' && <p className="filter-hint">Статусы задаются колонками канбана.{filters.status && ` Сохранённый фильтр «${statusDisplayName[filters.status]}» здесь не применяется.`}</p>}{loadState === 'ready' && !count && <p className="filter-hint" role="status">Нет подходящих задач. Измените условие или сбросьте фильтры.</p>}</section>
      <section className="filter-section"><h3>Группировка списка</h3><div className="filter-grouping-options" role="group" aria-label="Группировка списка">{([{ value: 'deadline', label: 'По срокам' }, { value: 'project', label: 'По проектам' }, { value: 'priority', label: 'По приоритету' }] as const).map(option => <button key={option.value} type="button" disabled={view !== 'list'} aria-pressed={grouping === option.value} onClick={() => onGrouping(option.value)}>{option.label}</button>)}</div>{view !== 'list' && <p className="filter-hint">Группировка списка сохранена; {view === 'matrix' ? 'в матрице используются категории оценки' : 'в канбане используются колонки статусов'}.</p>}</section>
    </div>
    <footer className="filter-footer"><p>{more ? 'Прокрутите ниже · все разделы открыты' : 'Условия действуют сразу · закрытие их сохранит'}</p><button type="button" className="filter-apply" disabled={busy} onClick={onClose}>{loadState === 'loading' ? 'Загружаем…' : loadState === 'error' ? 'Число задач недоступно' : `Показать ${count} задач`}</button></footer>
  </Sheet>;
}
