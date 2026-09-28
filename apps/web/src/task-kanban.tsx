import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { statusDisplayName, type Task, type TaskStatus } from './tasks';

const statuses = Object.keys(statusDisplayName) as TaskStatus[];

export function TaskKanban({ columns, status, onStatusChange, renderTask }: {
  columns: Record<TaskStatus, Task[]>;
  status: TaskStatus;
  onStatusChange: (status: TaskStatus) => void;
  renderTask: (task: Task) => ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  const selected = useRef(status);
  const onChange = useRef(onStatusChange);
  onChange.current = onStatusChange;

  const scrollToStatus = (next: TaskStatus, behavior: ScrollBehavior = 'instant') => {
    const rail = track.current;
    const first = rail?.children[0] as HTMLElement | undefined;
    const column = rail?.children[statuses.indexOf(next)] as HTMLElement | undefined;
    if (rail && first && column) rail.scrollTo({ left: column.offsetLeft - first.offsetLeft, behavior });
  };

  useLayoutEffect(() => {
    const rail = track.current!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const syncSelection = () => {
      const columns = [...rail.children] as HTMLElement[];
      const start = columns[0].offsetLeft;
      const nearest = columns.reduce((best, column, index) =>
        Math.abs(column.offsetLeft - start - rail.scrollLeft) < Math.abs(columns[best].offsetLeft - start - rail.scrollLeft) ? index : best, 0);
      selected.current = statuses[nearest];
      onChange.current(selected.current);
    };
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(syncSelection, 120);
    };
    // Restore the column without scrolling the document or the task list vertically.
    scrollToStatus(selected.current);
    const resize = new ResizeObserver(() => scrollToStatus(selected.current));
    resize.observe(rail);
    rail.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      resize.disconnect();
      rail.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const choose = (next: TaskStatus) => {
    selected.current = next;
    onStatusChange(next);
    scrollToStatus(next, matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth');
  };

  return <div className="mobile-kanban">
    <div className="status-tabs" role="group" aria-label="Статусы задач">{statuses.map((value) => <button key={value} aria-pressed={status === value} aria-controls={`kanban-${value}`} className={status === value ? 'active' : ''} onClick={() => choose(value)}>{statusDisplayName[value]} <small>{columns[value].length}</small></button>)}</div>
    <div className="kanban-track" ref={track} role="region" aria-label="Колонки канбана" tabIndex={0} onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      const index = statuses.indexOf(selected.current);
      const next = event.key === 'ArrowRight' ? Math.min(index + 1, statuses.length - 1) : event.key === 'ArrowLeft' ? Math.max(index - 1, 0) : event.key === 'Home' ? 0 : event.key === 'End' ? statuses.length - 1 : undefined;
      if (next === undefined) return;
      event.preventDefault(); choose(statuses[next]);
    }}>
      {statuses.map((value) => <section className="active-kanban-column" id={`kanban-${value}`} key={value} aria-label={statusDisplayName[value]}>
        <header className="kanban-column-header"><h2>{statusDisplayName[value]}</h2><span>{columns[value].length}</span></header>
        <div className="kanban-tasks">{columns[value].map(renderTask)}</div>
        {!columns[value].length && <p className="task-state">Задач в этом статусе нет.</p>}
      </section>)}
    </div>
  </div>;
}
