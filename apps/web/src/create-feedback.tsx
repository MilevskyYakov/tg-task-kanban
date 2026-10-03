import type { ButtonHTMLAttributes } from 'react';

export function CreateButton({ label, pending, success, ...props }: {
  label: string; pending: boolean; success: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} data-create-state={success ? 'success' : pending ? 'pending' : 'idle'} aria-busy={pending}>
    <span className="create-button-size" aria-hidden="true">{label}</span>
    <span className="create-button-label">
      {success ? <><svg className="create-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" pathLength="1"/></svg>Создано</>
        : pending ? <><span className="create-spinner" aria-hidden="true"/>Создаём…</> : label}
    </span>
  </button>;
}
